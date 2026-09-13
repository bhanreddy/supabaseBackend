import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';

export const EventTeamTaskService = {
  // ─── TEAMS & COMMITTEES ──────────────────────────────────────────────

  async createTeam({ schoolId, eventId, name, leadStaffId = null, responsibilities = null, notes = null, color = '#4F46E5' }) {
    const [team] = await sql`
      INSERT INTO event_teams (school_id, event_id, name, lead_staff_id, responsibilities, notes, color)
      VALUES (${schoolId}, ${eventId}, ${name}, ${leadStaffId}, ${responsibilities}, ${notes}, ${color})
      RETURNING *
    `;
    await EventEngineService.calculateReadinessScore(schoolId, eventId);
    return team;
  },

  async listTeams({ schoolId, eventId }) {
    const teams = await sql`
      SELECT 
        t.*,
        p.display_name as lead_name,
        count(m.id)::int as member_count
      FROM event_teams t
      LEFT JOIN staff s ON t.lead_staff_id = s.id
      LEFT JOIN persons p ON s.person_id = p.id
      LEFT JOIN event_team_members m ON m.team_id = t.id
      WHERE t.event_id = ${eventId} AND t.school_id = ${schoolId}
      GROUP BY t.id, p.display_name
      ORDER BY t.created_at ASC
    `;

    for (const team of teams) {
      const members = await sql`
        SELECT 
          m.*,
          COALESCE(p.display_name, stud_p.display_name, u_p.display_name) as member_name
        FROM event_team_members m
        LEFT JOIN staff s ON m.staff_id = s.id
        LEFT JOIN persons p ON s.person_id = p.id
        LEFT JOIN students stud ON m.student_id = stud.id
        LEFT JOIN persons stud_p ON stud.person_id = stud_p.id
        LEFT JOIN users u ON m.user_id = u.id
        LEFT JOIN persons u_p ON u.person_id = u_p.id
        WHERE m.team_id = ${team.id}
      `;
      team.members = members;
    }

    return teams;
  },

  async addTeamMember({ schoolId, teamId, eventId, memberType = 'STAFF', staffId = null, studentId = null, userId, roleTitle = 'Member' }) {
    const [member] = await sql`
      INSERT INTO event_team_members (
        school_id, team_id, event_id, member_type, staff_id, student_id, user_id, role_title
      ) VALUES (
        ${schoolId}, ${teamId}, ${eventId}, ${memberType}, ${staffId}, ${studentId}, ${userId}, ${roleTitle}
      )
      RETURNING *
    `;
    return member;
  },

  async removeTeamMember({ schoolId, memberId }) {
    await sql`
      DELETE FROM event_team_members WHERE id = ${memberId} AND school_id = ${schoolId}
    `;
    return { success: true };
  },

  // ─── TASKS & KANBAN ──────────────────────────────────────────────────

  async createTask({ schoolId, eventId, data, userId }) {
    const {
      title,
      description = null,
      team_id = null,
      assigned_to_user_id = null,
      due_date = null,
      priority = 'MEDIUM',
      status = 'TODO',
      checklist = [],
      attachments = [],
    } = data;

    const [task] = await sql`
      INSERT INTO event_tasks (
        school_id, event_id, team_id, title, description,
        assigned_to_user_id, due_date, priority, status,
        checklist, attachments, created_by
      ) VALUES (
        ${schoolId}, ${eventId}, ${team_id}, ${title}, ${description},
        ${assigned_to_user_id}, ${due_date}, ${priority}, ${status},
        ${sql.json(checklist)}, ${sql.json(attachments)}, ${userId}
      )
      RETURNING *
    `;

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'TASK_CREATED',
      entityType: 'EVENT_TASK',
      entityId: task.id,
      newState: { title, status, priority },
      details: `Created task: ${title}`,
    });

    await EventEngineService.calculateReadinessScore(schoolId, eventId);
    return task;
  },

  async listTasks({ schoolId, eventId, filters = {} }) {
    const { status, team_id, priority, assigned_to_user_id, search } = filters;

    return await sql`
      SELECT 
        t.*,
        team.name as team_name,
        team.color as team_color,
        assignee_p.display_name as assigned_name,
        creator_p.display_name as creator_name,
        CASE 
          WHEN t.status != 'COMPLETED' AND t.due_date < CURRENT_DATE THEN true
          ELSE false
        END as is_overdue
      FROM event_tasks t
      LEFT JOIN event_teams team ON t.team_id = team.id
      LEFT JOIN users assignee_u ON t.assigned_to_user_id = assignee_u.id
      LEFT JOIN persons assignee_p ON assignee_u.person_id = assignee_p.id
      LEFT JOIN users creator_u ON t.created_by = creator_u.id
      LEFT JOIN persons creator_p ON creator_u.person_id = creator_p.id
      WHERE t.event_id = ${eventId} AND t.school_id = ${schoolId}
        ${status ? sql`AND t.status = ${status}` : sql``}
        ${team_id ? sql`AND t.team_id = ${team_id}` : sql``}
        ${priority ? sql`AND t.priority = ${priority}` : sql``}
        ${assigned_to_user_id ? sql`AND t.assigned_to_user_id = ${assigned_to_user_id}` : sql``}
        ${search ? sql`AND (t.title ILIKE ${'%' + search + '%'} OR t.description ILIKE ${'%' + search + '%'})` : sql``}
      ORDER BY 
        CASE t.priority 
          WHEN 'URGENT' THEN 1 
          WHEN 'HIGH' THEN 2 
          WHEN 'MEDIUM' THEN 3 
          WHEN 'LOW' THEN 4 
          ELSE 5 
        END,
        t.due_date ASC NULLS LAST
    `;
  },

  async updateTask({ schoolId, eventId = null, taskId, data, userId }) {
    const [existing] = await sql`
      SELECT * FROM event_tasks 
      WHERE id = ${taskId} AND school_id = ${schoolId} ${eventId ? sql`AND event_id = ${eventId}` : sql``}
    `;
    if (!existing) {
      const err = new Error('Task not found');
      err.statusCode = 404;
      throw err;
    }

    const taskStatus = data.status === 'DONE' ? 'COMPLETED' : data.status;
    const completedAt = taskStatus === 'COMPLETED' ? new Date().toISOString() : (data.status ? null : existing.completed_at);

    const [updated] = await sql`
      UPDATE event_tasks
      SET
        title = COALESCE(${data.title ?? null}, title),
        description = COALESCE(${data.description ?? null}, description),
        team_id = COALESCE(${data.team_id ?? null}, team_id),
        assigned_to_user_id = COALESCE(${data.assigned_to_user_id ?? null}, assigned_to_user_id),
        due_date = COALESCE(${data.due_date ?? null}, due_date),
        priority = COALESCE(${data.priority ?? null}, priority),
        status = COALESCE(${taskStatus ?? null}, status),
        checklist = COALESCE(${data.checklist ? sql.json(data.checklist) : null}, checklist),
        completed_at = ${completedAt},
        updated_at = now()
      WHERE id = ${taskId} AND school_id = ${schoolId}
      RETURNING *
    `;

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'TASK_UPDATED',
      entityType: 'EVENT_TASK',
      entityId: taskId,
      previousState: { status: existing.status, priority: existing.priority },
      newState: { status: updated.status, priority: updated.priority },
      details: `Updated task status to ${updated.status}`,
    });

    await EventEngineService.calculateReadinessScore(schoolId, eventId);
    return updated;
  },

  async deleteTask({ schoolId, eventId, taskId, userId }) {
    await sql`
      DELETE FROM event_tasks WHERE id = ${taskId} AND event_id = ${eventId} AND school_id = ${schoolId}
    `;
    await EventEngineService.calculateReadinessScore(schoolId, eventId);
    return { success: true };
  }
};

export default EventTeamTaskService;
