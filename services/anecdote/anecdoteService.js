import sql from '../../db.js';
import logger from '../../utils/logger.js';
import { logAnecdoteAudit } from './anecdoteAuditService.js';
import { parseNLPStructuredInput } from './anecdoteTaxonomyService.js';
import { emitSchoolEvent, AUTOMATION_EVENTS } from '../automationEventService.js';
import {
  assertStudentInSchool,
  isFamilyRole,
  isPrivilegedStaff,
  resolveStaffId,
} from './anecdoteAccessService.js';
import { notifyFollowUpAssigned } from '../intelligence/intelligenceNotificationService.js';
import { normalizeAnecdoteContext, normalizeClientGeneratedId } from './anecdoteNormalize.js';

/**
 * Create a new Anecdote observation with offline idempotency and fast enrichment.
 */
export async function createAnecdote({ schoolId, userId, payload, ipAddress = null }) {
  const {
    student_id,
    class_section_id = null,
    title = null,
    observation_text,
    context = 'classroom',
    observation_type = null,
    category_id = null,
    subcategory_id = null,
    sentiment = null,
    severity = null,
    visibility = 'STAFF_ONLY',
    status = 'ACTIVE',
    observed_at = new Date().toISOString(),
    client_generated_id = null,
    tags = [],
  } = payload;
  const resolvedContext = normalizeAnecdoteContext(context);
  const resolvedClientId = normalizeClientGeneratedId(client_generated_id);

  if (!student_id || !observation_text?.trim()) {
    throw new Error('Student ID and observation text are required');
  }

  await assertStudentInSchool({ schoolId, studentId: student_id });

  // 1. Idempotency Check for Offline Sync: Return existing record if already synced
  if (resolvedClientId) {
    const [existing] = await sql`
      SELECT id, student_id, observation_text, status, created_at
      FROM public.anecdotes
      WHERE school_id = ${schoolId}
        AND client_generated_id = ${resolvedClientId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (existing) {
      logger.info({ schoolId, client_generated_id: resolvedClientId, id: existing.id }, 'Anecdote already synced (idempotent duplicate prevented)');
      return { ...existing, is_duplicate: true };
    }
  }

  // 2. Resolve or Enrich Taxonomy: If teacher didn't select, infer it deterministically
  let finalCategoryId = category_id;
  let finalSubcategoryId = subcategory_id;
  let finalType = observation_type;
  let finalSentiment = sentiment;
  let finalSeverity = severity;
  let inferredMeta = {};

  const inference = await parseNLPStructuredInput(observation_text, { schoolId });
  inferredMeta = {
    suggested_skills: inference.suggested_skills,
    matched_keywords: inference.matched_keywords,
    confidence: inference.confidence,
  };

  if (!finalCategoryId) finalCategoryId = inference.category_id;
  if (!finalSubcategoryId) finalSubcategoryId = inference.subcategory_id;
  if (!finalType) finalType = inference.observation_type;
  if (!finalSentiment) finalSentiment = inference.sentiment;
  if (!finalSeverity) finalSeverity = inference.severity;

  // 3. Resolve class_section_id if not supplied by client
  let resolvedClassSectionId = class_section_id;
  if (!resolvedClassSectionId) {
    const [enrollment] = await sql`
      SELECT class_section_id
      FROM public.student_enrollments
      WHERE school_id = ${schoolId}
        AND student_id = ${student_id}
        AND status = 'active'
        AND deleted_at IS NULL
      ORDER BY start_date DESC
      LIMIT 1
    `;
    if (enrollment) resolvedClassSectionId = enrollment.class_section_id;
  }

  // 4. Generate title if absent
  const finalTitle = title?.trim() || (observation_text.length > 60 ? `${observation_text.slice(0, 57)}...` : observation_text);

  // 5. Insert Record
  const [newAnecdote] = await sql`
    INSERT INTO public.anecdotes (
      school_id,
      student_id,
      class_section_id,
      title,
      observation_text,
      context,
      observation_type,
      category_id,
      subcategory_id,
      sentiment,
      severity,
      visibility,
      status,
      inferred_metadata,
      observed_at,
      client_generated_id,
      created_by
    ) VALUES (
      ${schoolId},
      ${student_id},
      ${resolvedClassSectionId},
      ${finalTitle},
      ${observation_text.trim()},
      ${resolvedContext},
      ${finalType},
      ${finalCategoryId},
      ${finalSubcategoryId},
      ${finalSentiment},
      ${finalSeverity},
      ${visibility},
      ${status},
      ${sql.json(inferredMeta)},
      ${observed_at},
      ${resolvedClientId},
      ${userId}
    )
    RETURNING *
  `;

  // 6. Insert Tags
  const tagList = Array.isArray(tags) ? tags.filter(Boolean).map((t) => String(t).trim().toLowerCase()) : [];
  if (tagList.length > 0) {
    await sql`
      INSERT INTO public.anecdote_tags (school_id, anecdote_id, tag_name)
      SELECT ${schoolId}, ${newAnecdote.id}, unnest(${tagList}::text[])
      ON CONFLICT (anecdote_id, tag_name) DO NOTHING
    `;
  }

  // 7. Audit Log
  await logAnecdoteAudit({
    schoolId,
    anecdoteId: newAnecdote.id,
    action: 'CREATED',
    newState: {
      category_id: finalCategoryId,
      severity: finalSeverity,
      visibility,
      status,
    },
    performedBy: userId,
    ipAddress,
  });

  // 8. Non-blocking Asynchronous Intelligence Event Dispatch
  emitSchoolEvent(AUTOMATION_EVENTS.ANECDOTE_CREATED, {
    schoolId,
    studentId: student_id,
    anecdoteId: newAnecdote.id,
    severity: finalSeverity,
  });

  return newAnecdote;
}

/**
 * List anecdotes with filters, pagination, and role-based visibility enforcement.
 */
export async function getAnecdotes({
  schoolId,
  studentId = null,
  classSectionId = null,
  categoryId = null,
  categoryCode = null,
  observationType = null,
  sentiment = null,
  severity = null,
  status = null,
  visibility = null,
  search = null,
  page = 1,
  limit = 20,
  userRoles = [],
  userId = null,
}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  // Visibility Filter based on Roles
  const isFamily = isFamilyRole(userRoles);
  const isStudent = userRoles.includes('student') || userRoles.includes('students');
  const isAdmin = userRoles.includes('admin') || userRoles.includes('principal');
  const isCoordinator = userRoles.includes('coordinator');

  let allowedVisibilities = ['STAFF_ONLY', 'COORDINATOR_ONLY', 'SCHOOL_ADMIN', 'PARENT_VISIBLE', 'STUDENT_VISIBLE'];
  if (isFamily && !isAdmin) {
    allowedVisibilities = isStudent && !userRoles.includes('parent')
      ? ['STUDENT_VISIBLE', 'PARENT_VISIBLE']
      : ['PARENT_VISIBLE'];
  } else if (!isAdmin && isCoordinator) {
    allowedVisibilities = ['STAFF_ONLY', 'COORDINATOR_ONLY', 'PARENT_VISIBLE', 'STUDENT_VISIBLE'];
  } else if (!isAdmin) {
    allowedVisibilities = ['STAFF_ONLY', 'PARENT_VISIBLE', 'STUDENT_VISIBLE'];
  }

  const conditions = [
    sql`a.school_id = ${schoolId}`,
    sql`a.deleted_at IS NULL`,
    sql`a.visibility IN ${sql(allowedVisibilities)}`,
  ];

  if (isFamily && userId) {
    conditions.push(sql`
      EXISTS (
        SELECT 1
        FROM public.users u
        WHERE u.id = ${userId}
          AND (
            EXISTS (
              SELECT 1 FROM public.students st
              WHERE st.id = a.student_id AND st.person_id = u.person_id AND st.school_id = ${schoolId}
            )
            OR EXISTS (
              SELECT 1
              FROM public.student_parents sp
              JOIN public.parents par ON par.id = sp.parent_id
              WHERE sp.student_id = a.student_id
                AND par.person_id = u.person_id
                AND sp.school_id = ${schoolId}
            )
          )
      )
    `);
  } else if (!isPrivilegedStaff(userRoles) && userId) {
    const staffId = await resolveStaffId({ schoolId, userId });
    if (staffId) {
      conditions.push(sql`
        EXISTS (
          SELECT 1
          FROM public.student_enrollments se
          JOIN public.class_sections cs ON cs.id = se.class_section_id
          WHERE se.school_id = ${schoolId}
            AND se.student_id = a.student_id
            AND se.status = 'active'
            AND se.deleted_at IS NULL
            AND (
              cs.class_teacher_id = ${staffId}
              OR EXISTS (
                SELECT 1 FROM public.timetable_slots ts
                WHERE ts.class_section_id = cs.id
                  AND ts.teacher_id = ${staffId}
                  AND ts.school_id = ${schoolId}
                  AND ts.deleted_at IS NULL
              )
            )
        )
      `);
    } else if (!studentId) {
      conditions.push(sql`false`);
    }
  }

  if (studentId) conditions.push(sql`a.student_id = ${studentId}`);
  if (classSectionId) conditions.push(sql`a.class_section_id = ${classSectionId}`);
  if (categoryId) conditions.push(sql`a.category_id = ${categoryId}`);
  if (categoryCode) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM public.anecdote_categories cat_filter
      WHERE cat_filter.id = a.category_id
        AND cat_filter.code = ${categoryCode}
    )`);
  }
  if (observationType) conditions.push(sql`a.observation_type = ${observationType}`);
  if (sentiment) conditions.push(sql`a.sentiment = ${sentiment}`);
  if (severity) conditions.push(sql`a.severity = ${severity}`);
  if (status) conditions.push(sql`a.status = ${status}`);
  if (visibility && allowedVisibilities.includes(visibility)) {
    conditions.push(sql`a.visibility = ${visibility}`);
  }

  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    conditions.push(sql`(
      a.title ILIKE ${term}
      OR a.observation_text ILIKE ${term}
      OR EXISTS (
        SELECT 1
        FROM public.students st_search
        JOIN public.persons p_search ON p_search.id = st_search.person_id
        WHERE st_search.id = a.student_id
          AND (
            p_search.display_name ILIKE ${term}
            OR p_search.first_name ILIKE ${term}
            OR p_search.last_name ILIKE ${term}
            OR st_search.admission_no ILIKE ${term}
          )
      )
    )`);
  }

  const whereClause = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  const [countResult] = await sql`
    SELECT count(*)::int AS total
    FROM public.anecdotes a
    WHERE ${whereClause}
  `;

  const rows = await sql`
    SELECT
      a.id,
      a.school_id,
      a.student_id,
      a.class_section_id,
      a.title,
      a.observation_text,
      a.context,
      a.observation_type,
      a.category_id,
      cat.name AS category_name,
      cat.code AS category_code,
      cat.color AS category_color,
      cat.icon AS category_icon,
      a.subcategory_id,
      sub.name AS subcategory_name,
      sub.code AS subcategory_code,
      a.sentiment,
      a.severity,
      a.visibility,
      a.status,
      a.inferred_metadata,
      a.observed_at,
      a.created_at,
      a.updated_at,
      a.created_by,
      creator_person.display_name AS created_by_name,
      student_person.display_name AS student_name,
      student_person.photo_url AS student_photo_url,
      student.admission_no,
      student.admission_no AS student_admission_no,
      c.name AS class_name,
      sec.name AS section_name,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', e.id,
              'evidence_type', e.evidence_type,
              'file_url', e.file_url,
              'file_name', e.file_name,
              'mime_type', e.mime_type
            )
          )
          FROM public.anecdote_evidence e
          WHERE e.anecdote_id = a.id
        ),
        '[]'::json
      ) AS evidence,
      COALESCE(
        (
          SELECT array_agg(t.tag_name)
          FROM public.anecdote_tags t
          WHERE t.anecdote_id = a.id
        ),
        ARRAY[]::varchar[]
      ) AS tags
    FROM public.anecdotes a
    LEFT JOIN public.anecdote_categories cat ON cat.id = a.category_id
    LEFT JOIN public.anecdote_subcategories sub ON sub.id = a.subcategory_id
    LEFT JOIN public.users creator_user ON creator_user.id = a.created_by
    LEFT JOIN public.persons creator_person ON creator_person.id = creator_user.person_id
    LEFT JOIN public.students student ON student.id = a.student_id
    LEFT JOIN public.persons student_person ON student_person.id = student.person_id
    LEFT JOIN public.class_sections cs ON cs.id = a.class_section_id
    LEFT JOIN public.classes c ON c.id = cs.class_id
    LEFT JOIN public.sections sec ON sec.id = cs.section_id
    WHERE ${whereClause}
    ORDER BY a.observed_at DESC, a.created_at DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  return {
    items: rows,
    total: countResult?.total || 0,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil((countResult?.total || 0) / safeLimit),
  };
}

/**
 * Fetch a single anecdote by ID with its evidence and follow-ups.
 */
export async function getAnecdoteById({ schoolId, id, userRoles = [] }) {
  const isParent = userRoles.includes('parent');
  const isStudent = userRoles.includes('student');

  const [anecdote] = await sql`
    SELECT
      a.*,
      cat.name AS category_name,
      cat.code AS category_code,
      cat.color AS category_color,
      cat.icon AS category_icon,
      sub.name AS subcategory_name,
      sub.code AS subcategory_code,
      creator_person.display_name AS created_by_name,
      student_person.display_name AS student_name,
      student_person.photo_url AS student_photo_url,
      student.admission_no,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', e.id,
              'evidence_type', e.evidence_type,
              'file_url', e.file_url,
              'file_name', e.file_name,
              'file_size', e.file_size,
              'mime_type', e.mime_type,
              'created_at', e.created_at
            )
          )
          FROM public.anecdote_evidence e
          WHERE e.anecdote_id = a.id
        ),
        '[]'::json
      ) AS evidence,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', f.id,
              'due_date', to_char(f.due_date, 'YYYY-MM-DD'),
              'status', f.status,
              'notes', f.notes,
              'assigned_to_name', p_assigned.display_name,
              'completed_at', f.completed_at
            )
          )
          FROM public.anecdote_followups f
          LEFT JOIN public.users u_assigned ON u_assigned.id = f.assigned_to_user_id
          LEFT JOIN public.persons p_assigned ON p_assigned.id = u_assigned.person_id
          WHERE f.anecdote_id = a.id
        ),
        '[]'::json
      ) AS followups,
      COALESCE(
        (
          SELECT array_agg(t.tag_name)
          FROM public.anecdote_tags t
          WHERE t.anecdote_id = a.id
        ),
        ARRAY[]::varchar[]
      ) AS tags
    FROM public.anecdotes a
    LEFT JOIN public.anecdote_categories cat ON cat.id = a.category_id
    LEFT JOIN public.anecdote_subcategories sub ON sub.id = a.subcategory_id
    LEFT JOIN public.users creator_user ON creator_user.id = a.created_by
    LEFT JOIN public.persons creator_person ON creator_person.id = creator_user.person_id
    LEFT JOIN public.students student ON student.id = a.student_id
    LEFT JOIN public.persons student_person ON student_person.id = student.person_id
    WHERE a.school_id = ${schoolId}
      AND a.id = ${id}
      AND a.deleted_at IS NULL
    LIMIT 1
  `;

  if (!anecdote) return null;

  // Enforce visibility
  if (isParent && anecdote.visibility !== 'PARENT_VISIBLE') {
    return null;
  }
  if (isStudent && anecdote.visibility !== 'STUDENT_VISIBLE') {
    return null;
  }

  return anecdote;
}

/**
 * Update an existing anecdote observation with audit logging.
 */
export async function updateAnecdote({ schoolId, id, userId, updates, ipAddress = null }) {
  const [existing] = await sql`
    SELECT *
    FROM public.anecdotes
    WHERE school_id = ${schoolId}
      AND id = ${id}
      AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!existing) {
    throw new Error('Anecdote not found');
  }

  const {
    title,
    observation_text,
    context,
    observation_type,
    category_id,
    subcategory_id,
    sentiment,
    severity,
    visibility,
    status,
    tags,
  } = updates;

  const nextTitle = title !== undefined ? title : existing.title;
  const nextText = observation_text !== undefined ? observation_text.trim() : existing.observation_text;
  const nextContext = context !== undefined ? normalizeAnecdoteContext(context, existing.context) : existing.context;
  const nextType = observation_type !== undefined ? observation_type : existing.observation_type;
  const nextCategoryId = category_id !== undefined ? category_id : existing.category_id;
  const nextSubcategoryId = subcategory_id !== undefined ? subcategory_id : existing.subcategory_id;
  const nextSentiment = sentiment !== undefined ? sentiment : existing.sentiment;
  const nextSeverity = severity !== undefined ? severity : existing.severity;
  const nextVisibility = visibility !== undefined ? visibility : existing.visibility;
  const nextStatus = status !== undefined ? status : existing.status;

  const [updated] = await sql`
    UPDATE public.anecdotes
    SET
      title = ${nextTitle},
      observation_text = ${nextText},
      context = ${nextContext},
      observation_type = ${nextType},
      category_id = ${nextCategoryId},
      subcategory_id = ${nextSubcategoryId},
      sentiment = ${nextSentiment},
      severity = ${nextSeverity},
      visibility = ${nextVisibility},
      status = ${nextStatus},
      updated_by = ${userId},
      updated_at = now()
    WHERE school_id = ${schoolId}
      AND id = ${id}
    RETURNING *
  `;

  if (Array.isArray(tags)) {
    await sql`DELETE FROM public.anecdote_tags WHERE anecdote_id = ${id} AND school_id = ${schoolId}`;
    const cleanTags = tags.filter(Boolean).map((t) => String(t).trim().toLowerCase());
    if (cleanTags.length > 0) {
      await sql`
        INSERT INTO public.anecdote_tags (school_id, anecdote_id, tag_name)
        SELECT ${schoolId}, ${id}, unnest(${cleanTags}::text[])
        ON CONFLICT DO NOTHING
      `;
    }
  }

  // Audit log
  const changedFields = {};
  if (nextCategoryId !== existing.category_id) changedFields.category_id = nextCategoryId;
  if (nextSeverity !== existing.severity) changedFields.severity = nextSeverity;
  if (nextVisibility !== existing.visibility) changedFields.visibility = nextVisibility;
  if (nextStatus !== existing.status) changedFields.status = nextStatus;

  await logAnecdoteAudit({
    schoolId,
    anecdoteId: id,
    action: 'UPDATED',
    changedFields,
    previousState: existing,
    newState: updated,
    performedBy: userId,
    ipAddress,
  });

  // Emit event for rule re-evaluation
  emitSchoolEvent(AUTOMATION_EVENTS.ANECDOTE_UPDATED, {
    schoolId,
    studentId: updated.student_id,
    anecdoteId: id,
    severity: nextSeverity,
  });

  return updated;
}

/**
 * Soft-delete / archive an anecdote.
 */
export async function archiveAnecdote({ schoolId, id, userId, ipAddress = null }) {
  const [archived] = await sql`
    UPDATE public.anecdotes
    SET
      status = 'ARCHIVED',
      deleted_at = now(),
      updated_by = ${userId},
      updated_at = now()
    WHERE school_id = ${schoolId}
      AND id = ${id}
      AND deleted_at IS NULL
    RETURNING id, student_id
  `;

  if (!archived) throw new Error('Anecdote not found or already archived');

  await logAnecdoteAudit({
    schoolId,
    anecdoteId: id,
    action: 'ARCHIVED',
    performedBy: userId,
    ipAddress,
  });

  return { success: true, id };
}

/**
 * Attach evidence to an Anecdote.
 */
export async function addEvidence({ schoolId, anecdoteId, userId, evidenceData }) {
  const {
    evidence_type,
    file_url = null,
    storage_path = null,
    file_name = null,
    file_size = null,
    mime_type = null,
    metadata = {},
  } = evidenceData;

  const [row] = await sql`
    INSERT INTO public.anecdote_evidence (
      school_id,
      anecdote_id,
      evidence_type,
      file_url,
      storage_path,
      file_name,
      file_size,
      mime_type,
      metadata,
      created_by
    ) VALUES (
      ${schoolId},
      ${anecdoteId},
      ${evidence_type},
      ${file_url},
      ${storage_path},
      ${file_name},
      ${file_size},
      ${mime_type},
      ${sql.json(metadata)},
      ${userId}
    )
    RETURNING *
  `;

  return row;
}

/**
 * Create a follow-up action for an Anecdote.
 */
export async function createFollowUp({ schoolId, anecdoteId, userId, followUpData }) {
  const {
    assigned_to_user_id = null,
    due_date,
    notes = null,
  } = followUpData;

  if (!due_date) throw new Error('Follow-up due date is required');

  const [row] = await sql`
    INSERT INTO public.anecdote_followups (
      school_id,
      anecdote_id,
      assigned_to_user_id,
      due_date,
      status,
      notes,
      created_by
    ) VALUES (
      ${schoolId},
      ${anecdoteId},
      ${assigned_to_user_id},
      ${due_date},
      'PENDING',
      ${notes},
      ${userId}
    )
    RETURNING *
  `;

  // Also update parent anecdote status to FOLLOW_UP_REQUIRED if currently ACTIVE
  await sql`
    UPDATE public.anecdotes
    SET status = 'FOLLOW_UP_REQUIRED', updated_at = now()
    WHERE id = ${anecdoteId} AND status = 'ACTIVE'
  `;

  await notifyFollowUpAssigned({
    schoolId,
    assignedUserId: assigned_to_user_id,
    dueDate: due_date,
  });

  return row;
}

export async function completeFollowUp({ schoolId, anecdoteId, followUpId, userId, notes = null }) {
  const [row] = await sql`
    UPDATE public.anecdote_followups
    SET
      status = 'COMPLETED',
      notes = COALESCE(${notes}, notes),
      completed_at = now(),
      updated_at = now()
    WHERE school_id = ${schoolId}
      AND anecdote_id = ${anecdoteId}
      AND id = ${followUpId}
    RETURNING *
  `;

  if (!row) throw new Error('Follow-up not found');

  await logAnecdoteAudit({
    schoolId,
    anecdoteId,
    action: 'FOLLOW_UP_COMPLETED',
    newState: { followup_id: followUpId, status: 'COMPLETED' },
    performedBy: userId,
  });

  return row;
}

/**
 * Unified Student Intelligence Timeline.
 * Synthesizes chronological observations, academic signals, attendance drops, achievements, and interventions.
 */
export async function getStudentTimeline({
  schoolId,
  studentId,
  page = 1,
  limit = 20,
  filterCategory = null, // 'ALL', 'ACADEMIC', 'BEHAVIOUR', 'SOCIAL', 'ACHIEVEMENT', 'ATTENDANCE', 'INTERVENTIONS'
  userRoles = [],
}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const isFamily = isFamilyRole(userRoles);
  const allowedVisibilities = isFamily
    ? (userRoles.includes('student') || userRoles.includes('students')
      ? ['STUDENT_VISIBLE', 'PARENT_VISIBLE']
      : ['PARENT_VISIBLE'])
    : ['STAFF_ONLY', 'COORDINATOR_ONLY', 'SCHOOL_ADMIN', 'PARENT_VISIBLE', 'STUDENT_VISIBLE'];

  const fetchLimit = Math.min(100, offset + safeLimit);

  // Fetch anecdotes
  const anecdotes = await sql`
    SELECT
      a.id,
      'ANECDOTE'::text AS event_type,
      a.observed_at AS event_date,
      a.title,
      a.observation_text AS description,
      a.observation_type,
      a.sentiment,
      a.severity,
      a.context,
      cat.name AS category_name,
      cat.code AS category_code,
      cat.color AS category_color,
      cat.icon AS category_icon,
      sub.name AS subcategory_name,
      creator_person.display_name AS author_name,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', e.id,
              'evidence_type', e.evidence_type,
              'file_url', e.file_url,
              'file_name', e.file_name
            )
          )
          FROM public.anecdote_evidence e
          WHERE e.anecdote_id = a.id
        ),
        '[]'::json
      ) AS evidence
    FROM public.anecdotes a
    LEFT JOIN public.anecdote_categories cat ON cat.id = a.category_id
    LEFT JOIN public.anecdote_subcategories sub ON sub.id = a.subcategory_id
    LEFT JOIN public.users creator_user ON creator_user.id = a.created_by
    LEFT JOIN public.persons creator_person ON creator_person.id = creator_user.person_id
    WHERE a.school_id = ${schoolId}
      AND a.student_id = ${studentId}
      AND a.deleted_at IS NULL
      AND a.visibility IN ${sql(allowedVisibilities)}
    ORDER BY a.observed_at DESC
    LIMIT ${fetchLimit}
  `;

  let interventions = [];
  let signals = [];
  let insights = [];
  let outcomes = [];

  if (!isFamily) {
    interventions = await sql`
      SELECT
        i.id,
        'INTERVENTION'::text AS event_type,
        i.created_at AS event_date,
        i.title,
        i.description,
        i.action_type AS observation_type,
        'ATTENTION'::text AS sentiment,
        'LEVEL_2_WATCH'::text AS severity,
        'support'::text AS context,
        'Intervention'::text AS category_name,
        'INTERVENTION'::text AS category_code,
        '#0D9488'::text AS category_color,
        'git-branch-outline'::text AS category_icon,
        i.status AS subcategory_name,
        p.display_name AS author_name,
        '[]'::json AS evidence
      FROM public.student_interventions i
      LEFT JOIN public.users u ON u.id = i.created_by
      LEFT JOIN public.persons p ON p.id = u.person_id
      WHERE i.school_id = ${schoolId}
        AND i.student_id = ${studentId}
      ORDER BY i.created_at DESC
      LIMIT ${fetchLimit}
    `;

    signals = await sql`
      SELECT
        s.id,
        CASE
          WHEN s.source_module = 'ATTENDANCE' THEN 'ATTENDANCE_SIGNAL'
          WHEN s.source_module = 'EXAMS' THEN 'ACADEMIC_SIGNAL'
          ELSE 'SIGNAL'
        END::text AS event_type,
        s.detected_at AS event_date,
        s.signal_type AS title,
        COALESCE(s.metadata->>'note', s.signal_type) AS description,
        s.signal_type AS observation_type,
        CASE WHEN s.severity IN ('LEVEL_1_POSITIVE') THEN 'POSITIVE' ELSE 'ATTENTION' END::text AS sentiment,
        s.severity,
        s.source_module AS context,
        s.source_module AS category_name,
        s.source_module AS category_code,
        '#2563EB'::text AS category_color,
        'pulse-outline'::text AS category_icon,
        s.confidence AS subcategory_name,
        'SchoolIMS'::text AS author_name,
        '[]'::json AS evidence
      FROM public.intelligence_signals s
      WHERE s.school_id = ${schoolId}
        AND s.student_id = ${studentId}
      ORDER BY s.detected_at DESC
      LIMIT ${fetchLimit}
    `;

    insights = await sql`
      SELECT
        i.id,
        'INSIGHT'::text AS event_type,
        i.created_at AS event_date,
        i.title,
        i.summary AS description,
        i.insight_type AS observation_type,
        CASE WHEN i.insight_type IN ('GROWTH', 'STRENGTH') THEN 'POSITIVE' ELSE 'ATTENTION' END::text AS sentiment,
        CASE
          WHEN i.insight_type = 'CRITICAL_REVIEW' THEN 'LEVEL_4_CRITICAL'
          WHEN i.insight_type = 'ATTENTION' THEN 'LEVEL_3_ATTENTION'
          WHEN i.insight_type IN ('GROWTH', 'STRENGTH') THEN 'LEVEL_1_POSITIVE'
          ELSE 'LEVEL_2_WATCH'
        END::text AS severity,
        'intelligence'::text AS context,
        i.insight_type AS category_name,
        i.rule_code AS category_code,
        '#8B5CF6'::text AS category_color,
        'sparkles-outline'::text AS category_icon,
        i.confidence AS subcategory_name,
        'Rule Engine'::text AS author_name,
        '[]'::json AS evidence
      FROM public.intelligence_insights i
      WHERE i.school_id = ${schoolId}
        AND i.student_id = ${studentId}
        AND i.status IN ('ACTIVE', 'ACKNOWLEDGED', 'INTERVENTION_IN_PROGRESS')
      ORDER BY i.created_at DESC
      LIMIT ${fetchLimit}
    `;

    outcomes = await sql`
      SELECT
        o.id,
        'OUTCOME'::text AS event_type,
        o.recorded_at AS event_date,
        'Improvement observed following the intervention'::text AS title,
        COALESCE(o.notes, 'Outcome recorded') AS description,
        o.outcome_status AS observation_type,
        CASE WHEN o.outcome_status = 'EFFECTIVE' THEN 'POSITIVE' ELSE 'NEUTRAL' END::text AS sentiment,
        'LEVEL_0_INFORMATIONAL'::text AS severity,
        'outcome'::text AS context,
        'Outcome'::text AS category_name,
        'OUTCOME'::text AS category_code,
        '#059669'::text AS category_color,
        'flag-outline'::text AS category_icon,
        o.outcome_status AS subcategory_name,
        p.display_name AS author_name,
        '[]'::json AS evidence
      FROM public.anecdote_outcomes o
      LEFT JOIN public.users u ON u.id = o.recorded_by
      LEFT JOIN public.persons p ON p.id = u.person_id
      WHERE o.school_id = ${schoolId}
        AND (
          o.intervention_id IN (
            SELECT id FROM public.student_interventions
            WHERE school_id = ${schoolId} AND student_id = ${studentId}
          )
          OR o.anecdote_id IN (
            SELECT id FROM public.anecdotes
            WHERE school_id = ${schoolId} AND student_id = ${studentId} AND deleted_at IS NULL
          )
        )
      ORDER BY o.recorded_at DESC
      LIMIT ${fetchLimit}
    `;
  } else {
    insights = await sql`
      SELECT
        i.id,
        'INSIGHT'::text AS event_type,
        i.created_at AS event_date,
        i.title,
        i.summary AS description,
        i.insight_type AS observation_type,
        'POSITIVE'::text AS sentiment,
        'LEVEL_1_POSITIVE'::text AS severity,
        'progress'::text AS context,
        i.insight_type AS category_name,
        i.rule_code AS category_code,
        '#10B981'::text AS category_color,
        'sparkles-outline'::text AS category_icon,
        i.confidence AS subcategory_name,
        'School'::text AS author_name,
        '[]'::json AS evidence
      FROM public.intelligence_insights i
      WHERE i.school_id = ${schoolId}
        AND i.student_id = ${studentId}
        AND i.parent_visible = true
        AND i.insight_type IN ('GROWTH', 'STRENGTH')
      ORDER BY i.created_at DESC
      LIMIT ${fetchLimit}
    `;
  }

  let combined = [...anecdotes, ...interventions, ...signals, ...insights, ...outcomes];

  const filter = String(filterCategory || 'ALL').toUpperCase();
  if (filter && filter !== 'ALL') {
    combined = combined.filter((item) => {
      if (filter === 'INTERVENTIONS' || filter === 'INTERVENTION') {
        return item.event_type === 'INTERVENTION' || item.event_type === 'OUTCOME';
      }
      if (filter === 'OBSERVATIONS') return item.event_type === 'ANECDOTE';
      if (filter === 'ACADEMIC') {
        return item.event_type === 'ACADEMIC_SIGNAL' || item.category_code === 'ACADEMIC' || item.category_code === 'EXAMS';
      }
      if (filter === 'ATTENDANCE') {
        return item.event_type === 'ATTENDANCE_SIGNAL' || item.category_code === 'ATTENDANCE';
      }
      return item.category_code === filter || item.event_type === filter;
    });
  }

  combined.sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime());
  const paged = combined.slice(offset, offset + safeLimit);

  return {
    items: paged,
    page: safePage,
    limit: safeLimit,
    hasMore: combined.length > offset + safeLimit,
  };
}
