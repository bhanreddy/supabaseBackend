import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';

export const EventFeedbackService = {
  /**
   * Get or initialize feedback form for an event
   */
  async getOrCreateForm({ schoolId, eventId, title = 'Event Feedback Survey', questions = null }) {
    let [form] = await sql`
      SELECT * FROM event_feedback_forms
      WHERE event_id = ${eventId} AND school_id = ${schoolId} AND is_active = true
      LIMIT 1
    `;

    if (!form) {
      const defaultQuestions = questions || [
        { id: 'q1', type: 'RATING', question: 'Overall event experience (1-5 stars)', required: true },
        { id: 'q2', type: 'CHOICE', question: 'How was the organization, scheduling, and guidance?', options: ['Excellent', 'Good', 'Average', 'Needs Improvement'], required: true },
        { id: 'q3', type: 'TEXT', question: 'What did you like most about this event?', required: false },
        { id: 'q4', type: 'TEXT', question: 'Any suggestions or areas for improvement?', required: false },
      ];

      [form] = await sql`
        INSERT INTO event_feedback_forms (school_id, event_id, title, questions)
        VALUES (${schoolId}, ${eventId}, ${title}, ${sql.json(defaultQuestions)})
        RETURNING *
      `;
    }

    return form;
  },

  /**
   * Submit feedback response
   */
  async submitFeedback({ schoolId, eventId, formId, userId, responderRole = 'PARENT', answers, ratingScore = null, overallRating = null }) {
    if (!answers || typeof answers !== 'object') {
      const err = new Error('Answers object is required');
      err.statusCode = 400;
      throw err;
    }

    // Extract rating score if present in answers
    const rating = ratingScore || overallRating || answers.q1 || answers.rating || answers.overallRating || null;

    const [response] = await sql`
      INSERT INTO event_feedback_responses (
        school_id, event_id, form_id, responder_user_id, responder_role,
        answers, rating_score
      ) VALUES (
        ${schoolId}, ${eventId}, ${formId}, ${userId}, ${responderRole},
        ${sql.json(answers)}, ${rating}
      )
      RETURNING *
    `;

    return response;
  },

  /**
   * Get aggregated feedback analytics
   */
  async getFeedbackSummary({ schoolId, eventId }) {
    const stats = await sql`
      SELECT 
        count(*)::int as total_responses,
        round(avg(rating_score)::numeric, 1) as average_rating,
        count(*) FILTER (WHERE rating_score = 5)::int as five_star,
        count(*) FILTER (WHERE rating_score = 4)::int as four_star,
        count(*) FILTER (WHERE rating_score = 3)::int as three_star,
        count(*) FILTER (WHERE rating_score <= 2)::int as low_star
      FROM event_feedback_responses
      WHERE event_id = ${eventId} AND school_id = ${schoolId}
    `;

    const recentComments = await sql`
      SELECT 
        r.answers,
        r.rating_score,
        r.responder_role,
        r.created_at
      FROM event_feedback_responses r
      WHERE r.event_id = ${eventId} AND r.school_id = ${schoolId}
      ORDER BY r.created_at DESC
      LIMIT 20
    `;

    return {
      stats: stats[0] || { total_responses: 0, average_rating: 0 },
      recent_responses: recentComments,
    };
  }
};

export default EventFeedbackService;
