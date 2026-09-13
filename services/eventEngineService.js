import sql from '../db.js';
import { sendNotificationToUsers } from './notificationService.js';
import logger from '../utils/logger.js';
import {
  mapLegacyEventType,
  normalizeEventConfiguration,
  splitDateTime,
} from './eventModuleUtils.js';

/**
 * Event Engine Service
 * Manages core lifecycle, configuration, templates, readiness scoring, and audit logging.
 */
export const EventEngineService = {
  /**
   * Log an immutable audit event
   */
  async logAudit({ schoolId, eventId, actorUserId, action, entityType, entityId, previousState = null, newState = null, ipAddress = null, details = null }, tx = sql) {
    try {
      await tx`
        INSERT INTO event_audit_logs (
          school_id, event_id, actor_user_id, action, entity_type, entity_id,
          previous_state, new_state, ip_address, details
        ) VALUES (
          ${schoolId}, ${eventId || null}, ${actorUserId || null}, ${action}, ${entityType},
          ${entityId ? String(entityId) : null},
          ${previousState ? sql.json(previousState) : null},
          ${newState ? sql.json(newState) : null},
          ${ipAddress || null},
          ${details || null}
        )
      `;
    } catch (err) {
      logger.warn({ err: err.message, action, eventId }, 'Failed to write event audit log');
    }
  },

  /**
   * Calculate transparent readiness score based on actual operational state
   */
  async calculateReadinessScore(schoolId, eventId, tx = sql) {
    const [event] = await tx`
      SELECT id, configuration, approval_status, status
      FROM events
      WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (!event) return 0;

    const modules = event.configuration?.modules || {};
    let totalWeight = 0;
    let achievedWeight = 0;

    // 1. Approval weight (15%)
    totalWeight += 15;
    if (event.approval_status === 'APPROVED' || event.status === 'APPROVED' || event.status === 'PUBLISHED' || event.status === 'ONGOING' || event.status === 'COMPLETED') {
      achievedWeight += 15;
    } else if (event.approval_status === 'PENDING') {
      achievedWeight += 5;
    }

    // 2. Tasks weight (25%)
    totalWeight += 25;
    const taskStats = await tx`
      SELECT 
        count(*)::int as total_tasks,
        count(*) FILTER (WHERE status = 'COMPLETED')::int as completed_tasks,
        count(*) FILTER (WHERE status = 'OVERDUE' OR (due_date < CURRENT_DATE AND status != 'COMPLETED'))::int as overdue_tasks
      FROM event_tasks
      WHERE event_id = ${eventId} AND school_id = ${schoolId}
    `;
    const tasks = taskStats[0] || { total_tasks: 0, completed_tasks: 0, overdue_tasks: 0 };
    if (tasks.total_tasks > 0) {
      const taskRatio = tasks.completed_tasks / tasks.total_tasks;
      const penalty = Math.min(tasks.overdue_tasks * 0.1, 0.5);
      achievedWeight += Math.max(0, Math.round((taskRatio - penalty) * 25));
    } else {
      achievedWeight += 12; // Neutral baseline if no tasks defined yet
    }

    // 3. Teams & Committees weight (15%)
    totalWeight += 15;
    const [teamCount] = await tx`
      SELECT count(*)::int as count FROM event_teams WHERE event_id = ${eventId} AND school_id = ${schoolId}
    `;
    if (teamCount.count > 0) achievedWeight += 15;

    // 4. Registration & Participants (15%)
    if (modules.registration) {
      totalWeight += 15;
      const [regCount] = await tx`
        SELECT count(*)::int as count FROM event_registrations 
        WHERE event_id = ${eventId} AND school_id = ${schoolId} AND registration_status != 'CANCELLED'
      `;
      if (regCount.count > 0) achievedWeight += 15;
    }

    // 5. Parent Consent (15%)
    if (modules.consent) {
      totalWeight += 15;
      const [consentStats] = await tx`
        SELECT 
          count(*)::int as total_consents,
          count(*) FILTER (WHERE status = 'CONSENTED')::int as consented
        FROM event_consents
        WHERE event_id = ${eventId} AND school_id = ${schoolId}
      `;
      if (consentStats.total_consents > 0) {
        achievedWeight += Math.round((consentStats.consented / consentStats.total_consents) * 15);
      }
    }

    // 6. Transport Readiness (15%)
    if (modules.transport) {
      totalWeight += 15;
      const [transportCount] = await tx`
        SELECT count(*)::int as count FROM event_transport_assignments
        WHERE event_id = ${eventId} AND school_id = ${schoolId}
      `;
      if (transportCount.count > 0) achievedWeight += 15;
    }

    const score = totalWeight > 0 ? Number(((achievedWeight / totalWeight) * 100).toFixed(1)) : 100;

    await tx`
      UPDATE events
      SET readiness_score = ${score}
      WHERE id = ${eventId} AND school_id = ${schoolId}
    `;

    return score;
  },

  async resolveAudienceUserIds(schoolId, eventId, tx = sql) {
    const numericSchoolId = Number(schoolId);
    const targets = await tx`
      SELECT target_type, target_id
      FROM event_audience_targets
      WHERE school_id = ${numericSchoolId} AND event_id = ${eventId}
    `;

    if (!targets || targets.length === 0) {
      return [];
    }

    const userIdsSet = new Set();
    for (const t of targets) {
      if (t.target_type === 'ENTIRE_SCHOOL') {
        const allUsers = await tx`
          SELECT id FROM users
          WHERE school_id = ${numericSchoolId} AND deleted_at IS NULL
        `;
        allUsers.forEach((u) => userIdsSet.add(u.id));
        break;
      }
      if (t.target_type === 'ROLE') {
        const roleUsers = await tx`
          SELECT u.id
          FROM users u
          JOIN user_roles ur ON ur.user_id = u.id
          JOIN roles r ON r.id = ur.role_id
          WHERE u.school_id = ${numericSchoolId}
            AND r.code = ${t.target_id}
            AND u.deleted_at IS NULL
        `;
        roleUsers.forEach((u) => userIdsSet.add(u.id));
      } else if (t.target_type === 'USER') {
        userIdsSet.add(t.target_id);
      }
    }
    return [...userIdsSet];
  },

  async createEvent({ schoolId, data, userId, targets = [] }) {
    const {
      title,
      title_te,
      category = 'CUSTOM',
      description,
      description_te,
      location,
      is_all_day = false,
      is_public = true,
      banner_url = null,
      coordinator_id = null,
      status = 'DRAFT',
      approval_status = 'DRAFT',
    } = data;

    const startParts = splitDateTime(data.start_date);
    const endParts = splitDateTime(data.end_date || data.start_date);
    const start_date = startParts.date;
    const end_date = endParts.date || start_date;
    const start_time = data.start_time || startParts.time;
    const end_time = data.end_time || endParts.time;
    const configuration = normalizeEventConfiguration(data);
    const eventType = mapLegacyEventType(data.event_type || data.category);
    const registration_deadline = data.registration_deadline || configuration.constraints.registration_deadline || null;

    if (!title || !start_date) {
      const err = new Error('title and start_date are required');
      err.statusCode = 400;
      throw err;
    }

    return await sql.begin(async (tx) => {
      const [event] = await tx`
        INSERT INTO events (
          school_id, title, title_te, category, description, description_te,
          event_type, start_date, end_date, start_time, end_time, location,
          is_all_day, is_public, target_audience, banner_url,
          registration_deadline, coordinator_id, configuration,
          status, approval_status, created_by
        ) VALUES (
          ${schoolId}, ${title}, ${title_te || null}, ${category}, ${description || null}, ${description_te || null},
          ${eventType}, ${start_date}, ${end_date || start_date}, ${start_time || null}, ${end_time || null},
          ${location || null}, ${Boolean(is_all_day)}, ${Boolean(is_public)}, 'all', ${banner_url},
          ${registration_deadline}, ${coordinator_id || userId},
          ${sql.json(configuration)}, ${status}, ${approval_status}, ${userId}
        )
        RETURNING *
      `;

      // Insert audience targets
      if (Array.isArray(targets) && targets.length > 0) {
        for (const t of targets) {
          const type = t.target_type || t.targetType;
          const id = t.target_id || t.targetId;
          if (type && id) {
            await tx`
              INSERT INTO event_audience_targets (school_id, event_id, target_type, target_id)
              VALUES (${schoolId}, ${event.id}, ${type}, ${String(id)})
              ON CONFLICT DO NOTHING
            `;
          }
        }
      } else {
        // Default to entire school
        await tx`
          INSERT INTO event_audience_targets (school_id, event_id, target_type, target_id)
          VALUES (${schoolId}, ${event.id}, 'ENTIRE_SCHOOL', 'ALL')
          ON CONFLICT DO NOTHING
        `;
      }

      // Initialize default closure checklist
      const defaultChecklist = [
        { key: 'attendance_finalized', label: 'Event attendance verified and marked complete' },
        { key: 'results_finalized', label: 'Competition scores and rankings finalized' },
        { key: 'certificates_issued', label: 'Participant and winner certificates issued' },
        { key: 'expenses_settled', label: 'All vendor invoices and expense claims settled' },
        { key: 'incidents_resolved', label: 'All reported safety incidents investigated and closed' },
        { key: 'feedback_reviewed', label: 'Post-event attendee feedback reviewed' },
        { key: 'final_report_generated', label: 'Executive final event report compiled' },
      ];

      for (const item of defaultChecklist) {
        await tx`
          INSERT INTO event_closure_checklists (school_id, event_id, item_key, label)
          VALUES (${schoolId}, ${event.id}, ${item.key}, ${item.label})
          ON CONFLICT DO NOTHING
        `;
      }

      await this.logAudit({
        schoolId,
        eventId: event.id,
        actorUserId: userId,
        action: 'EVENT_CREATED',
        entityType: 'EVENT',
        entityId: event.id,
        newState: { title: event.title, status: event.status, category: event.category },
        details: 'Event created via Wizard',
      }, tx);

      return event;
    });
  },

  /**
   * List events with rich operational filters, metrics, and pagination
   */
  async listEvents({ schoolId, filters = {}, pagination = {} }) {
    const {
      category,
      from_date,
      to_date,
      search,
      coordinator_id,
    } = filters;

    let status = filters.status;
    let upcoming_only = filters.upcoming_only;
    let past_only = filters.past_only;
    if (status === 'UPCOMING') {
      upcoming_only = true;
      status = null;
    } else if (status === 'PENDING_APPROVAL' || status === 'APPROVALS') {
      status = 'AWAITING_APPROVAL';
    } else if (status === 'LIVE') {
      status = 'ONGOING';
    } else if (status === 'CLOSED') {
      past_only = false;
    }

    const page = Math.max(1, parseInt(pagination.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(pagination.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const rows = await sql`
      SELECT 
        e.*,
        coord_p.display_name as coordinator_name,
        creator_p.display_name as creator_name,
        (SELECT count(*)::int FROM event_registrations r WHERE r.event_id = e.id AND r.deleted_at IS NULL AND r.registration_status != 'CANCELLED') as registration_count,
        (SELECT count(*)::int FROM event_consents c WHERE c.event_id = e.id AND c.status = 'CONSENTED') as consented_count,
        (SELECT count(*)::int FROM event_consents c WHERE c.event_id = e.id) as total_consents,
        (SELECT count(*)::int FROM event_attendance a WHERE a.event_id = e.id AND a.status IN ('PRESENT', 'CHECKED_IN', 'ON_BUS', 'ARRIVED')) as present_count,
        (SELECT count(*)::int FROM event_tasks t WHERE t.event_id = e.id AND t.status = 'COMPLETED') as completed_tasks_count,
        (SELECT count(*)::int FROM event_tasks t WHERE t.event_id = e.id) as total_tasks_count,
        (SELECT count(*)::int FROM event_tasks t WHERE t.event_id = e.id AND (t.status = 'OVERDUE' OR (t.due_date < CURRENT_DATE AND t.status != 'COMPLETED'))) as overdue_tasks_count,
        (SELECT COALESCE(sum(b.approved_amount), 0)::numeric FROM event_budgets b WHERE b.event_id = e.id) as total_budget,
        (SELECT COALESCE(sum(x.amount), 0)::numeric FROM event_expenses x WHERE x.event_id = e.id AND x.status IN ('APPROVED', 'PAID')) as total_spent
      FROM events e
      LEFT JOIN users coord_u ON e.coordinator_id = coord_u.id
      LEFT JOIN persons coord_p ON coord_u.person_id = coord_p.id
      LEFT JOIN users creator_u ON e.created_by = creator_u.id
      LEFT JOIN persons creator_p ON creator_u.person_id = creator_p.id
      WHERE e.school_id = ${schoolId}
        AND e.deleted_at IS NULL
        ${status ? sql`AND e.status = ${status}` : sql``}
        ${category ? sql`AND e.category = ${category}` : sql``}
        ${coordinator_id ? sql`AND e.coordinator_id = ${coordinator_id}` : sql``}
        ${from_date ? sql`AND e.start_date >= ${from_date}::date` : sql``}
        ${to_date ? sql`AND e.start_date <= ${to_date}::date` : sql``}
        ${upcoming_only ? sql`AND e.start_date >= CURRENT_DATE` : sql``}
        ${past_only ? sql`AND e.end_date < CURRENT_DATE` : sql``}
        ${search ? sql`AND (e.title ILIKE ${'%' + search + '%'} OR e.location ILIKE ${'%' + search + '%'})` : sql``}
      ORDER BY e.start_date DESC, e.start_time DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [totalCount] = await sql`
      SELECT count(*)::int as count
      FROM events e
      WHERE e.school_id = ${schoolId}
        AND e.deleted_at IS NULL
        ${status ? sql`AND e.status = ${status}` : sql``}
        ${category ? sql`AND e.category = ${category}` : sql``}
        ${coordinator_id ? sql`AND e.coordinator_id = ${coordinator_id}` : sql``}
        ${from_date ? sql`AND e.start_date >= ${from_date}::date` : sql``}
        ${to_date ? sql`AND e.start_date <= ${to_date}::date` : sql``}
        ${upcoming_only ? sql`AND e.start_date >= CURRENT_DATE` : sql``}
        ${past_only ? sql`AND e.end_date < CURRENT_DATE` : sql``}
        ${search ? sql`AND (e.title ILIKE ${'%' + search + '%'} OR e.location ILIKE ${'%' + search + '%'})` : sql``}
    `;

    return {
      events: rows.map((row) => ({
        ...row,
        config: normalizeEventConfiguration({ configuration: row.configuration || {} }),
        configuration: normalizeEventConfiguration({ configuration: row.configuration || {} }),
      })),
      pagination: {
        page,
        limit,
        total: totalCount?.count || 0,
        pages: Math.ceil((totalCount?.count || 0) / limit),
      },
    };
  },

  /**
   * Get complete event details including active modules, targets, and coordinator
   */
  async getEventDetails({ schoolId, eventId }, tx = sql) {
    const [event] = await tx`
      SELECT 
        e.*,
        coord_p.display_name as coordinator_name,
        creator_p.display_name as creator_name
      FROM events e
      LEFT JOIN users coord_u ON e.coordinator_id = coord_u.id
      LEFT JOIN persons coord_p ON coord_u.person_id = coord_p.id
      LEFT JOIN users creator_u ON e.created_by = creator_u.id
      LEFT JOIN persons creator_p ON creator_u.person_id = creator_p.id
      WHERE e.id = ${eventId} AND e.school_id = ${schoolId} AND e.deleted_at IS NULL
    `;

    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    const targets = await tx`
      SELECT target_type, target_id
      FROM event_audience_targets
      WHERE event_id = ${eventId} AND school_id = ${schoolId}
    `;

    event.targets = targets;
    event.configuration = normalizeEventConfiguration({ configuration: event.configuration || {} });
    event.config = event.configuration;
    return event;
  },

  async getOperationalDashboard({ schoolId, eventId }) {
    const event = await this.getEventDetails({ schoolId, eventId });
    const score = await this.calculateReadinessScore(schoolId, eventId);
    return {
      event,
      readiness_score: score,
      registration_count: event.registration_count || null,
    };
  },

  async listEligibleEvents({ schoolId }) {
    const rows = await sql`
      SELECT e.id, e.title, e.category, e.event_type, e.start_date, e.end_date, e.start_time, e.end_time,
             e.location, e.status, e.configuration, e.readiness_score, e.banner_url
      FROM events e
      WHERE e.school_id = ${schoolId}
        AND e.deleted_at IS NULL
        AND e.status IN ('PUBLISHED', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ONGOING', 'COMPLETED', 'CLOSURE_PENDING')
      ORDER BY e.start_date ASC, e.start_time ASC NULLS LAST
      LIMIT 100
    `;
    return rows.map((row) => ({
      ...row,
      config: normalizeEventConfiguration({ configuration: row.configuration || {} }),
      configuration: normalizeEventConfiguration({ configuration: row.configuration || {} }),
    }));
  },

  async getAuditLogs({ schoolId, eventId }) {
    return await sql`
      SELECT * FROM event_audit_logs
      WHERE school_id = ${schoolId} AND event_id = ${eventId}
      ORDER BY created_at DESC
      LIMIT 200
    `;
  },

  /**
   * Update event information and module configuration
   */
  async updateEvent({ schoolId, eventId, data, userId }) {
    const [existing] = await sql`
      SELECT * FROM events WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (!existing) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    const [updated] = await sql`
      UPDATE events
      SET
        title = COALESCE(${data.title ?? null}, title),
        title_te = COALESCE(${data.title_te ?? null}, title_te),
        category = COALESCE(${data.category ?? null}, category),
        description = COALESCE(${data.description ?? null}, description),
        description_te = COALESCE(${data.description_te ?? null}, description_te),
        start_date = COALESCE(${data.start_date ?? null}, start_date),
        end_date = COALESCE(${data.end_date ?? null}, end_date),
        start_time = COALESCE(${data.start_time ?? null}, start_time),
        end_time = COALESCE(${data.end_time ?? null}, end_time),
        location = COALESCE(${data.location ?? null}, location),
        is_all_day = COALESCE(${data.is_all_day ?? null}, is_all_day),
        is_public = COALESCE(${data.is_public ?? null}, is_public),
        banner_url = COALESCE(${data.banner_url ?? null}, banner_url),
        registration_deadline = COALESCE(${data.registration_deadline ?? null}, registration_deadline),
        coordinator_id = COALESCE(${data.coordinator_id ?? null}, coordinator_id),
        configuration = COALESCE(${data.configuration || data.config ? sql.json(normalizeEventConfiguration(data)) : null}, configuration),
        event_type = COALESCE(${data.event_type ? mapLegacyEventType(data.event_type) : null}, event_type),
        status = COALESCE(${data.status ?? null}, status),
        updated_at = now()
      WHERE id = ${eventId} AND school_id = ${schoolId}
      RETURNING *
    `;

    await this.calculateReadinessScore(schoolId, eventId);

    await this.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'EVENT_UPDATED',
      entityType: 'EVENT',
      entityId: eventId,
      previousState: { title: existing.title, status: existing.status },
      newState: { title: updated.title, status: updated.status },
      details: 'Event updated',
    });

    return updated;
  },

  /**
   * Publish an approved event and notify target audiences
   */
  async publishEvent({ schoolId, eventId, userId }) {
    const [event] = await sql`
      SELECT * FROM events WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    const [published] = await sql`
      UPDATE events
      SET 
        status = 'PUBLISHED',
        updated_at = now()
      WHERE id = ${eventId} AND school_id = ${schoolId}
      RETURNING *
    `;

    // Fan-out notifications to targeted users
    try {
      const userIds = await this.resolveAudienceUserIds(schoolId, eventId);
      if (userIds && userIds.length > 0) {
        await sendNotificationToUsers(userIds, 'EVENT_PUBLISHED', {
          title: `School Event: ${event.title}`,
          message: `Date: ${event.start_date} | Location: ${event.location || 'Campus'}`,
          eventId: event.id,
        }, { schoolId });
      }
    } catch (notifErr) {
      logger.warn({ err: notifErr.message, eventId }, 'Failed to send event publication notifications');
    }

    await this.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'EVENT_PUBLISHED',
      entityType: 'EVENT',
      entityId: eventId,
      newState: { status: 'PUBLISHED' },
      details: 'Event published to target audience',
    });

    return published;
  },

  /**
   * Get available event templates
   */
  async getTemplates(schoolId, category = null) {
    return await sql`
      SELECT *
      FROM event_templates
      WHERE (school_id = ${schoolId} OR is_system = true)
        AND deleted_at IS NULL
        ${category ? sql`AND category = ${category}` : sql``}
      ORDER BY is_system DESC, name ASC
    `;
  },

  /**
   * Clone / instantiate an event from a template
   */
  async cloneFromTemplate({ schoolId, templateId, overrides = {}, userId }) {
    const [template] = await sql`
      SELECT * FROM event_templates WHERE id = ${templateId} AND (school_id = ${schoolId} OR is_system = true)
    `;
    if (!template) {
      const err = new Error('Template not found');
      err.statusCode = 404;
      throw err;
    }

    const eventData = {
      title: overrides.title || `${template.name} ${new Date().getFullYear()}`,
      category: template.category,
      description: overrides.description || template.description,
      start_date: overrides.start_date || new Date().toISOString().split('T')[0],
      end_date: overrides.end_date || overrides.start_date || new Date().toISOString().split('T')[0],
      start_time: overrides.start_time || '09:00:00',
      end_time: overrides.end_time || '16:00:00',
      location: overrides.location || 'School Campus',
      configuration: overrides.configuration || template.default_configuration,
      coordinator_id: overrides.coordinator_id || userId,
      status: 'DRAFT',
      approval_status: 'DRAFT',
    };

    const newEvent = await this.createEvent({
      schoolId,
      data: eventData,
      userId,
      targets: overrides.targets || [{ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' }],
    });

    // Populate default teams from template
    if (Array.isArray(template.default_teams) && template.default_teams.length > 0) {
      for (const t of template.default_teams) {
        await sql`
          INSERT INTO event_teams (school_id, event_id, name, responsibilities)
          VALUES (${schoolId}, ${newEvent.id}, ${t.name}, ${t.lead_title || null})
        `;
      }
    }

    // Populate default tasks from template
    if (Array.isArray(template.default_tasks) && template.default_tasks.length > 0) {
      for (const t of template.default_tasks) {
        await sql`
          INSERT INTO event_tasks (school_id, event_id, title, priority, status)
          VALUES (${schoolId}, ${newEvent.id}, ${t.title}, ${t.priority || 'MEDIUM'}, 'TODO')
        `;
      }
    }

    // Populate default budget categories from template
    if (Array.isArray(template.default_budget_categories) && template.default_budget_categories.length > 0) {
      for (const cat of template.default_budget_categories) {
        await sql`
          INSERT INTO event_budgets (school_id, event_id, category, proposed_amount, approved_amount)
          VALUES (${schoolId}, ${newEvent.id}, ${cat.toUpperCase().replace(/\s+/g, '_')}, 0.00, 0.00)
          ON CONFLICT DO NOTHING
        `;
      }
    }

    await this.calculateReadinessScore(schoolId, newEvent.id);
    return newEvent;
  },

  /**
   * Soft-delete event
   */
  async deleteEvent({ schoolId, eventId, userId }) {
    const [deleted] = await sql`
      UPDATE events
      SET deleted_at = now(), status = 'CANCELLED'
      WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
      RETURNING id, title
    `;
    if (!deleted) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    await this.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'EVENT_DELETED',
      entityType: 'EVENT',
      entityId: eventId,
      details: `Event ${deleted.title} marked deleted`,
    });

    return { success: true, message: 'Event deleted successfully' };
  }
};

export default EventEngineService;
