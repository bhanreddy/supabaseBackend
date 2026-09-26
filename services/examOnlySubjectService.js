import sql from '../db.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';
import {
  ExamOnlySubjectError,
  chooseApplicablePaper,
  isAdminMarksOverride,
  normalizeExamOnlyEntries,
  normalizeSubjectName,
  validateSpecialSubjectSpecs,
} from './examOnlySubjectRules.js';

export {
  ExamOnlySubjectError,
  chooseApplicablePaper,
  isAdminMarksOverride,
  mergeMarksAssignments,
  normalizeExamOnlyEntries,
  validateSpecialSubjectSpecs,
} from './examOnlySubjectRules.js';

async function findOrCreateExamOnlySubject(db, schoolId, name) {
  const [existing] = await db`
    SELECT id, name
    FROM subjects
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      AND is_exam_only = TRUE
      AND lower(btrim(name)) = lower(${name})
    ORDER BY created_at
    LIMIT 1
  `;
  if (existing) return existing;

  const [created] = await db`
    INSERT INTO subjects (school_id, name, is_exam_only)
    VALUES (${schoolId}, ${name}, TRUE)
    RETURNING id, name
  `;
  return created;
}

async function loadExamOnlyPapers(db, schoolId, examId) {
  return db`
    SELECT
      es.id, es.class_id, es.class_section_id, es.subject_id,
      es.max_marks, es.passing_marks, es.subject_name_snapshot,
      COALESCE(es.subject_name_snapshot, subject.name) AS subject_name,
      COALESCE((
        SELECT MAX(mark.marks_obtained)
        FROM marks mark
        WHERE mark.exam_subject_id = es.id
          AND mark.school_id = ${schoolId}
      ), NULL) AS highest_mark,
      EXISTS (
        SELECT 1 FROM marks mark
        WHERE mark.exam_subject_id = es.id AND mark.school_id = ${schoolId}
      ) AS has_marks
    FROM exam_subjects es
    JOIN subjects subject ON subject.id = es.subject_id AND subject.school_id = ${schoolId}
    WHERE es.exam_id = ${examId}
      AND es.school_id = ${schoolId}
      AND es.deleted_at IS NULL
      AND es.is_exam_only = TRUE
  `;
}

function sameScope(paper, target) {
  return String(paper.class_id) === String(target.class_id)
    && (paper.class_section_id || null) === (target.class_section_id || null);
}

function namesMatch(paper, name) {
  const stored = normalizeSubjectName(paper.subject_name_snapshot || paper.subject_name);
  return stored.toLowerCase() === name.toLowerCase();
}

export async function replaceExamOnlySubjects(db, { schoolId, exam, subjects }) {
  if (!exam) throw new ExamOnlySubjectError('Exam not found', 404);
  if (exam.exam_type !== 'special') {
    throw new ExamOnlySubjectError('Special subjects can only be configured on Special Exams', 400);
  }
  if (exam.results_published) {
    throw new ExamOnlySubjectError('Unpublish the exam results before changing special subjects.', 409);
  }

  const specs = validateSpecialSubjectSpecs(subjects);
  const desired = specs.flatMap((spec) => spec.targets.map((target) => ({
    ...target,
    name: spec.name,
    max_marks: spec.max_marks,
    passing_marks: spec.passing_marks,
  })));

  const sectionIds = [...new Set(desired.map((item) => item.class_section_id).filter(Boolean))];
  const classIds = [...new Set(desired.map((item) => item.class_id))];
  const sections = sectionIds.length
    ? await db`
        SELECT id, class_id, academic_year_id
        FROM class_sections
        WHERE school_id = ${schoolId}
          AND deleted_at IS NULL
          AND id = ANY(${sectionIds})
      `
    : [];
  const classes = classIds.length
    ? await db`
        SELECT id FROM classes
        WHERE school_id = ${schoolId} AND deleted_at IS NULL AND id = ANY(${classIds})
      `
    : [];
  const sectionById = new Map(sections.map((section) => [String(section.id), section]));
  const classIdsFound = new Set(classes.map((row) => String(row.id)));

  for (const item of desired) {
    if (!classIdsFound.has(String(item.class_id))) {
      throw new ExamOnlySubjectError('One or more classes were not found for this school', 400);
    }
    if (item.class_section_id) {
      const section = sectionById.get(String(item.class_section_id));
      if (!section || String(section.class_id) !== String(item.class_id)) {
        throw new ExamOnlySubjectError('A selected section does not belong to that class', 400);
      }
      if (String(section.academic_year_id) !== String(exam.academic_year_id)) {
        throw new ExamOnlySubjectError('Selected sections must belong to the exam academic year', 400);
      }
    } else {
      const [yearSection] = await db`
        SELECT id FROM class_sections
        WHERE school_id = ${schoolId}
          AND class_id = ${item.class_id}
          AND academic_year_id = ${exam.academic_year_id}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!yearSection) {
        throw new ExamOnlySubjectError('The selected class has no sections in this academic year', 400);
      }
    }
  }

  const existing = await loadExamOnlyPapers(db, schoolId, exam.id);
  const consumed = new Set();
  const matches = desired.map((item) => {
    const byId = item.id
      ? existing.find((paper) => String(paper.id) === String(item.id) && !consumed.has(String(paper.id)))
      : null;
    const byScope = existing.find((paper) => (
      !consumed.has(String(paper.id))
      && sameScope(paper, item)
      && namesMatch(paper, item.name)
    ));
    const paper = byId || byScope || null;
    if (paper) consumed.add(String(paper.id));
    return { item, paper };
  });

  for (const paper of existing) {
    if (consumed.has(String(paper.id))) continue;
    if (paper.has_marks) {
      throw new ExamOnlySubjectError(
        `Cannot remove ${paper.subject_name}: marks have already been recorded`,
        400,
      );
    }
  }

  for (const { item, paper } of matches) {
    if (!paper) continue;
    if (paper.has_marks && !namesMatch(paper, item.name)) {
      throw new ExamOnlySubjectError(
        `Cannot rename ${paper.subject_name} because marks have already been recorded`,
        400,
      );
    }
    if (paper.highest_mark != null && Number(paper.highest_mark) > item.max_marks) {
      throw new ExamOnlySubjectError(
        `Cannot set max marks below already-recorded marks (${paper.highest_mark})`,
        400,
      );
    }
    if (paper.has_marks && !sameScope(paper, item)) {
      throw new ExamOnlySubjectError(
        `Cannot move ${paper.subject_name} because marks have already been recorded`,
        400,
      );
    }
  }

  for (const paper of existing) {
    if (consumed.has(String(paper.id))) continue;
    await db`
      UPDATE exam_subjects
      SET deleted_at = now()
      WHERE id = ${paper.id} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
  }

  const saved = [];
  for (const { item, paper } of matches) {
    const subject = await findOrCreateExamOnlySubject(db, schoolId, item.name);
    if (paper) {
      const [updated] = await db`
        UPDATE exam_subjects
        SET subject_id = ${subject.id},
            class_id = ${item.class_id},
            class_section_id = ${item.class_section_id},
            max_marks = ${item.max_marks},
            passing_marks = ${item.passing_marks},
            subject_name_snapshot = ${item.name},
            is_exam_only = TRUE,
            marks_responsibility = 'class_teacher'
        WHERE id = ${paper.id} AND school_id = ${schoolId}
        RETURNING id, class_id, class_section_id, subject_id, max_marks, passing_marks, subject_name_snapshot
      `;
      saved.push(updated);
    } else {
      const [inserted] = await db`
        INSERT INTO exam_subjects (
          school_id, exam_id, subject_id, class_id, class_section_id,
          max_marks, passing_marks, is_exam_only, marks_responsibility, subject_name_snapshot
        )
        VALUES (
          ${schoolId}, ${exam.id}, ${subject.id}, ${item.class_id}, ${item.class_section_id},
          ${item.max_marks}, ${item.passing_marks}, TRUE, 'class_teacher', ${item.name}
        )
        RETURNING id, class_id, class_section_id, subject_id, max_marks, passing_marks, subject_name_snapshot
      `;
      saved.push(inserted);
    }
  }

  return saved;
}

export async function resolveLegacyExamOnlyContext(db, {
  schoolId,
  classId,
  classSectionId,
  academicYearId,
  examCategory,
  subExam,
  subjectId,
}) {
  const [subject] = await db`
    SELECT id, is_exam_only
    FROM subjects
    WHERE id = ${subjectId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
  `;
  if (!subject?.is_exam_only) return { kind: 'regular' };

  const papers = await db`
    SELECT
      es.id, es.exam_id, es.class_id, es.class_section_id, es.subject_id,
      es.max_marks, es.passing_marks, es.is_exam_only, es.marks_responsibility,
      es.subject_name_snapshot,
      e.results_published, e.academic_year_id, e.name AS exam_name
    FROM exam_subjects es
    JOIN exams e
      ON e.id = es.exam_id
     AND e.school_id = ${schoolId}
     AND e.deleted_at IS NULL
    WHERE es.school_id = ${schoolId}
      AND es.deleted_at IS NULL
      AND es.is_exam_only = TRUE
      AND es.subject_id = ${subjectId}
      AND es.class_id = ${classId}
      AND e.academic_year_id = ${academicYearId}
      AND e.exam_type = ${examCategory}
      AND e.name = ${subExam}
      AND (es.class_section_id = ${classSectionId} OR es.class_section_id IS NULL)
  `;
  const chosen = chooseApplicablePaper(papers, classSectionId);
  if (chosen.ambiguous) return { kind: 'ambiguous', examIds: chosen.examIds };
  if (!chosen.paper) return { kind: 'missing' };
  return { kind: 'paper', paper: chosen.paper };
}

export async function loadMarksActor(db, { schoolId, userId }) {
  if (!userId) return null;
  const [row] = await db`
    SELECT u.id, u.person_id,
      COALESCE(array_agg(DISTINCT role.code) FILTER (WHERE role.code IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${schoolId}
    LEFT JOIN roles role ON role.id = ur.role_id AND role.school_id = ${schoolId}
    WHERE u.id = ${userId}
      AND u.school_id = ${schoolId}
    GROUP BY u.id, u.person_id
  `;
  if (!row) return null;
  return {
    internal_id: row.id,
    person_id: row.person_id,
    roles: row.roles || [],
  };
}

export async function loadStaffIdForUser(db, { schoolId, personId }) {
  if (!personId) return null;
  const [staff] = await db`
    SELECT id FROM staff
    WHERE person_id = ${personId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return staff?.id ?? null;
}

export async function assertCanWriteExamOnlySection(db, {
  schoolId,
  paper,
  classSectionId,
  academicYearId,
  staffId,
  isAdmin,
}) {
  const [section] = await db`
    SELECT id, class_id, class_teacher_id, academic_year_id
    FROM class_sections
    WHERE id = ${classSectionId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
  `;
  if (!section) return { ok: false, status: 404, error: 'Class section not found' };
  if (String(section.class_id) !== String(paper.class_id)) {
    return { ok: false, status: 403, error: 'This subject is not configured for that class' };
  }
  if (String(section.academic_year_id) !== String(academicYearId)) {
    return { ok: false, status: 403, error: 'This subject is not configured for that academic year' };
  }
  if (paper.class_section_id && String(paper.class_section_id) !== String(section.id)) {
    return { ok: false, status: 403, error: 'This subject is not configured for that section' };
  }
  if (isAdmin) return { ok: true, section };
  if (!staffId || String(section.class_teacher_id || '') !== String(staffId)) {
    return { ok: false, status: 403, error: 'Only the assigned class teacher can enter marks for this subject' };
  }
  return { ok: true, section };
}

export async function listClassTeacherSpecialAssignments(db, { schoolId, staffId }) {
  if (!staffId) return [];
  return db`
    WITH chosen_year AS (
      SELECT ay.id
      FROM academic_years ay
      WHERE ay.school_id = ${schoolId}
      ORDER BY
        CASE WHEN CURRENT_DATE BETWEEN ay.start_date AND ay.end_date THEN 0 ELSE 1 END,
        ay.start_date DESC
      LIMIT 1
    )
    SELECT DISTINCT ON (class_section.id, subject.id)
      class_section.id AS class_section_id,
      class.id AS class_id,
      class.name AS class_name,
      section.id AS section_id,
      section.name AS section_name,
      subject.id AS subject_id,
      COALESCE(paper.subject_name_snapshot, subject.name) AS subject_name
    FROM class_sections class_section
    JOIN chosen_year year ON year.id = class_section.academic_year_id
    JOIN classes class ON class.id = class_section.class_id AND class.school_id = ${schoolId}
    JOIN sections section ON section.id = class_section.section_id AND section.school_id = ${schoolId}
    JOIN exams exam
      ON exam.academic_year_id = class_section.academic_year_id
     AND exam.school_id = ${schoolId}
     AND exam.deleted_at IS NULL
     AND exam.exam_type = 'special'
    JOIN exam_subjects paper
      ON paper.exam_id = exam.id
     AND paper.school_id = ${schoolId}
     AND paper.deleted_at IS NULL
     AND paper.is_exam_only = TRUE
     AND paper.marks_responsibility = 'class_teacher'
     AND paper.class_id = class_section.class_id
     AND (
       paper.class_section_id = class_section.id
       OR (
         paper.class_section_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM exam_subjects section_paper
           WHERE section_paper.exam_id = paper.exam_id
             AND section_paper.class_section_id = class_section.id
             AND section_paper.subject_id = paper.subject_id
             AND section_paper.school_id = ${schoolId}
             AND section_paper.deleted_at IS NULL
             AND section_paper.is_exam_only = TRUE
         )
       )
     )
    JOIN subjects subject ON subject.id = paper.subject_id AND subject.school_id = ${schoolId}
    WHERE class_section.school_id = ${schoolId}
      AND class_section.deleted_at IS NULL
      AND class_section.class_teacher_id = ${staffId}
    ORDER BY class_section.id, subject.id, class.name, section.name, subject.name
  `;
}

async function recordMarkRevision(db, { schoolId, userId, markId, examSubjectId, enrollmentId, previous, next }) {
  if (!previous) return;
  const oldMark = previous.marks_obtained == null ? null : Number(previous.marks_obtained);
  const newMark = next.is_absent ? null : Number(next.marks);
  if (oldMark === newMark && Boolean(previous.is_absent) === Boolean(next.is_absent)) return;
  try {
    await db`
      INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, details)
      VALUES (
        ${schoolId},
        ${userId},
        'marks.revision',
        'marks',
        ${markId}::text,
        ${db.json({
          exam_subject_id: examSubjectId,
          student_enrollment_id: enrollmentId,
          old_mark: previous.marks_obtained,
          new_mark: next.is_absent ? null : next.marks,
          old_is_absent: previous.is_absent,
          new_is_absent: next.is_absent,
          reason: 'Class teacher special-subject update',
        })}
      )
    `;
  } catch {
    // Revision history is best-effort; the mark write itself already records entered_by.
  }
}

export async function saveLegacyExamOnlyUpload(db, {
  schoolId,
  classSection,
  examCategory,
  subExam,
  subjectId,
  results,
  assessmentSchema,
  user,
}) {
  const context = await resolveLegacyExamOnlyContext(db, {
    schoolId,
    classId: classSection.class_id,
    classSectionId: classSection.id,
    academicYearId: classSection.academic_year_id,
    examCategory,
    subExam,
    subjectId,
  });
  if (context.kind === 'ambiguous') {
    return {
      status: 409,
      body: { error: 'More than one special exam matches this class, subject, and name. Ask an admin to remove the duplicate.' },
    };
  }
  if (context.kind === 'missing') {
    return {
      status: 404,
      body: { error: 'No special exam paper is configured for this class and subject' },
    };
  }
  if (context.kind !== 'paper') return null;

  const paper = context.paper;
  if (paper.results_published) {
    return {
      status: 409,
      body: { error: 'Results are published. Ask an admin to unpublish them before changing marks.' },
    };
  }

  const staffId = await loadStaffIdForUser(db, { schoolId, personId: user?.person_id });
  const access = await assertCanWriteExamOnlySection(db, {
    schoolId,
    paper,
    classSectionId: classSection.id,
    academicYearId: classSection.academic_year_id,
    staffId,
    isAdmin: isAdminMarksOverride(user),
  });
  if (!access.ok) return { status: access.status, body: { error: access.error } };

  let normalized;
  try {
    normalized = normalizeExamOnlyEntries(results, {
      assessmentSchema,
      configuredMax: Number(paper.max_marks),
    });
  } catch (error) {
    if (error instanceof ExamOnlySubjectError) {
      return { status: error.status, body: { error: error.message } };
    }
    throw error;
  }

  const enteredBy = user?.internal_id ?? null;
  const processed = [];
  for (const row of normalized) {
    const [enrollment] = await db`
      SELECT se.id
      FROM student_enrollments se
      JOIN students student ON student.id = se.student_id
        AND student.school_id = ${schoolId}
        AND student.deleted_at IS NULL
        AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      WHERE se.student_id = ${row.student_id}
        AND se.class_section_id = ${classSection.id}
        AND se.school_id = ${schoolId}
        AND se.status = 'active'
      LIMIT 1
    `;
    if (!enrollment) {
      processed.push({ student_id: row.student_id, error: 'Active enrollment not found' });
      continue;
    }

    try {
      const [existingMark] = await db`
        SELECT id, marks_obtained, is_absent
        FROM marks
        WHERE exam_subject_id = ${paper.id}
          AND student_enrollment_id = ${enrollment.id}
          AND school_id = ${schoolId}
        LIMIT 1
      `;
      const [markEntry] = await db`
        INSERT INTO marks (
          school_id, exam_subject_id, student_enrollment_id, marks_obtained,
          consolidated_marks_obtained, is_absent, entered_by
        )
        VALUES (
          ${schoolId}, ${paper.id}, ${enrollment.id}, ${row.marks},
          ${row.is_absent ? null : row.marks}, ${row.is_absent}, ${enteredBy}
        )
        ON CONFLICT (school_id, exam_subject_id, student_enrollment_id)
        DO UPDATE SET
          marks_obtained = EXCLUDED.marks_obtained,
          consolidated_marks_obtained = EXCLUDED.consolidated_marks_obtained,
          is_absent = EXCLUDED.is_absent,
          entered_by = EXCLUDED.entered_by,
          updated_at = NOW()
        RETURNING id
      `;
      await recordMarkRevision(db, {
        schoolId,
        userId: enteredBy,
        markId: markEntry.id,
        examSubjectId: paper.id,
        enrollmentId: enrollment.id,
        previous: existingMark,
        next: row,
      });
      processed.push({ student_id: row.student_id, mark_id: markEntry.id, success: true });
    } catch (error) {
      processed.push({ student_id: row.student_id, error: error.message });
    }
  }

  const successful = processed.filter((row) => row.success);
  const payload = {
    message: successful.length === processed.length
      ? 'Marks uploaded successfully'
      : `${successful.length} mark(s) uploaded; ${processed.length - successful.length} failed`,
    exam_id: paper.exam_id,
    exam_subject_id: paper.id,
    uploaded_count: successful.length,
    failed_count: processed.length - successful.length,
    results: processed.map((row) => ({
      student_id: row.student_id,
      mark_id: row.mark_id,
      success: row.success,
      error: row.error,
    })),
  };
  if (successful.length === 0) {
    return {
      status: 422,
      body: {
        error: processed[0]?.error || 'No marks could be uploaded',
        results: payload.results,
      },
    };
  }
  return { status: 200, envelope: true, body: payload };
}

export async function loadLegacyExamOnlyMarks(db, {
  schoolId,
  classSection,
  examCategory,
  subExam,
  subjectId,
  user,
}) {
  const context = await resolveLegacyExamOnlyContext(db, {
    schoolId,
    classId: classSection.class_id,
    classSectionId: classSection.id,
    academicYearId: classSection.academic_year_id,
    examCategory,
    subExam,
    subjectId,
  });
  if (context.kind === 'regular') return null;
  if (context.kind === 'ambiguous') {
    return {
      status: 409,
      body: { error: 'More than one special exam matches this class, subject, and name.' },
    };
  }
  if (context.kind === 'missing') return { status: 200, missing: true };
  const paper = context.paper;
  const staffId = await loadStaffIdForUser(db, { schoolId, personId: user?.person_id });
  const access = await assertCanWriteExamOnlySection(db, {
    schoolId,
    paper,
    classSectionId: classSection.id,
    academicYearId: classSection.academic_year_id,
    staffId,
    isAdmin: isAdminMarksOverride(user),
  });
  if (!access.ok) return { status: access.status, body: { error: access.error } };

  const marks = await db`
    SELECT
      se.student_id,
      m.marks_obtained,
      m.consolidated_marks_obtained,
      m.participation_marks,
      m.written_work_marks,
      m.project_work_marks,
      m.slip_test_marks,
      m.is_absent,
      m.remarks
    FROM student_enrollments se
    JOIN students st ON st.id = se.student_id
      AND st.school_id = ${schoolId}
      AND st.deleted_at IS NULL
      AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    JOIN marks m ON m.student_enrollment_id = se.id AND m.school_id = ${schoolId}
    WHERE se.class_section_id = ${classSection.id}
      AND se.school_id = ${schoolId}
      AND m.exam_subject_id = ${paper.id}
      AND se.status = 'active'
  `;
  return {
    status: 200,
    paper,
    marks,
    maxMarks: Number(paper.max_marks),
  };
}

export async function authorizeExamOnlyMarkRow(db, {
  schoolId,
  paper,
  enrollmentId,
  user,
}) {
  if (!paper?.is_exam_only || paper.marks_responsibility !== 'class_teacher') {
    return { ok: true };
  }
  const [enrollment] = await db`
    SELECT se.id, se.class_section_id, cs.class_id, cs.academic_year_id, exam.academic_year_id AS exam_year_id
    FROM student_enrollments se
    JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id = ${schoolId}
    JOIN exam_subjects es ON es.id = ${paper.id} AND es.school_id = ${schoolId}
    JOIN exams exam ON exam.id = es.exam_id AND exam.school_id = ${schoolId}
    WHERE se.id = ${enrollmentId}
      AND se.school_id = ${schoolId}
      AND se.status = 'active'
    LIMIT 1
  `;
  if (!enrollment) {
    return { ok: false, error: 'Enrollment is not active in this school and exam class/section' };
  }
  const staffId = await loadStaffIdForUser(db, { schoolId, personId: user?.person_id });
  const access = await assertCanWriteExamOnlySection(db, {
    schoolId,
    paper: { ...paper, academic_year_id: enrollment.exam_year_id },
    classSectionId: enrollment.class_section_id,
    academicYearId: enrollment.exam_year_id,
    staffId,
    isAdmin: isAdminMarksOverride(user),
  });
  if (!access.ok) return { ok: false, error: access.error };
  return { ok: true, enrollment };
}

export async function stampUndatedExamOnlyPapers(db, {
  schoolId,
  examId,
  classIds,
  classSectionIds = [],
  mode,
  dates,
  sessions,
}) {
  if (!dates?.length || !classIds?.length) return 0;
  const date = dates[dates.length - 1];
  const session = sessions?.[sessions.length - 1] || sessions?.[0] || {};
  const rows = await db`
    UPDATE exam_subjects es
    SET exam_date = ${date}::date,
        start_time = COALESCE(es.start_time, ${session.start_time || null}::time),
        end_time = COALESCE(es.end_time, ${session.end_time || null}::time)
    WHERE es.exam_id = ${examId}
      AND es.school_id = ${schoolId}
      AND es.deleted_at IS NULL
      AND es.is_exam_only = TRUE
      AND es.exam_date IS NULL
      AND es.class_id = ANY(${classIds})
      AND (
        ${mode !== 'per_section'}
        OR es.class_section_id IS NULL
        OR es.class_section_id = ANY(${classSectionIds})
      )
    RETURNING id
  `;
  return rows.length;
}

export async function loadExamOnlyCoverage(db, { schoolId, examId }) {
  return db`
    SELECT id, class_id, class_section_id, subject_id, exam_date
    FROM exam_subjects
    WHERE exam_id = ${examId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
      AND is_exam_only = TRUE
  `;
}

export { sql };
