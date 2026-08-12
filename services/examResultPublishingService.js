import sql from '../db.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';

export class ExamResultPublishingError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function summarizeResultReadiness(rows = []) {
  const papers = rows.map((row) => {
    const expectedEntries = Number(row.expected_entries) || 0;
    const enteredEntries = Number(row.entered_entries) || 0;
    return {
      exam_subject_id: row.exam_subject_id,
      class_name: row.class_name,
      subject_name: row.subject_name,
      expected_entries: expectedEntries,
      entered_entries: enteredEntries,
      missing_entries: Math.max(expectedEntries - enteredEntries, 0),
      complete: expectedEntries === enteredEntries,
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
    GROUP BY es.id, c.name, sub.name
    ORDER BY c.name, sub.name
  `;

  return summarizeResultReadiness(rows);
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
