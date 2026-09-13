import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { EventBudgetExpenseService } from './eventBudgetExpenseService.js';
import { EventConsentService } from './eventConsentService.js';
import { EventAttendanceService } from './eventAttendanceService.js';
import { EventCompetitionService } from './eventCompetitionService.js';
import { EventFeedbackService } from './eventFeedbackService.js';

export const EventReportService = {
  /**
   * Get closure checklist items and status
   */
  async getClosureChecklist({ schoolId, eventId }) {
    return await sql`
      SELECT 
        c.*,
        p.display_name as verified_by_name
      FROM event_closure_checklists c
      LEFT JOIN users u ON c.verified_by = u.id
      LEFT JOIN persons p ON u.person_id = p.id
      WHERE c.event_id = ${eventId} AND c.school_id = ${schoolId}
      ORDER BY c.item_key ASC
    `;
  },

  /**
   * Update a closure checklist item
   */
  async updateClosureItem({ schoolId, eventId, itemKey, isCompleted, notes = null, userId }) {
    const [updated] = await sql`
      UPDATE event_closure_checklists
      SET 
        is_completed = ${isCompleted},
        verified_by = ${userId},
        verified_at = now(),
        notes = COALESCE(${notes}, notes)
      WHERE event_id = ${eventId} AND item_key = ${itemKey} AND school_id = ${schoolId}
      RETURNING *
    `;
    return updated;
  },

  /**
   * Formally close the event after checking all closure requirements
   */
  async closeEvent({ schoolId, eventId, userId, bypassIncomplete = false }) {
    const checklist = await this.getClosureChecklist({ schoolId, eventId });
    const incompleteItems = checklist.filter((item) => !item.is_completed);

    if (incompleteItems.length > 0 && !bypassIncomplete) {
      const err = new Error(`Cannot close event: ${incompleteItems.length} checklist items are incomplete`);
      err.statusCode = 400;
      err.incomplete_items = incompleteItems.map((i) => i.label);
      throw err;
    }

    return await sql.begin(async (tx) => {
      const [closed] = await tx`
        UPDATE events
        SET 
          status = 'CLOSED',
          closed_at = now(),
          closed_by = ${userId},
          updated_at = now()
        WHERE id = ${eventId} AND school_id = ${schoolId}
        RETURNING *
      `;

      // Auto-compile the final executive report snapshot
      await this.compileFinalReport({ schoolId, eventId, userId }, tx);

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: 'EVENT_CLOSED',
        entityType: 'EVENT',
        entityId: eventId,
        details: 'Event formally closed with executive report compilation',
      }, tx);

      return closed;
    });
  },

  /**
   * Compile and snapshot the comprehensive final event report
   */
  async compileFinalReport({ schoolId, eventId, userId }, tx = sql) {
    const event = await EventEngineService.getEventDetails({ schoolId, eventId });
    const budget = await EventBudgetExpenseService.getBudgetSummary({ schoolId, eventId }, tx);
    const consent = await EventConsentService.getConsentSummary({ schoolId, eventId });
    const attendance = await EventAttendanceService.getAttendanceDashboard({ schoolId, eventId });
    const leaderboard = await EventCompetitionService.getHouseLeaderboard({ schoolId, eventId });
    const feedback = await EventFeedbackService.getFeedbackSummary({ schoolId, eventId });

    const incidents = await tx`
      SELECT incident_type, severity, description, action_taken, is_resolved
      FROM event_incidents
      WHERE event_id = ${eventId} AND school_id = ${schoolId}
    `;

    const reportData = {
      event_id: event.id,
      title: event.title,
      category: event.category,
      start_date: event.start_date,
      end_date: event.end_date,
      location: event.location,
      coordinator_name: event.coordinator_name,
      readiness_score: event.readiness_score,
      participation: {
        total_registered: attendance.summary.total_registered,
        present_count: attendance.summary.present_count,
        absent_count: attendance.summary.absent_count,
        missing_count: attendance.summary.missing_count,
        attendance_percentage: attendance.summary.attendance_percentage,
      },
      consent: {
        consented_count: consent.consented_count,
        declined_count: consent.declined_count,
        pending_count: consent.pending_count,
        consent_percentage: consent.consent_percentage,
      },
      finances: {
        total_approved_budget: budget.totals.total_approved,
        total_actual_spent: budget.totals.total_actual_spent,
        net_variance: budget.totals.net_variance,
        budget_utilization_pct: budget.totals.budget_utilization_pct,
        categories: budget.categories,
      },
      competitions: {
        house_leaderboard: leaderboard,
      },
      incidents: {
        total_reported: incidents.length,
        critical_count: incidents.filter((i) => i.severity === 'CRITICAL').length,
        resolved_count: incidents.filter((i) => i.is_resolved).length,
        items: incidents,
      },
      safety: {
        total_incidents: incidents.length,
        critical_count: incidents.filter((i) => i.severity === 'CRITICAL').length,
        resolved_count: incidents.filter((i) => i.is_resolved).length,
      },
      feedback: {
        total_responses: feedback.stats.total_responses,
        average_rating: feedback.stats.average_rating,
      },
      generated_at: new Date().toISOString(),
    };

    const [report] = await tx`
      INSERT INTO event_reports (
        school_id, event_id, generated_by, report_title, report_data
      ) VALUES (
        ${schoolId}, ${eventId}, ${userId},
        ${`Executive Event Report: ${event.title}`},
        ${sql.json(reportData)}
      )
      ON CONFLICT (event_id) DO UPDATE SET
        report_data = EXCLUDED.report_data,
        generated_by = EXCLUDED.generated_by,
        generated_at = now()
      RETURNING *
    `;

    return report;
  },

  /**
   * Fetch compiled final report
   */
  async getFinalReport({ schoolId, eventId }) {
    let [report] = await sql`
      SELECT * FROM event_reports
      WHERE event_id = ${eventId} AND school_id = ${schoolId}
    `;

    if (!report) {
      // Generate on-the-fly if not compiled yet
      report = await this.compileFinalReport({ schoolId, eventId, userId: null });
    }

    return report;
  },

  /**
   * Cross-event analytics across school events
   */
  async getCrossEventAnalytics({ schoolId }) {
    const stats = await sql`
      SELECT 
        count(*)::int as total_events,
        count(*) FILTER (WHERE status = 'COMPLETED' OR status = 'CLOSED')::int as completed_events,
        count(*) FILTER (WHERE status = 'ONGOING')::int as ongoing_events,
        count(*) FILTER (WHERE status = 'PUBLISHED')::int as upcoming_events,
        count(*) FILTER (WHERE status = 'AWAITING_APPROVAL')::int as pending_approval_events,
        round(avg(readiness_score)::numeric, 1) as avg_readiness_score
      FROM events
      WHERE school_id = ${schoolId} AND deleted_at IS NULL
    `;

    const categoryBreakdown = await sql`
      SELECT 
        category,
        count(*)::int as count
      FROM events
      WHERE school_id = ${schoolId} AND deleted_at IS NULL
      GROUP BY category
      ORDER BY count DESC
    `;

    const topParticipated = await sql`
      SELECT 
        e.id,
        e.title,
        e.category,
        e.start_date,
        count(r.id)::int as participants_count
      FROM events e
      LEFT JOIN event_registrations r ON r.event_id = e.id AND r.deleted_at IS NULL
      WHERE e.school_id = ${schoolId} AND e.deleted_at IS NULL
      GROUP BY e.id, e.title, e.category, e.start_date
      ORDER BY participants_count DESC
      LIMIT 5
    `;

    return {
      overview: stats[0] || {},
      category_breakdown: categoryBreakdown,
      top_participated: topParticipated,
    };
  }
};

export default EventReportService;
