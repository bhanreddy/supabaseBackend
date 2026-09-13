import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { EventCertificateService } from './eventCertificateService.js';

export const EventCompetitionService = {
  /**
   * Create a new competition under an event
   */
  async createCompetition({ schoolId, eventId, data, userId }) {
    const {
      title,
      category = 'GENERAL',
      competition_type = 'INDIVIDUAL',
      structure = 'SINGLE_ROUND',
      rules = null,
      criteria = [
        { name: 'Execution', max_score: 10 },
        { name: 'Technique', max_score: 10 },
      ],
      house_points_map = { '1st': 10, '2nd': 7, '3rd': 5, 'participation': 1 },
      rounds = ['Finals'],
    } = data;

    if (!title) {
      const err = new Error('title is required');
      err.statusCode = 400;
      throw err;
    }

    const roundNames = (rounds || ['Finals']).map((r) => (typeof r === 'string' ? r : r.round_name || r.name || 'Round'));

    return await sql.begin(async (tx) => {
      const [comp] = await tx`
        INSERT INTO event_competitions (
          school_id, event_id, title, category, competition_type,
          structure, rules, criteria, house_points_map
        ) VALUES (
          ${schoolId}, ${eventId}, ${title}, ${category}, ${competition_type},
          ${structure}, ${rules}, ${sql.json(criteria)}, ${sql.json(house_points_map)}
        )
        RETURNING *
      `;

      // Create rounds
      for (let i = 0; i < roundNames.length; i++) {
        await tx`
          INSERT INTO event_competition_rounds (
            school_id, competition_id, round_name, sequence
          ) VALUES (
            ${schoolId}, ${comp.id}, ${roundNames[i]}, ${i + 1}
          )
        `;
      }

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: 'COMPETITION_CREATED',
        entityType: 'EVENT_COMPETITION',
        entityId: comp.id,
        details: `Created competition: ${title}`,
      }, tx);

      return comp;
    });
  },

  /**
   * List all competitions for an event
   */
  async listCompetitions({ schoolId, eventId }) {
    const comps = await sql`
      SELECT 
        c.*,
        u_p.display_name as finalized_by_name,
        count(r.id)::int as round_count,
        count(res.id)::int as results_count
      FROM event_competitions c
      LEFT JOIN users u ON c.finalized_by = u.id
      LEFT JOIN persons u_p ON u.person_id = u_p.id
      LEFT JOIN event_competition_rounds r ON r.competition_id = c.id
      LEFT JOIN event_competition_results res ON res.competition_id = c.id
      WHERE c.event_id = ${eventId} AND c.school_id = ${schoolId}
      GROUP BY c.id, u_p.display_name
      ORDER BY c.created_at ASC
    `;

    for (const comp of comps) {
      comp.rounds = await sql`
        SELECT * FROM event_competition_rounds
        WHERE competition_id = ${comp.id}
        ORDER BY sequence ASC
      `;
      comp.results = await sql`
        SELECT * FROM event_competition_results
        WHERE competition_id = ${comp.id}
        ORDER BY rank_position ASC
      `;
    }

    return comps;
  },

  /**
   * Record judge's scorecard for a participant
   */
  async recordScore({
    schoolId,
    competitionId,
    roundId = null,
    participantId,
    participantName,
    houseName = null,
    criteriaScores, // { Execution: 9, Technique: 8 }
    judgeRemarks = null,
    judgeUserId,
  }) {
    if (!criteriaScores || typeof criteriaScores !== 'object') {
      const err = new Error('criteriaScores object is required');
      err.statusCode = 400;
      throw err;
    }

    const totalScore = Object.values(criteriaScores).reduce((sum, val) => sum + Number(val || 0), 0);

    const [score] = await sql`
      INSERT INTO event_competition_scores (
        school_id, competition_id, round_id, participant_id, participant_name,
        house_name, judge_user_id, criteria_scores, total_score, judge_remarks
      ) VALUES (
        ${schoolId}, ${competitionId}, ${roundId}, ${participantId}, ${participantName},
        ${houseName}, ${judgeUserId}, ${sql.json(criteriaScores)}, ${totalScore}, ${judgeRemarks}
      )
      RETURNING *
    `;

    return score;
  },

  /**
   * Finalize competition results, assign ranks, award house points, and generate certificates
   */
  async finalizeResults({
    schoolId,
    competitionId,
    rankings = [], // [{ participant_id, participant_name, student_id, house_name, rank_position, rank_title }]
    userId,
  }) {
    const [comp] = await sql`
      SELECT c.*, e.title as event_title, e.start_date as event_date
      FROM event_competitions c
      JOIN events e ON c.event_id = e.id
      WHERE c.id = ${competitionId} AND c.school_id = ${schoolId}
    `;
    if (!comp) {
      const err = new Error('Competition not found');
      err.statusCode = 404;
      throw err;
    }

    const pointsMap = comp.house_points_map || { '1st': 10, '2nd': 7, '3rd': 5, 'participation': 1 };

    return await sql.begin(async (tx) => {
      // Clear previous results if re-finalizing
      await tx`DELETE FROM event_competition_results WHERE competition_id = ${competitionId}`;

      const insertedResults = [];
      for (const r of rankings) {
        let points = 0;
        if (r.rank_position === 1) points = pointsMap['1st'] || 10;
        else if (r.rank_position === 2) points = pointsMap['2nd'] || 7;
        else if (r.rank_position === 3) points = pointsMap['3rd'] || 5;
        else points = pointsMap['participation'] || 1;

        const [result] = await tx`
          INSERT INTO event_competition_results (
            school_id, competition_id, participant_id, participant_name,
            student_id, house_name, rank_position, rank_title, house_points_awarded
          ) VALUES (
            ${schoolId}, ${competitionId}, ${r.participant_id}, ${r.participant_name},
            ${r.student_id || null}, ${r.house_name || null}, ${r.rank_position},
            ${r.rank_title || (r.rank_position === 1 ? 'Winner' : r.rank_position === 2 ? 'Runner Up' : 'Participant')},
            ${points}
          )
          RETURNING *
        `;
        insertedResults.push(result);

        // Auto-generate certificate for winner / participant if student_id is present
        if (r.student_id) {
          const certType = r.rank_position === 1 ? 'WINNER' : (r.rank_position === 2 ? 'RUNNER_UP' : 'PARTICIPATION');
          await EventCertificateService.issueCertificate({
            schoolId,
            eventId: comp.event_id,
            recipientType: 'STUDENT',
            studentId: r.student_id,
            recipientName: r.participant_name,
            certificateType: certType,
            competitionTitle: comp.title,
            positionTitle: r.rank_title || (r.rank_position === 1 ? '1st Place' : `${r.rank_position}nd Place`),
            userId,
          }, tx);
        }
      }

      await tx`
        UPDATE event_competitions
        SET is_finalized = true, finalized_at = now(), finalized_by = ${userId}, updated_at = now()
        WHERE id = ${competitionId}
      `;

      await EventEngineService.logAudit({
        schoolId,
        eventId: comp.event_id,
        actorUserId: userId,
        action: 'COMPETITION_FINALIZED',
        entityType: 'EVENT_COMPETITION',
        entityId: competitionId,
        details: `Finalized results for ${comp.title} with ${rankings.length} ranked participants`,
      }, tx);

      return insertedResults;
    });
  },

  /**
   * Get live House Leaderboard aggregated from competition results
   */
  async getHouseLeaderboard({ schoolId, eventId }) {
    return await sql`
      SELECT 
        r.house_name,
        sum(r.house_points_awarded)::int as total_points,
        count(r.id) FILTER (WHERE r.rank_position = 1)::int as gold_count,
        count(r.id) FILTER (WHERE r.rank_position = 2)::int as silver_count,
        count(r.id) FILTER (WHERE r.rank_position = 3)::int as bronze_count,
        count(r.id)::int as total_medals
      FROM event_competition_results r
      JOIN event_competitions c ON r.competition_id = c.id
      WHERE c.event_id = ${eventId} AND r.school_id = ${schoolId} AND r.house_name IS NOT NULL
      GROUP BY r.house_name
      ORDER BY total_points DESC, gold_count DESC, silver_count DESC
    `;
  }
};

export default EventCompetitionService;
