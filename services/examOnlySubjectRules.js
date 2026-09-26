/** Pure rules for exam-only special subjects. No database access. */

export class ExamOnlySubjectError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = 'ExamOnlySubjectError';
    this.status = status;
    this.details = details;
  }
}

const ABSENT_MARKS = new Set(['A', 'AB']);

export function normalizeSubjectName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function isAdminMarksOverride(user) {
  return Boolean(user?.roles?.includes('admin'));
}

/** A class-wide target overlaps every section of that class. */
export function scopesOverlap(left, right) {
  if (String(left.class_id) !== String(right.class_id)) return false;
  if (!left.class_section_id || !right.class_section_id) return true;
  return String(left.class_section_id) === String(right.class_section_id);
}

export function validateSpecialSubjectSpecs(raw) {
  if (!Array.isArray(raw)) {
    throw new ExamOnlySubjectError('Special subjects must be a list');
  }

  const specs = raw.map((item) => {
    const name = normalizeSubjectName(item?.name);
    if (!name) throw new ExamOnlySubjectError('Subject name is required');
    if (name.length > 100) {
      throw new ExamOnlySubjectError('Subject name must be 100 characters or fewer');
    }

    const maxMarks = Number(item?.max_marks);
    const passingMarks = Number(item?.passing_marks);
    if (!Number.isFinite(maxMarks) || maxMarks <= 0) {
      throw new ExamOnlySubjectError('Maximum marks must be greater than zero');
    }
    if (!Number.isFinite(passingMarks) || passingMarks < 0 || passingMarks > maxMarks) {
      throw new ExamOnlySubjectError('Passing marks must be between 0 and maximum marks');
    }

    const targets = Array.isArray(item?.targets) ? item.targets : [];
    if (targets.length === 0) {
      throw new ExamOnlySubjectError(`Choose at least one class or section for ${name}`);
    }

    const normalizedTargets = targets.map((target) => {
      const classId = String(target?.class_id || '').trim();
      if (!classId) throw new ExamOnlySubjectError(`Each target for ${name} needs a class`);
      const sectionId = target?.class_section_id ? String(target.class_section_id) : null;
      return {
        id: target?.id ? String(target.id) : null,
        class_id: classId,
        class_section_id: sectionId,
      };
    });

    return {
      name,
      max_marks: maxMarks,
      passing_marks: passingMarks,
      targets: normalizedTargets,
    };
  });

  const flat = specs.flatMap((spec) => spec.targets.map((target) => ({ name: spec.name, ...target })));
  for (let i = 0; i < flat.length; i += 1) {
    for (let j = i + 1; j < flat.length; j += 1) {
      const sameName = flat[i].name.toLowerCase() === flat[j].name.toLowerCase();
      if (sameName && scopesOverlap(flat[i], flat[j])) {
        throw new ExamOnlySubjectError(
          `Duplicate special subject "${flat[i].name}" for the same class or section`,
        );
      }
    }
  }

  return specs;
}

/**
 * Section-specific papers win over a class-wide paper on the same exam.
 * Two different exams that both apply are ambiguous — never pick one silently.
 */
export function chooseApplicablePaper(papers, classSectionId) {
  const applicable = (papers || []).filter((paper) => (
    !paper.class_section_id || String(paper.class_section_id) === String(classSectionId)
  ));
  const byExam = new Map();
  for (const paper of applicable) {
    const examId = String(paper.exam_id);
    const current = byExam.get(examId);
    const sectionSpecific = paper.class_section_id
      && String(paper.class_section_id) === String(classSectionId);
    if (!current) {
      byExam.set(examId, paper);
      continue;
    }
    const currentSpecific = current.class_section_id
      && String(current.class_section_id) === String(classSectionId);
    if (sectionSpecific && !currentSpecific) byExam.set(examId, paper);
  }
  if (byExam.size > 1) {
    return { ambiguous: true, paper: null, examIds: [...byExam.keys()] };
  }
  const paper = byExam.size === 1 ? [...byExam.values()][0] : null;
  return { ambiguous: false, paper, examIds: [...byExam.keys()] };
}

function componentTotal(result) {
  const fields = [
    'participation_marks',
    'written_work_marks',
    'project_work_marks',
    'slip_test_marks',
  ];
  let sum = 0;
  for (const field of fields) {
    const value = result?.[field];
    if (value == null || value === '') continue;
    if (typeof value === 'string' && ABSENT_MARKS.has(value.trim().toUpperCase())) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new ExamOnlySubjectError('Component marks must be zero or greater');
    }
    sum += parsed;
  }
  return sum;
}

/**
 * Validate obtained marks against the persisted paper maximum.
 * Client max_marks is intentionally unused: released apps send a default
 * (25, or 80 for summative) that must not widen or replace the admin limit.
 */
export function normalizeExamOnlyEntries(results, { assessmentSchema = 'consolidated', configuredMax } = {}) {
  const maximum = Number(configuredMax);
  if (!Number.isFinite(maximum) || maximum <= 0) {
    throw new ExamOnlySubjectError('This paper has no valid maximum marks');
  }
  if (!Array.isArray(results)) {
    throw new ExamOnlySubjectError('results must be an array');
  }

  return results.map((result) => {
    if (!result?.student_id) {
      throw new ExamOnlySubjectError('Every result requires student_id');
    }
    const absent = result.is_absent === true || (
      typeof result.marks === 'string' && ABSENT_MARKS.has(result.marks.trim().toUpperCase())
    );
    if (absent) {
      return { student_id: result.student_id, marks: null, is_absent: true };
    }

    let marks;
    if (assessmentSchema === 'component') {
      const summed = componentTotal(result);
      marks = result.marks == null || result.marks === '' ? summed : Number(result.marks);
    } else {
      marks = Number(result.marks);
    }
    if (!Number.isFinite(marks) || marks < 0 || marks > maximum) {
      throw new ExamOnlySubjectError(`Marks must be between 0 and ${maximum}`);
    }
    return { student_id: result.student_id, marks, is_absent: false };
  });
}

/** Keep a real teaching assignment when the same class and subject also exists as exam-only. */
export function mergeMarksAssignments(teaching = [], specials = []) {
  const seen = new Set(teaching.map((row) => `${row.class_section_id}|${row.subject_id}`));
  const extras = [];
  for (const row of specials) {
    const key = `${row.class_section_id}|${row.subject_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    extras.push({
      class_section_id: row.class_section_id,
      class_id: row.class_id,
      class_name: row.class_name,
      section_id: row.section_id,
      section_name: row.section_name,
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      assignment_id: `${row.class_section_id}-${row.subject_id}`,
      exam_only: true,
    });
  }
  return [...teaching, ...extras];
}
