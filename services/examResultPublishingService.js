import sql from '../db.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';

export class ExamResultPublishingError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function summarizeResultReadiness(rows = [], teacherRows = [], unassignedSectionRows = []) {
  const pendingTeachersByPaper = new Map();
  for (const row of teacherRows) {
    const expectedEntries = Number(row.expected_entries) || 0;
    const enteredEntries = Number(row.entered_entries) || 0;
    const missingEntries = Math.max(expectedEntries - enteredEntries, 0);
    if (missingEntries === 0) continue;

    const paperId = String(row.exam_subject_id);
    const teachers = pendingTeachersByPaper.get(paperId) || [];
    teachers.push({
      teacher_id: row.teacher_id,
      teacher_name: row.teacher_name || 'Teacher',
      section_names: Array.isArray(row.section_names) ? row.section_names : [],
      expected_entries: expectedEntries,
      entered_entries: enteredEntries,
      missing_entries: missingEntries,
    });
    pendingTeachersByPaper.set(paperId, teachers);
  }

  const unassignedSectionsByPaper = new Map();
  for (const row of unassignedSectionRows) {
    const paperId = String(row.exam_subject_id);
    const sections = unassignedSectionsByPaper.get(paperId) || [];
    sections.push({
      section_id: row.section_id,
      section_name: row.section_name,
    });
    unassignedSectionsByPaper.set(paperId, sections);
  }

  const papers = rows.map((row) => {
    const expectedEntries = Number(row.expected_entries) || 0;
    const enteredEntries = Number(row.entered_entries) || 0;
    return {
      exam_subject_id: row.exam_subject_id,
      class_id: row.class_id,
      subject_id: row.subject_id,
      class_name: row.class_name,
      subject_name: row.subject_name,
      expected_entries: expectedEntries,
      entered_entries: enteredEntries,
      missing_entries: Math.max(expectedEntries - enteredEntries, 0),
      complete: expectedEntries === enteredEntries,
      pending_teachers: pendingTeachersByPaper.get(String(row.exam_subject_id)) || [],
      unassigned_sections: unassignedSectionsByPaper.get(String(row.exam_subject_id)) || [],
    };
  });
  const expectedEntries = papers.reduce((sum, paper) => sum + paper.expected_entries, 0);
  const enteredEntries = papers.reduce((sum, paper) => sum + paper.entered_entries, 0);
  const missingEntries = papers.reduce((sum, paper) => sum + paper.missing_entries, 0);

  return {
    ready: papers.length > 0 && expectedEntries > 0 && missingEntries === 0,
    papers_total: papers.length,
    papers_complete: papers.filter((paper) => paper.complete).length,
    expected_entries: expectedEntries,
    entered_entries: enteredEntries,
    missing_entries: missingEntries,
    papers,
  };
}

export async function getExamResultReadiness({ schoolId, examId, db = sql }) {
  const rows = await db`
    SELECT
      es.id AS exam_subject_id,
      es.class_id,
      es.subject_id,
      c.name AS class_name,
      sub.name AS subject_name,
      COUNT(DISTINCT st.id)::int AS expected_entries,
      COUNT(DISTINCT m.student_enrollment_id)::int AS entered_entries
    FROM exam_subjects es
    JOIN exams e
      ON e.id = es.exam_id
     AND e.school_id = ${schoolId}
     AND e.deleted_at IS NULL
    JOIN classes c ON c.id = es.class_id AND c.school_id = ${schoolId}
    JOIN subjects sub ON sub.id = es.subject_id AND sub.school_id = ${schoolId}
    LEFT JOIN class_sections cs
      ON cs.class_id = es.class_id
     AND cs.academic_year_id = e.academic_year_id
     AND cs.school_id = ${schoolId}
     AND cs.deleted_at IS NULL
    LEFT JOIN student_enrollments se
      ON se.class_section_id = cs.id
     AND se.academic_year_id = e.academic_year_id
     AND se.school_id = ${schoolId}
     AND se.status = 'active'
     AND se.deleted_at IS NULL
    LEFT JOIN students st
      ON st.id = se.student_id
     AND st.school_id = ${schoolId}
     AND st.deleted_at IS NULL
     AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    LEFT JOIN marks m
      ON m.exam_subject_id = es.id
     AND m.student_enrollment_id = se.id
     AND m.school_id = ${schoolId}
     AND st.id IS NOT NULL
    WHERE es.exam_id = ${examId}
      AND es.school_id = ${schoolId}
      AND es.deleted_at IS NULL
    GROUP BY es.id, es.class_id, es.subject_id, c.name, sub.name
    ORDER BY c.name, sub.name
  `;

  // Attribute incomplete marks to the teachers assigned to each section. Some
  // schools use Academics mappings while others assign teachers only through
  // the timetable, so both sources must be considered here.
  const teacherRows = await db`
    WITH teaching_assignments AS (
      SELECT DISTINCT
        es.id AS exam_subject_id,
        csub.teacher_id,
        cs.id AS class_section_id
      FROM exam_subjects es
      JOIN exams e
        ON e.id = es.exam_id
       AND e.school_id = ${schoolId}
       AND e.deleted_at IS NULL
      JOIN class_sections cs
        ON cs.class_id = es.class_id
       AND cs.academic_year_id = e.academic_year_id
       AND cs.school_id = ${schoolId}
       AND cs.deleted_at IS NULL
      JOIN class_subjects csub
        ON csub.class_section_id = cs.id
       AND csub.subject_id = es.subject_id
       AND csub.school_id = ${schoolId}
       AND csub.teacher_id IS NOT NULL
       AND csub.deleted_at IS NULL
      WHERE es.exam_id = ${examId}
        AND es.school_id = ${schoolId}
        AND es.deleted_at IS NULL

      UNION

      SELECT DISTINCT
        es.id AS exam_subject_id,
        ts.teacher_id,
        cs.id AS class_section_id
      FROM exam_subjects es
      JOIN exams e
        ON e.id = es.exam_id
       AND e.school_id = ${schoolId}
       AND e.deleted_at IS NULL
      JOIN class_sections cs
        ON cs.class_id = es.class_id
       AND cs.academic_year_id = e.academic_year_id
       AND cs.school_id = ${schoolId}
       AND cs.deleted_at IS NULL
      JOIN timetable_slots ts
        ON ts.class_section_id = cs.id
       AND ts.academic_year_id = e.academic_year_id
       AND ts.subject_id = es.subject_id
       AND ts.school_id = ${schoolId}
       AND ts.teacher_id IS NOT NULL
       AND ts.deleted_at IS NULL
      WHERE es.exam_id = ${examId}
        AND es.school_id = ${schoolId}
        AND es.deleted_at IS NULL
    )
    SELECT
      assignment.exam_subject_id,
      assignment.teacher_id,
      COALESCE(NULLIF(person.display_name, ''), NULLIF(person.first_name, ''), staff.staff_code, 'Teacher') AS teacher_name,
      ARRAY_AGG(DISTINCT section.name ORDER BY section.name) AS section_names,
      COUNT(DISTINCT student.id)::int AS expected_entries,
      COUNT(DISTINCT mark.student_enrollment_id)::int AS entered_entries
    FROM teaching_assignments assignment
    JOIN staff
      ON staff.id = assignment.teacher_id
     AND staff.school_id = ${schoolId}
     AND staff.deleted_at IS NULL
    JOIN persons person
      ON person.id = staff.person_id
     AND person.school_id = ${schoolId}
     AND person.deleted_at IS NULL
    JOIN class_sections class_section
      ON class_section.id = assignment.class_section_id
     AND class_section.school_id = ${schoolId}
     AND class_section.deleted_at IS NULL
    JOIN sections section
      ON section.id = class_section.section_id
     AND section.school_id = ${schoolId}
    LEFT JOIN student_enrollments enrollment
      ON enrollment.class_section_id = assignment.class_section_id
     AND enrollment.school_id = ${schoolId}
     AND enrollment.status = 'active'
     AND enrollment.deleted_at IS NULL
    LEFT JOIN students student
      ON student.id = enrollment.student_id
     AND student.school_id = ${schoolId}
     AND student.deleted_at IS NULL
     AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    LEFT JOIN marks mark
      ON mark.exam_subject_id = assignment.exam_subject_id
     AND mark.student_enrollment_id = enrollment.id
     AND mark.school_id = ${schoolId}
     AND student.id IS NOT NULL
    GROUP BY assignment.exam_subject_id, assignment.teacher_id,
             person.display_name, person.first_name, staff.staff_code
    ORDER BY teacher_name
  `;

  const unassignedSectionRows = await db`
    SELECT
      es.id AS exam_subject_id,
      class_section.section_id,
      section.name AS section_name
    FROM exam_subjects es
    JOIN exams exam
      ON exam.id = es.exam_id
     AND exam.school_id = ${schoolId}
     AND exam.deleted_at IS NULL
    JOIN class_sections class_section
      ON class_section.class_id = es.class_id
     AND class_section.academic_year_id = exam.academic_year_id
     AND class_section.school_id = ${schoolId}
     AND class_section.deleted_at IS NULL
    JOIN sections section
      ON section.id = class_section.section_id
     AND section.school_id = ${schoolId}
    WHERE es.exam_id = ${examId}
      AND es.school_id = ${schoolId}
      AND es.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM class_subjects class_subject
        WHERE class_subject.class_section_id = class_section.id
          AND class_subject.subject_id = es.subject_id
          AND class_subject.school_id = ${schoolId}
          AND class_subject.teacher_id IS NOT NULL
          AND class_subject.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM timetable_slots timetable_slot
        WHERE timetable_slot.class_section_id = class_section.id
          AND timetable_slot.academic_year_id = exam.academic_year_id
          AND timetable_slot.subject_id = es.subject_id
          AND timetable_slot.school_id = ${schoolId}
          AND timetable_slot.teacher_id IS NOT NULL
          AND timetable_slot.deleted_at IS NULL
      )
    ORDER BY section.name
  `;

  return summarizeResultReadiness(rows, teacherRows, unassignedSectionRows);
}

export async function setExamResultsPublished({
  schoolId,
  examId,
  published,
  publishedBy,
  db = sql,
}) {
  const runInTransaction = typeof db.begin === 'function' ? (fn) => db.begin(fn) : (fn) => fn(db);

  return runInTransaction(async (tx) => {
    const [exam] = await tx`
      SELECT id, name, academic_year_id, results_published,
             results_published_at, results_published_by
      FROM exams
      WHERE id = ${examId}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!exam) throw new ExamResultPublishingError('Exam not found', 404);

    const readiness = await getExamResultReadiness({ schoolId, examId, db: tx });
    if (published && !readiness.ready) {
      const message = readiness.papers_total === 0
        ? 'Schedule exam papers before publishing results'
        : readiness.expected_entries === 0
          ? 'No active student mark entries are expected for this exam'
          : `${readiness.missing_entries} mark entr${readiness.missing_entries === 1 ? 'y is' : 'ies are'} still missing`;
      throw new ExamResultPublishingError(message, 409, readiness);
    }

    if (exam.results_published === published) {
      return { exam, readiness, changed: false };
    }

    const [updated] = await tx`
      UPDATE exams
      SET results_published = ${published},
          results_published_at = ${published ? tx`now()` : null},
          results_published_by = ${published ? publishedBy : null}
      WHERE id = ${examId} AND school_id = ${schoolId}
      RETURNING id, name, academic_year_id, results_published,
                results_published_at, results_published_by
    `;

    return { exam: updated, readiness, changed: true };
  });
}
