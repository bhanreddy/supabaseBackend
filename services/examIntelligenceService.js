import sql from '../db.js';
import { createHash } from 'node:crypto';
import { buildSnapshot, compareSubjects, insightsFor, CALCULATION_VERSION, DEFAULT_POLICY, csvCell, statistics } from './examIntelligenceModel.js';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function failure(message, status = 400) {
  return Object.assign(new Error(message), {
    status
  });
}
export function validateFilters(input = {}) {
  const out = {};
  for (const key of ['academic_year_id', 'exam_id', 'class_section_id', 'subject_id', 'baseline_exam_id', 'baseline_class_section_id', 'student_id']) {
    if (input[key] == null || input[key] === '') continue;
    if (typeof input[key] !== 'string' || !UUID.test(input[key])) throw failure(`Invalid ${key}`);
    out[key] = input[key];
  }
  if (input.exam_type != null && input.exam_type !== '') {
    if (typeof input.exam_type !== 'string' || input.exam_type.length > 100) throw failure('Invalid exam_type');
    out.exam_type = input.exam_type;
  }
  return out;
}
export function validatePolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('Invalid analytics policy');
  const allowed = new Set(['minimum_sample', 'decline_pp', 'participation_attention', 'borderline_pp', 'distinction_percentage', 'eligibility_confirmed', 'required_subject_ids', 'subject_weights', 'class_policies', 'identical_fraction']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw failure('Unknown analytics policy field');
  const out = {};
  for (const [key, min, max] of [['minimum_sample', 2, 100], ['decline_pp', 0, 100], ['participation_attention', 0, 100], ['borderline_pp', 0, 20], ['distinction_percentage', 0, 100], ['identical_fraction', 0.5, 1]]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < min || input[key] > max || key === 'minimum_sample' && !Number.isInteger(input[key])) throw failure(`Invalid policy ${key}`);
      out[key] = input[key];
    }
  }
  if (input.eligibility_confirmed !== undefined) {
    if (typeof input.eligibility_confirmed !== 'boolean') throw failure('Invalid eligibility confirmation');
    out.eligibility_confirmed = input.eligibility_confirmed;
  }
  if (input.required_subject_ids !== undefined) {
    if (!Array.isArray(input.required_subject_ids) || !input.required_subject_ids.length || input.required_subject_ids.length > 50 || input.required_subject_ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(input.required_subject_ids).size !== input.required_subject_ids.length) throw failure('Invalid required subjects');
    out.required_subject_ids = input.required_subject_ids;
  }
  if (input.subject_weights !== undefined) {
    if (!input.subject_weights || Array.isArray(input.subject_weights) || typeof input.subject_weights !== 'object' || Object.entries(input.subject_weights).some(([id, w]) => !UUID.test(id) || typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > 1000)) throw failure('Invalid subject weights');
    out.subject_weights = input.subject_weights;
  }
  if (input.class_policies !== undefined) {
    if (!input.class_policies || typeof input.class_policies !== 'object' || Array.isArray(input.class_policies) || Object.keys(input.class_policies).length > 100) throw failure('Invalid class policies');
    out.class_policies = {};
    for (const [id, p] of Object.entries(input.class_policies)) {
      if (!UUID.test(id) || !p || Object.keys(p).some(key => !['eligibility_confirmed', 'required_subject_ids', 'subject_weights'].includes(key))) throw failure('Invalid class policy');
      out.class_policies[id] = validatePolicy(p);
    }
  }
  return out;
}
export async function capabilities(schoolId, db = sql) {
  const rows = await db`SELECT key,value FROM school_settings WHERE school_id = ${schoolId} AND key IN ('exam_intelligence_enabled','exam_intelligence_policy','result_ranking_method')`;
  const values = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let policy;
  try {
    policy = validatePolicy(JSON.parse(values.exam_intelligence_policy || '{}'));
  } catch {
    throw failure('Analytics policy is invalid. Ask an administrator to review the school configuration.', 409);
  }
  const [schema] = await db`SELECT to_regclass('public.exam_intelligence_saved_views') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='marks' AND column_name='analytics_result_state') AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='student_interventions' AND column_name='academic_context') AS ready`;
  return {
    schema_ready: schema.ready,
    enabled: schema.ready && values.exam_intelligence_enabled === 'true',
    policy: {
      ...DEFAULT_POLICY,
      ...policy
    },
    ranking_method: values.result_ranking_method || 'competition',
    calculation_version: CALCULATION_VERSION
  };
}
export async function configure(schoolId, payload, db = sql) {
  if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') throw failure('enabled must be boolean');
  if (payload.enabled === true && !(await capabilities(schoolId, db)).schema_ready) throw failure('Install the Exam Intelligence migration before enabling the pilot.', 409);
  const pairs = [];
  if (payload.enabled !== undefined) pairs.push(['exam_intelligence_enabled', String(payload.enabled)]);
  if (payload.policy !== undefined) {
    const validated = validatePolicy(payload.policy),
      policies = [validated, ...Object.values(validated.class_policies || {})];
    const ids = [...new Set(policies.flatMap(p => [...(p.required_subject_ids || []), ...Object.keys(p.subject_weights || {})]))];
    if (ids.length) {
      const [{
        n
      }] = await db`SELECT count(*)::int AS n FROM subjects WHERE school_id=${schoolId} AND deleted_at IS NULL AND id=ANY(${db.array(ids)}::uuid[])`;
      if (n !== ids.length) throw failure('Policy refers to a subject outside this school', 404);
    }
    const classes = Object.keys(validated.class_policies || {});
    if (classes.length) {
      const [{
        n
      }] = await db`SELECT count(*)::int AS n FROM classes WHERE school_id=${schoolId} AND id=ANY(${db.array(classes)}::uuid[])`;
      if (n !== classes.length) throw failure('Policy refers to a class outside this school', 404);
    }
    pairs.push(['exam_intelligence_policy', JSON.stringify(validated)]);
  }
  if (!pairs.length) throw failure('No configuration provided');
  for (const [key, value] of pairs) await db`INSERT INTO school_settings(school_id,key,value) VALUES(${schoolId},${key},${value}) ON CONFLICT(school_id,key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return capabilities(schoolId, db);
}
export async function context(schoolId, input = {}, db = sql) {
  const f = validateFilters(input);
  const years = await db`SELECT id,code,start_date,end_date FROM academic_years WHERE school_id = ${schoolId} AND deleted_at IS NULL ORDER BY start_date DESC LIMIT 30`;
  let requestedYear=f.academic_year_id;
  if(!requestedYear && f.exam_id){const [requested]=await db`SELECT academic_year_id FROM exams WHERE school_id=${schoolId} AND id=${f.exam_id} AND deleted_at IS NULL`;if(!requested)throw failure('Examination not found',404);requestedYear=requested.academic_year_id;}
  const year = requestedYear ? years.find(y => y.id === requestedYear) : years.find(y => new Date(y.start_date).toISOString().slice(0, 10) <= new Date().toISOString().slice(0, 10) && new Date(y.end_date).toISOString().slice(0, 10) >= new Date().toISOString().slice(0, 10)) || years[0];
  if (requestedYear && !year) throw failure('Academic year not found', 404);
  if (!year) return {
    years,
    academic_year_id: null,
    exams: [],
    class_sections: [],
    exam_types: [],
    subjects: [],
    owners: []
  };
  const exams = await db`SELECT id,name,exam_type,start_date,end_date,results_published FROM exams WHERE school_id = ${schoolId} AND academic_year_id = ${year.id} AND deleted_at IS NULL AND status::text <> 'cancelled' ${f.exam_type?db`AND exam_type=${f.exam_type}`:db``} ORDER BY start_date DESC NULLS LAST,name LIMIT 250`;
  const configuredTypes=await db`SELECT DISTINCT exam_type FROM exams WHERE school_id=${schoolId} AND academic_year_id=${year.id} AND deleted_at IS NULL AND status::text<>'cancelled' ORDER BY exam_type`;
  const classes = await db`SELECT cs.id,cs.class_id,c.name AS class_name,s.name AS section_name FROM class_sections cs JOIN classes c ON c.id = cs.class_id AND c.school_id = ${schoolId} JOIN sections s ON s.id = cs.section_id AND s.school_id = ${schoolId} WHERE cs.school_id = ${schoolId} AND cs.academic_year_id = ${year.id} AND cs.deleted_at IS NULL ORDER BY c.sort_order NULLS LAST,c.name,s.name LIMIT 250`;
  const subjects = await db`SELECT DISTINCT s.id,s.name FROM subjects s JOIN exam_subjects p ON p.subject_id = s.id AND p.school_id = ${schoolId} JOIN exams e ON e.id = p.exam_id AND e.school_id = ${schoolId} WHERE s.school_id = ${schoolId} AND e.academic_year_id = ${year.id} AND p.deleted_at IS NULL AND e.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY s.name LIMIT 200`;
  const owners = await db`SELECT u.id,p.display_name FROM users u JOIN persons p ON p.id = u.person_id AND p.school_id = ${schoolId} WHERE u.school_id = ${schoolId} AND u.deleted_at IS NULL AND u.account_status::text = 'active' AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.school_id = ${schoolId} WHERE ur.user_id = u.id AND ur.school_id = ${schoolId} AND r.code IN ('admin','staff','teacher','principal')) ORDER BY p.display_name LIMIT 250`;
  const baselineExams = await db`SELECT e.id,e.name,e.exam_type,e.academic_year_id,y.code AS academic_year FROM exams e JOIN academic_years y ON y.id=e.academic_year_id AND y.school_id=${schoolId} WHERE e.school_id=${schoolId} AND e.deleted_at IS NULL AND e.status::text <> 'cancelled' ORDER BY e.start_date DESC NULLS LAST LIMIT 250`;
  const baselineSections = await db`SELECT cs.id,cs.academic_year_id,c.name AS class_name,s.name AS section_name,y.code AS academic_year FROM class_sections cs JOIN classes c ON c.id=cs.class_id AND c.school_id=${schoolId} JOIN sections s ON s.id=cs.section_id AND s.school_id=${schoolId} JOIN academic_years y ON y.id=cs.academic_year_id AND y.school_id=${schoolId} WHERE cs.school_id=${schoolId} AND cs.deleted_at IS NULL ORDER BY y.start_date DESC,c.sort_order NULLS LAST,c.name,s.name LIMIT 500`;
  return {
    years,
    academic_year_id: year.id,
    exams,
    baseline_exams: baselineExams,
    baseline_class_sections: baselineSections,
    class_sections: classes,
    subjects,
    owners,
    exam_types: configuredTypes.map(row=>row.exam_type)
  };
}
export async function snapshot(schoolId, input, db = sql, config, sectionIds) {
  const filters = validateFilters(input);
  if (!filters.exam_id) throw failure('Select an examination');
  const [exam] = await db`SELECT id,name,exam_type,academic_year_id,start_date,end_date,results_published,results_published_at,updated_at FROM exams WHERE id = ${filters.exam_id} AND school_id = ${schoolId} AND deleted_at IS NULL AND status::text <> 'cancelled'`;
  if (!exam || filters.academic_year_id && filters.academic_year_id !== exam.academic_year_id || filters.exam_type && filters.exam_type !== exam.exam_type) throw failure('Examination not found for selected filters', 404);
  if (filters.class_section_id) {
    const [section] = await db`SELECT id FROM class_sections WHERE id = ${filters.class_section_id} AND school_id = ${schoolId} AND academic_year_id = ${exam.academic_year_id} AND deleted_at IS NULL`;
    if (!section) throw failure('Class section not found for examination year', 404);
  }
  if (filters.subject_id) {
    const [subject] = await db`SELECT id FROM subjects WHERE id = ${filters.subject_id} AND school_id = ${schoolId} AND deleted_at IS NULL`;
    if (!subject) throw failure('Subject not found', 404);
  }
  config ||= await capabilities(schoolId, db);
  const grades = await db`SELECT grade,min_percentage,max_percentage FROM grading_scales WHERE school_id = ${schoolId} AND deleted_at IS NULL ORDER BY min_percentage,grade`;
  // One coherent bounded server-side matrix. Nothing resembling a school marks dump is returned to the client.
  const rows = await db`
    WITH effective_papers AS (
      SELECT p.*,cs.id AS section_id_at_exam,c.name AS class_name,s.name AS section_name,
        COALESCE(p.exam_date,${exam.start_date}::date) AS assessment_date,
        CASE WHEN p.exam_date IS NOT NULL THEN 'paper' WHEN ${exam.start_date}::date IS NOT NULL THEN 'exam' ELSE 'unknown' END AS date_source
      FROM exam_subjects p
      JOIN class_sections cs ON cs.class_id = p.class_id AND cs.school_id = ${schoolId} AND cs.academic_year_id = ${exam.academic_year_id} AND cs.deleted_at IS NULL
      JOIN classes c ON c.id = cs.class_id AND c.school_id = ${schoolId}
      JOIN sections s ON s.id = cs.section_id AND s.school_id = ${schoolId}
      WHERE p.school_id = ${schoolId} AND p.exam_id = ${exam.id} AND p.deleted_at IS NULL
        AND (p.class_section_id = cs.id OR (p.class_section_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM exam_subjects override WHERE override.school_id = ${schoolId} AND override.exam_id = p.exam_id AND override.subject_id = p.subject_id AND override.class_section_id = cs.id AND override.deleted_at IS NULL)))
        ${filters.class_section_id ? db`AND cs.id = ${filters.class_section_id}` : db``}
        ${sectionIds?.length ? db`AND cs.id=ANY(${db.array(sectionIds)}::uuid[])` : db``}
    )
    SELECT p.id AS exam_subject_id,p.subject_id,sub.name AS subject_name,p.class_id,p.class_name,p.section_name,
      p.section_id_at_exam AS class_section_id,p.max_marks,p.passing_marks,p.assessment_schema,
      p.participation_max_marks,p.written_work_max_marks,p.project_work_max_marks,p.slip_test_max_marks,
      p.assessment_date,p.date_source,se.id AS enrollment_id,se.student_id,se.start_date AS enrollment_start_date,se.end_date AS enrollment_end_date,st.admission_no,person.display_name,
      m.id AS mark_id,m.marks_obtained,m.is_absent,m.analytics_result_state,m.updated_at AS mark_updated_at,
      m.participation_marks,m.written_work_marks,m.project_work_marks,m.slip_test_marks,
      (COUNT(*) OVER (PARTITION BY p.section_id_at_exam,p.subject_id,se.student_id) > 1) AS duplicate_identity,
      EXISTS(SELECT 1 FROM student_enrollments other WHERE other.school_id = ${schoolId} AND other.student_id = se.student_id AND other.id <> se.id AND other.deleted_at IS NULL AND other.start_date <= p.assessment_date AND (other.end_date IS NULL OR other.end_date >= p.assessment_date)) AS ambiguous_enrollment
    FROM effective_papers p
    JOIN subjects sub ON sub.id = p.subject_id AND sub.school_id = ${schoolId} AND sub.deleted_at IS NULL
    JOIN student_enrollments se ON se.class_section_id = p.section_id_at_exam AND se.school_id = ${schoolId} AND se.academic_year_id = ${exam.academic_year_id}
      AND se.deleted_at IS NULL AND se.start_date <= p.assessment_date AND (se.end_date IS NULL OR se.end_date >= p.assessment_date)
    JOIN students st ON st.id = se.student_id AND st.school_id = ${schoolId} AND st.deleted_at IS NULL
    JOIN persons person ON person.id = st.person_id AND person.school_id = ${schoolId}
    LEFT JOIN marks m ON m.exam_subject_id = p.id AND m.student_enrollment_id = se.id AND m.school_id = ${schoolId}
    ORDER BY p.section_id_at_exam,p.subject_id,se.student_id LIMIT 50001`;
  if (rows.length > 50000) throw failure('This scope exceeds 50,000 scheduled results. Select a class to continue.', 422);
  const [{
    as_of: asOf
  }] = await db`SELECT transaction_timestamp() AS as_of`;
  // Subject selection never changes overall completeness: filter descriptive panels after calculating the whole exam.
  const built = buildSnapshot({
    rows,
    exam,
    policy: config.policy,
    grades,
    rankingMethod: config.ranking_method,
    asOf,
    filters: {
      ...filters,
      academic_year_id: exam.academic_year_id
    }
  });
  if (filters.student_id && !built.students.some(s => s.student_id === filters.student_id)) throw failure('Student not found in the assessment-time cohort', 404);
  if (sectionIds?.length) built.provenance.cohort_section_ids = sectionIds;
  built.provenance.source_revision = createHash('sha256').update(JSON.stringify({
    exam,
    policy: config.policy,
    grades,
    rows
  })).digest('hex');
  const [undated] = await db`SELECT count(*)::int AS n FROM exam_subjects WHERE school_id = ${schoolId} AND exam_id = ${exam.id} AND deleted_at IS NULL AND exam_date IS NULL AND ${exam.start_date}::date IS NULL`;
  if (undated.n) built.provenance.limitations.push(`${undated.n} undated papers cannot resolve a historical cohort and are excluded.`);
  return built;
}
export async function report(schoolId, filters, db = sql, sectionIds) {
  const config = await capabilities(schoolId, db);
  if (!config.enabled) throw failure('Exam Intelligence pilot is disabled for this school', 409);
  const current = await snapshot(schoolId, filters, db, config, sectionIds);
  let baseline = null;
  if (filters.baseline_exam_id) baseline = await snapshot(schoolId, {
    ...filters,
    exam_id: filters.baseline_exam_id,
    academic_year_id: undefined,
    exam_type: undefined,
    class_section_id: filters.baseline_class_section_id || filters.class_section_id,
    student_id: undefined,
    baseline_exam_id: undefined
  }, db, config);
  const comparisons = baseline ? current.subjects.map(s => ({
    key: s.key,
    subject_id: s.subject_id,
    subject_name: s.subject_name,
    class_section_id: s.class_section_id,
    comparison: compareSubjects(s, baseline.subjects.find(b => b.subject_id === s.subject_id && b.class_section_id === (filters.baseline_class_section_id || s.class_section_id)), current.policy)
  })) : [];
  return {
    current,
    baseline,
    comparisons,
    config
  };
}
export function publicReport(result) {
  const {
    current,
    comparisons
  } = result;
  const subjectFilter = current.provenance.filters.subject_id;
  return {
    exam: current.exam,
    summary: current.summary,
    provenance: current.provenance,
    subjects: current.subjects.filter(s => !subjectFilter || s.subject_id === subjectFilter).map(({
      records,
      policy_version,
      ...s
    }) => s),
    comparisons: comparisons.filter(s => !subjectFilter || s.subject_id === subjectFilter).map(s => ({
      ...s,
      comparison: {
        ...s.comparison,
        matched: undefined
      }
    })),
    baseline_revision: result.baseline?.provenance.source_revision || null,
    insights: insightsFor(current, comparisons),
    dependencies: {
      teacher_outcomes: 'Insufficient comparable data: effective-dated historical teacher assignments are not recorded. Current teachers are not attributed to past results.',
      competency: 'Requires validated question-response and curriculum mappings.',
      verification: 'No distinct marks-verification evidence.',
      distinction: current.policy.distinction_percentage == null ? 'No configured distinction threshold.' : null
    }
  };
}
export function studentRows(result, input = {}) {
  const {
    current,
    comparisons
  } = result;
  const page = input.page == null ? 1 : Number(input.page),
    limit = input.limit == null ? 25 : Number(input.limit);
  if (!Number.isInteger(page) || page < 1 || page > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw failure('Invalid page or limit');
  const sort = input.sort || 'name';
  if (!['name', 'percentage', 'support'].includes(sort)) throw failure('Invalid sort');
  const query = String(input.search || '').trim().toLocaleLowerCase();
  if (query.length > 100 || typeof input.search === 'object') throw failure('Invalid search');
  if (input.state && !['assessed', 'absent', 'medical_absence', 'exempt', 'pending', 'withheld', 'invalid', 'unsubmitted', 'support', 'highest', 'lowest', 'borderline', 'next_grade', 'improving', 'declining'].includes(input.state)) throw failure('Invalid result filter');
  const subjectId = current.provenance.filters.subject_id;
  const selectedSubjects = current.subjects.filter(s => !subjectId || s.subject_id === subjectId);
  let students = current.students.filter(s => !query || `${s.display_name} ${s.admission_no}`.toLocaleLowerCase().includes(query));
  if (input.state) students = students.filter(s => s.subjects.some(r => {
    if (subjectId && r.subject_id !== subjectId) return false;
    const subject = selectedSubjects.find(v => v.key === `${r.class_section_id}:${r.subject_id}`);
    if (input.state === 'support') return r.passed === false && r.published;
    if (input.state === 'highest' || input.state === 'lowest') return r.published && r.percentage != null && r.percentage === subject?.statistics[input.state === 'highest' ? 'maximum' : 'minimum'];
    if (input.state === 'next_grade') return r.published && r.next_grade_gap_pp != null && r.next_grade_gap_pp <= current.policy.borderline_pp;
    if (input.state === 'borderline') return r.published && r.state === 'assessed' && subject?.passing_marks != null && Math.abs(r.percentage - subject.passing_marks / subject.max_marks * 100) <= current.policy.borderline_pp;
    if (input.state === 'improving' || input.state === 'declining') {
      const comparison = comparisons.find(c => c.key === subject?.key)?.comparison;
      const delta = comparison?.chronology === 'forward' ? comparison.matched.find(m => m.student_id === s.student_id)?.delta_pp : null;
      return delta != null && (input.state === 'improving' ? delta > 0 : delta < 0);
    }
    return r.state === input.state;
  }));
  students.sort((a, b) => sort === 'percentage' ? (b.percentage ?? -1) - (a.percentage ?? -1) || a.display_name.localeCompare(b.display_name) : sort === 'support' ? b.support_subjects.length - a.support_subjects.length || a.display_name.localeCompare(b.display_name) : a.display_name.localeCompare(b.display_name));
  return {
    page,
    limit,
    total: students.length,
    provenance: current.provenance,
    students: students.slice((page - 1) * limit, page * limit).map(s => ({
      ...s,
      subjects: s.subjects.filter(r => !subjectId || r.subject_id === subjectId).map(r => ({
        subject_id: r.subject_id,
        subject_name: r.subject_name,
        class_section_id: r.class_section_id,
        state: r.state,
        score: r.published ? r.score : null,
        max_marks: r.max_marks,
        percentage: r.published ? r.percentage : null,
        grade: r.grade,
        pass_margin_marks: r.published ? r.pass_margin_marks : null,
        next_grade: r.published ? r.next_grade : null,
        next_grade_gap_pp: r.published ? r.next_grade_gap_pp : null,
        next_grade_gap_marks: r.published ? r.next_grade_gap_marks : null,
        passed: r.published ? r.passed : null,
        published: r.published
      }))
    }))
  };
}
async function assessmentSections(schoolId, studentId, examId, db) {
  const rows = await db`SELECT DISTINCT cs.id FROM student_enrollments se
    JOIN class_sections cs ON cs.id=se.class_section_id AND cs.school_id=${schoolId} AND cs.deleted_at IS NULL
    JOIN exams e ON e.id=${examId} AND e.school_id=${schoolId} AND e.academic_year_id=cs.academic_year_id AND e.deleted_at IS NULL
    JOIN exam_subjects p ON p.exam_id=e.id AND p.class_id=cs.class_id AND p.school_id=${schoolId} AND p.deleted_at IS NULL
      AND (p.class_section_id=cs.id OR (p.class_section_id IS NULL AND NOT EXISTS(SELECT 1 FROM exam_subjects override WHERE override.school_id=${schoolId} AND override.exam_id=e.id AND override.subject_id=p.subject_id AND override.class_section_id=cs.id AND override.deleted_at IS NULL)))
    WHERE se.school_id=${schoolId} AND se.student_id=${studentId} AND se.academic_year_id=e.academic_year_id AND se.deleted_at IS NULL
      AND se.start_date<=COALESCE(p.exam_date,e.start_date) AND (se.end_date IS NULL OR se.end_date>=COALESCE(p.exam_date,e.start_date))`;
  return rows.map(r => r.id);
}
export async function studentProfile(schoolId, filters, db = sql) {
  if (!filters.student_id) throw failure('Select a student');
  const loaded = await report(schoolId, {
      ...filters,
      baseline_exam_id: undefined
    }, db),
    {
      config
    } = loaded;
  let current = loaded.current;
  const currentSections = await assessmentSections(schoolId, filters.student_id, current.exam.id, db);
  if (currentSections.length > 1) {
    current = await snapshot(schoolId, {
      ...filters,
      class_section_id: undefined
    }, db, config, currentSections);
    current.provenance.limitations.push('The student crossed sections during this assessment. Overall results/rank are incomplete; subject benchmarks retain their actual cohort.');
  }
  const student = current.students.find(s => s.student_id === filters.student_id);
  if (!student) throw failure('Student not found in the assessment-time cohort', 404);
  const historyExams = await db`SELECT id,start_date FROM exams WHERE school_id = ${schoolId} AND deleted_at IS NULL AND results_published = true AND start_date <= ${current.exam.start_date}::date AND id <> ${current.exam.id} ORDER BY start_date DESC,id LIMIT 7`;
  const history = [];
  for (const e of historyExams.reverse()) {
    const sections = await assessmentSections(schoolId, student.student_id, e.id, db);
    if (!sections.length) continue;
    const past = await snapshot(schoolId, {
      exam_id: e.id,
      class_section_id: sections.length === 1 ? sections[0] : undefined
    }, db, config, sections);
    const person = past.students.find(s => s.student_id === student.student_id);
    if (person) history.push({
      snapshot: past,
      student: person
    });
  }
  history.push({
    snapshot: current,
    student
  });
  const subjects = student.subjects.filter(r => !filters.subject_id || r.subject_id === filters.subject_id).map(r => {
    const subject = current.subjects.find(s => s.key === `${r.class_section_id}:${r.subject_id}`);
    const points = history.map(({
      snapshot: s,
      student: p
    }) => {
      const candidates = p.subjects.filter(v => v.subject_id === r.subject_id);
      const record = s.exam.id === current.exam.id ? r : candidates.length === 1 ? candidates[0] : null,
        cohort = s.subjects.find(v => v.key === `${record?.class_section_id}:${r.subject_id}`);
      const comparison = compareSubjects(subject, cohort, current.policy);
      const compatible = s.exam.id === current.exam.id || comparison.status !== 'unsuitable' && comparison.chronology === 'forward';
      return {
        exam_id: s.exam.id,
        exam_name: s.exam.name,
        date: cohort?.assessment_date ?? s.exam.start_date,
        class_section_id: record?.class_section_id,
        percentage: record?.published ? record?.percentage ?? null : null,
        passed: record?.published && compatible ? record?.passed ?? null : null,
        cohort_n: cohort?.statistics.n ?? 0,
        source_revision: s.provenance.source_revision,
        class_mean: cohort?.statistics.mean ?? null,
        compatible,
        state: record?.state ?? 'unsubmitted'
      };
    });
    // Only a contiguous three-assessment sequence supports a trend label.
    const temporalPoints = points.filter(p => p.exam_id === current.exam.id || p.date && subject?.assessment_date && new Date(p.date).getTime() < new Date(subject.assessment_date).getTime()).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const latest = temporalPoints.slice(-3),
      chronological = latest.length === 3 && latest.every((p, i) => i === 0 || new Date(p.date).getTime() > new Date(latest[i - 1].date).getTime()),
      downward = chronological && latest.every(p => p.percentage != null && p.compatible) && latest[0].percentage > latest[1].percentage && latest[1].percentage > latest[2].percentage;
    const upward = chronological && latest.every(p => p.percentage != null && p.compatible) && latest[0].percentage < latest[1].percentage && latest[1].percentage < latest[2].percentage;
    const percentages = points.filter(p => p.percentage != null && p.compatible).map(p => p.percentage),
      prior = temporalPoints.at(-2),
      last = temporalPoints.at(-1);
    return {
      key: `${r.class_section_id}:${r.exam_subject_id || r.subject_id}`,
      class_section_id: r.class_section_id,
      cohort_label: `${r.class_name}-${r.section_name}`,
      subject_id: r.subject_id,
      subject_name: r.subject_name,
      state: r.state,
      score: r.published ? r.score : null,
      max_marks: r.max_marks,
      percentage: r.published ? r.percentage : null,
      grade: r.grade,
      passing_marks: subject?.passing_marks,
      benchmark: subject?.statistics,
      deviation_pp: r.published && r.percentage != null && subject?.statistics.mean != null ? r.percentage - subject.statistics.mean : null,
      change_pp: prior?.compatible && last?.compatible && prior?.percentage != null && last?.percentage != null ? last.percentage - prior.percentage : null,
      cohort_change_pp: prior?.compatible && last?.compatible && prior?.class_mean != null && last?.class_mean != null ? last.class_mean - prior.class_mean : null,
      trend: downward ? 'Three-assessment decline' : upward ? 'Three-assessment improvement' : 'No sustained trend established',
      persistent_failure: latest.length === 3 && latest.every(p => p.passed === false && p.compatible),
      standard_deviation_pp: percentages.length >= 3 ? statistics(percentages).standard_deviation : null,
      observed_range_pp: percentages.length ? Math.max(...percentages) - Math.min(...percentages) : null,
      history: points
    };
  });
  const [attendance] = await db`SELECT count(*)::int AS recorded_days,count(*) FILTER(WHERE da.status::text IN ('present','late'))::int AS present_days,count(*) FILTER(WHERE da.status::text = 'absent')::int AS absent_days FROM daily_attendance da JOIN student_enrollments se ON se.id = da.student_enrollment_id AND se.school_id = ${schoolId} WHERE da.school_id = ${schoolId} AND se.student_id = ${student.student_id} AND da.deleted_at IS NULL AND da.attendance_date BETWEEN ${current.exam.start_date}::date AND COALESCE(${current.exam.end_date}::date,${current.exam.start_date}::date)`;
  const {
    subjects: ignored,
    ...identity
  } = student;
  return {
    student: identity,
    subjects,
    attendance: {
      ...attendance,
      scope: 'Recorded attendance during this examination period only; association does not establish causation.'
    },
    provenance: current.provenance,
    timeline: history.map(({
      snapshot: s,
      student: p
    }) => ({
      exam_id: s.exam.id,
      exam_name: s.exam.name,
      date: s.exam.start_date,
      percentage: p.percentage,
      rank: p.rank,
      percentile: p.percentile,
      class_section_id: p.class_section_id
    }))
  };
}
export async function listViews(schoolId, userId, db = sql) {
  return db`SELECT id,name,filters,created_at FROM exam_intelligence_saved_views WHERE school_id=${schoolId} AND user_id=${userId} ORDER BY created_at DESC LIMIT 50`;
}
export async function saveView(schoolId, userId, payload, db = sql) {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name || name.length > 100) throw failure('View name must contain 1–100 characters');
  const filters = validateFilters(payload.filters);
  if (!filters.exam_id) throw failure('A saved view needs an exam');
  await report(schoolId, filters, db);
  const [{
    n
  }] = await db`SELECT count(*)::int AS n FROM exam_intelligence_saved_views WHERE school_id=${schoolId} AND user_id=${userId}`;
  if (n >= 50) throw failure('Saved view limit reached', 422);
  const [view] = await db`INSERT INTO exam_intelligence_saved_views(school_id,user_id,name,filters) VALUES(${schoolId},${userId},${name},${db.json(filters)}) ON CONFLICT(school_id,user_id,name) DO UPDATE SET filters=EXCLUDED.filters RETURNING id,name,filters,created_at`;
  return view;
}
export async function listActions(schoolId, filters, db = sql) {
  const f = validateFilters(filters);
  return db`SELECT i.id,i.student_id,p.display_name,i.title,i.description,i.assigned_to,owner.display_name AS owner_name,i.target_date,i.follow_up_date,i.status,i.measurable_objective,i.academic_context,i.academic_progress_notes,i.outcome_metric,i.created_at FROM student_interventions i
    JOIN students st ON st.id=i.student_id AND st.school_id=${schoolId} JOIN persons p ON p.id=st.person_id AND p.school_id=${schoolId}
    LEFT JOIN users u ON u.id=i.assigned_to AND u.school_id=${schoolId} LEFT JOIN persons owner ON owner.id=u.person_id AND owner.school_id=${schoolId}
    WHERE i.school_id=${schoolId} AND i.academic_context IS NOT NULL ${f.student_id ? db`AND i.student_id=${f.student_id}` : db``}
    ${f.class_section_id ? db`AND i.academic_context->'filters'->>'class_section_id'=${f.class_section_id}` : db``}
    ORDER BY i.created_at DESC LIMIT 50`;
}
export async function createActions(schoolId, userId, payload, db = sql) {
  const filters = validateFilters(payload.filters),
    title = typeof payload.title === 'string' ? payload.title.trim() : '',
    objective = typeof payload.measurable_objective === 'string' ? payload.measurable_objective.trim() : '',
    description = typeof payload.description === 'string' ? payload.description.trim() : '';
  if (!title || title.length > 200 || !objective || objective.length > 2000 || !description || description.length > 5000) throw failure('Provide concern, proposed action and measurable objective within their limits');
  if (typeof payload.target_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.target_date) || !Number.isFinite(Date.parse(payload.target_date)) || new Date(payload.target_date).toISOString().slice(0, 10) !== payload.target_date) throw failure('A valid target date is required');
  const owner = payload.assigned_to || userId;
  if (!UUID.test(owner)) throw failure('Invalid owner');
  const [allowedOwner] = await db`SELECT u.id FROM users u WHERE u.id=${owner} AND u.school_id=${schoolId} AND u.deleted_at IS NULL AND u.account_status::text='active' AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.school_id=${schoolId} WHERE ur.user_id=u.id AND ur.school_id=${schoolId} AND r.code IN ('admin','staff','teacher','principal'))`;
  if (!allowedOwner) throw failure('Owner is not an active academic staff member in this school', 404);
  let result = await report(schoolId, filters, db);
  if (filters.student_id) {
    const sections = await assessmentSections(schoolId, filters.student_id, result.current.exam.id, db);
    if (sections.length > 1) result = await report(schoolId, {
      ...filters,
      class_section_id: undefined
    }, db, sections);
  }
  let targets;
  if (filters.student_id) targets = result.current.students.filter(s => s.student_id === filters.student_id);else if (filters.class_section_id) targets = result.current.students.filter(s => s.support_subjects.some(id => !filters.subject_id || id === filters.subject_id));else throw failure('Select an individual student or a class support cohort');
  if (!targets.length || targets.length > 50) throw failure('Select a support cohort containing 1–50 students', 422);
  const created = [];
  for (const target of targets) {
    const evidence = {
      calculation_version: CALCULATION_VERSION,
      data_as_of: result.current.provenance.data_as_of,
      exam_date: result.current.exam.start_date,
      filters: {
        ...filters,
        student_id: target.student_id
      },
      provenance: result.current.provenance,
      subjects: target.subjects.filter(s => !filters.subject_id || s.subject_id === filters.subject_id).map(r => ({
        subject_id: r.subject_id,
        subject_name: r.subject_name,
        class_id: r.class_id,
        assessment_schema: r.assessment_schema,
        exam_type: result.current.exam.exam_type,
        max_marks: r.max_marks,
        passing_marks: r.passing_marks,
        score: r.published ? r.score : null,
        percentage: r.published ? r.percentage : null,
        state: r.state,
        benchmark: result.current.subjects.find(s => s.key === `${r.class_section_id}:${r.subject_id}`)?.statistics,
        policy_version: result.current.subjects.find(s => s.key === `${r.class_section_id}:${r.subject_id}`)?.policy_version
      })),
      insights: insightsFor(result.current, result.comparisons).filter(i => !i.filters.class_section_id || target.subjects.some(s => s.class_section_id === i.filters.class_section_id)).filter(i => !i.filters.subject_id || target.subjects.some(s => s.subject_id === i.filters.subject_id)).map(i => ({
        rule_id: i.rule_id,
        rule_version: i.rule_version,
        filters: i.filters,
        evidence: i.evidence,
        n: i.n
      })),
      policy_signature: result.current.subjects[0]?.policy_version
    };
    const [row] = await db`INSERT INTO student_interventions(school_id,student_id,created_by,assigned_to,action_type,title,description,target_date,follow_up_date,status,baseline_metric,academic_context,measurable_objective)
      VALUES(${schoolId},${target.student_id},${userId},${owner},'ADDITIONAL_PRACTICE',${title},${description},${payload.target_date}::date,${payload.target_date}::date,'IN_PROGRESS',${db.json({
      exam_id: filters.exam_id
    })},${db.json(evidence)},${objective}) RETURNING id,student_id,title,status`;
    created.push(row);
  }
  return {
    created,
    n: created.length
  };
}
export async function updateAction(schoolId, userId, id, payload, db = sql) {
  if (!UUID.test(id)) throw failure('Invalid action id');
  const [action] = await db`SELECT * FROM student_interventions WHERE id=${id} AND school_id=${schoolId} AND academic_context IS NOT NULL FOR UPDATE`;
  if (!action) throw failure('Support plan not found', 404);
  const statuses = ['IN_PROGRESS', 'FOLLOW_UP', 'COMPLETED', 'CANCELLED'];
  if (payload.status !== undefined && !statuses.includes(payload.status)) throw failure('Invalid action status');
  if (payload.note !== undefined && (typeof payload.note !== 'string' || !payload.note.trim() || payload.note.length > 5000)) throw failure('Progress note must contain 1–5000 characters');
  const notes = [...(action.academic_progress_notes || [])];
  if (notes.length >= 100) throw failure('Progress note history limit reached', 422);
  if (payload.note) notes.push({
    user_id: userId,
    at: new Date().toISOString(),
    note: payload.note.trim()
  });
  let outcome = action.outcome_metric || {};
  if (payload.follow_up_exam_id) {
    if (!UUID.test(payload.follow_up_exam_id)) throw failure('Invalid follow-up examination');
    const baseline = action.academic_context;
    const [followupExam] = await db`SELECT id,start_date FROM exams WHERE id=${payload.follow_up_exam_id} AND school_id=${schoolId} AND deleted_at IS NULL`;
    if (!followupExam) throw failure('Follow-up examination not found', 404);
    if (!followupExam.start_date || !baseline.exam_date || new Date(followupExam.start_date).getTime() <= new Date(baseline.exam_date).getTime()) throw failure('Follow-up must be dated after the baseline examination');
    const followupSections = await assessmentSections(schoolId, action.student_id, followupExam.id, db);
    if (!followupSections.length) {
      const [{
        as_of
      }] = await db`SELECT transaction_timestamp() AS as_of`;
      outcome = {
        exam_id: payload.follow_up_exam_id,
        data_as_of: as_of,
        matched_n: 0,
        attrition_n: 1,
        interpretation: 'No enrollment covered the follow-up assessment period. No result change is inferred.',
        subjects: baseline.subjects.map(s => ({
          subject_id: s.subject_id,
          before_percentage: s.percentage,
          after_percentage: null,
          delta_pp: null,
          comparison_status: 'unsuitable',
          limitations: ['Learner is outside the follow-up cohort.']
        }))
      };
    } else {
      const next = await report(schoolId, {
        ...baseline.filters,
        class_section_id: followupSections.length === 1 ? followupSections[0] : undefined,
        student_id: undefined,
        exam_id: payload.follow_up_exam_id,
        academic_year_id: undefined,
        baseline_exam_id: undefined,
        exam_type: undefined
      }, db, followupSections);
      const target = next.current.students.find(s => s.student_id === action.student_id);
      outcome = {
        exam_id: payload.follow_up_exam_id,
        data_as_of: next.current.provenance.data_as_of,
        source_revision: next.current.provenance.source_revision,
        matched_n: 0,
        eligible_n: target ? 1 : 0,
        attrition_n: target ? 0 : 1,
        interpretation: 'Observed follow-up after support; causation is not established.',
        subjects: baseline.subjects.map(before => {
          const candidates = target?.subjects.filter(s => s.subject_id === before.subject_id) || [];
          const after = candidates.length === 1 ? candidates[0] : null;
          const cohort = next.current.subjects.find(s => s.subject_id === before.subject_id && s.class_id === before.class_id && s.class_section_id === after?.class_section_id);
          const comparison = compareSubjects({
            ...before,
            policy_version: before.policy_version || baseline.policy_signature,
            records: []
          }, cohort, next.current.policy);
          return {
            subject_id: before.subject_id,
            before_percentage: before.percentage,
            after_percentage: after?.published ? after.percentage : null,
            comparison_status: comparison.status,
            limitations: comparison.limitations,
            delta_pp: comparison.status !== 'unsuitable' && before.percentage != null && after?.published && after.percentage != null ? after.percentage - before.percentage : null
          };
        })
      };
      outcome.matched_n = outcome.subjects.some(s => s.delta_pp != null) ? 1 : 0;
      outcome.insufficient_results_n = target && !outcome.matched_n ? 1 : 0;
    }
  }
  const [updated] = await db`UPDATE student_interventions SET status=${payload.status || action.status},academic_progress_notes=${db.json(notes)},outcome_metric=${db.json(outcome)},completed_at=CASE WHEN ${payload.status || action.status}='COMPLETED' THEN COALESCE(completed_at,now()) ELSE NULL END,updated_at=now() WHERE id=${id} AND school_id=${schoolId} RETURNING id,status,academic_progress_notes,outcome_metric`;
  return updated;
}
export function exportReport(result, input = {}) {
  const report = publicReport(result),
    rows = [['SchoolIMS Exam Intelligence', result.current.exam.name], ['Data as of', report.provenance.data_as_of], ['Calculation', CALCULATION_VERSION], ['Source revision', report.provenance.source_revision], ['Filters', JSON.stringify(report.provenance.filters)], ['Publication', report.provenance.publication], ['Cohort', report.provenance.cohort_definition], ['Achievement', report.provenance.achievement_definition], ['Limitations', report.provenance.limitations.join(' ')], [], ['Class', 'Section', 'Subject', 'Max marks', 'Pass marks', 'Assessed n', 'Eligible n', 'Mean %', 'Median %', 'Min %', 'Max %', 'SD pp', 'Q1 %', 'Q3 %', 'Pass numerator', 'Pass denominator', 'Absent', 'Pending', 'Invalid', 'Unsubmitted', 'Matched n', 'Observed growth pp', 'Comparison']];
  for (const s of report.subjects) {
    const c = report.comparisons.find(c => c.key === s.key)?.comparison;
    rows.push([s.class_name, s.section_name, s.subject_name, s.max_marks, s.passing_marks, s.statistics.n, s.eligible_n, s.statistics.mean, s.statistics.median, s.statistics.minimum, s.statistics.maximum, s.statistics.standard_deviation, s.statistics.q1, s.statistics.q3, s.pass.numerator, s.pass.denominator, s.states.absent, s.states.pending, s.states.invalid, s.states.unsubmitted, c?.matched_n, c?.mean_delta_pp, c?.status]);
  }
  if (input.include_students || report.provenance.filters.student_id) {
    if (!report.provenance.filters.class_section_id && !report.provenance.filters.student_id) throw failure('Select a class or student for student export');
    const selectedLearners = result.current.students.filter(s => !report.provenance.filters.student_id || s.student_id === report.provenance.filters.student_id);
    if (selectedLearners.length > 1000) throw failure('Student export exceeds 1,000 learners', 422);
    rows.push([], ['Student ID', 'Admission', 'Name', 'Subject', 'State', 'Obtained', 'Maximum', 'Percentage']);
    for (const student of selectedLearners) for (const s of student.subjects.filter(s => !report.provenance.filters.subject_id || s.subject_id === report.provenance.filters.subject_id)) rows.push([student.student_id, student.admission_no, student.display_name, s.subject_name, s.state, s.published ? s.score : null, s.max_marks, s.published ? s.percentage : null]);
  }
  return {
    filename: `exam-intelligence-${result.current.exam.id}.csv`,
    tabular_rows: rows,
    csv: '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'),
    report
  };
}
export const readSnapshot = (callback, db = sql) => db.begin('isolation level repeatable read read only', async tx => {
  await tx`SET LOCAL statement_timeout = '8000ms'`;
  return callback(tx);
});

/** Compatibility envelope for the existing range chart when the school pilot is enabled. */
export async function legacyAnalyticsReport(schoolId, filters, db = sql) {
  const {
    current
  } = await report(schoolId, filters, db);
  const [classSection] = await db`SELECT cs.id,cs.class_id,cs.academic_year_id,c.name AS class_name,s.name AS section_name,y.code AS academic_year FROM class_sections cs JOIN classes c ON c.id=cs.class_id AND c.school_id=${schoolId} JOIN sections s ON s.id=cs.section_id AND s.school_id=${schoolId} JOIN academic_years y ON y.id=cs.academic_year_id AND y.school_id=${schoolId} WHERE cs.id=${filters.class_section_id} AND cs.school_id=${schoolId} AND cs.deleted_at IS NULL`;
  const selected = current.students.find(s => s.student_id === filters.student_id);
  if (filters.student_id && !selected) throw failure('Student not found in the assessment-time cohort', 404);
  const subjects = current.subjects.map(s => {
    const own = s.records.find(r => r.student_id === filters.student_id),
      validOwn = own?.state === 'assessed' && own?.published;
    return {
      subject_id: s.subject_id,
      subject_name: s.subject_name,
      assessment_schema: s.assessment_schema,
      max_marks: s.max_marks,
      total_students: s.eligible_n,
      graded_students: s.statistics.n,
      lowest_score: s.raw_statistics.minimum,
      highest_score: s.raw_statistics.maximum,
      average_score: s.raw_statistics.mean,
      lowest_percentage: s.statistics.minimum,
      highest_percentage: s.statistics.maximum,
      average_percentage: s.statistics.mean,
      student_score: validOwn ? own.score : null,
      student_percentage: validOwn ? own.percentage : null,
      student_status: !selected ? null : validOwn ? 'graded' : own?.state === 'absent' ? 'absent' : 'missing'
    };
  });
  const sufficient = current.subjects.filter(s => !s.low_sample && s.statistics.mean != null),
    means = sufficient.map(s => s.statistics.mean);
  const namedAt = value => sufficient.filter(s => s.statistics.mean === value).map(s => s.subject_name).join(', ') || null;
  return {
    class_section: classSection,
    exam: current.exam,
    selected_student: selected ? {
      id: selected.student_id,
      admission_no: selected.admission_no,
      display_name: selected.display_name
    } : null,
    subjects,
    summary: {
      subject_count: subjects.length,
      student_count: current.summary.students,
      graded_entries: current.summary.participation.numerator,
      possible_entries: current.summary.entry_completion.denominator,
      completion_percentage: current.summary.entry_completion.percentage || 0,
      strongest_subject: namedAt(Math.max(...means)),
      focus_subject: namedAt(Math.min(...means)),
      student_average_percentage: selected?.percentage ?? null,
      student_above_class_average: selected ? subjects.filter(s => s.student_percentage != null && s.average_percentage != null && s.student_percentage >= s.average_percentage).length : null
    },
    provenance: current.provenance
  };
}
export async function analyticalSearch(schoolId, input, db = sql) {
  const filters = validateFilters(input),
    query = typeof input.search === 'string' ? input.search.trim().toLocaleLowerCase() : '';
  if (query.length < 2 || query.length > 100) throw failure('Search needs 2–100 characters');
  const contextData = await context(schoolId, filters, db),
    hits = [];
  const match = value => String(value).toLocaleLowerCase().includes(query);
  for (const exam of contextData.baseline_exams || contextData.exams) if (match(exam.name)) hits.push({
    type: 'exam',
    id: exam.id,
    label: exam.name,
    filters: {
      exam_id: exam.id,
      academic_year_id: exam.academic_year_id || contextData.academic_year_id
    }
  });
  for (const section of contextData.class_sections) if (match(`${section.class_name}-${section.section_name}`)) hits.push({
    type: 'class',
    id: section.id,
    label: `${section.class_name}-${section.section_name}`,
    filters: {
      ...filters,
      class_section_id: section.id,
      student_id: undefined
    }
  });
  for (const subject of contextData.subjects) if (match(subject.name)) hits.push({
    type: 'subject',
    id: subject.id,
    label: subject.name,
    filters: {
      ...filters,
      subject_id: subject.id,
      student_id: undefined
    }
  });
  if (filters.exam_id) {
    const result = await report(schoolId, filters, db);
    for (const student of result.current.students) if (match(`${student.display_name} ${student.admission_no}`)) hits.push({
      type: 'student',
      id: student.student_id,
      label: `${student.display_name} · ${student.admission_no}`,
      filters: {
        ...filters,
        student_id: student.student_id
      }
    });
  }
  return hits.slice(0, 30);
}
export async function trendHistory(schoolId, filters, db = sql) {
  const loaded = await report(schoolId, filters, db),
    current = loaded.current;
  if (!filters.class_section_id) throw failure('Select a class for the trend explorer');
  const exams = await db`SELECT id FROM exams WHERE school_id=${schoolId} AND academic_year_id=${current.exam.academic_year_id} AND deleted_at IS NULL AND results_published=true AND start_date<=${current.exam.start_date}::date AND id<>${current.exam.id} ORDER BY start_date DESC,id LIMIT 7`;
  const points = [];
  for (const exam of exams.reverse()) {
    const past = await snapshot(schoolId, {
      exam_id: exam.id,
      class_section_id: filters.class_section_id
    }, db, loaded.config);
    points.push({
      exam: past.exam,
      subjects: past.subjects.filter(s => !filters.subject_id || s.subject_id === filters.subject_id).map(s => {
        const now = current.subjects.find(c => c.key === s.key),
          comparison = compareSubjects(now, s, current.policy);
        return {
          subject_id: s.subject_id,
          subject_name: s.subject_name,
          statistics: s.statistics,
          comparison: {
            status: comparison.status,
            matched_n: comparison.matched_n,
            coverage_percentage: comparison.coverage_percentage,
            mean_delta_pp: comparison.mean_delta_pp,
            low_sample: comparison.low_sample
          }
        };
      })
    });
  }
  points.push({
    exam: current.exam,
    subjects: current.subjects.filter(s => !filters.subject_id || s.subject_id === filters.subject_id).map(s => ({
      subject_id: s.subject_id,
      subject_name: s.subject_name,
      statistics: s.statistics,
      comparison: {
        status: 'current',
        matched_n: s.statistics.n,
        coverage_percentage: 100,
        mean_delta_pp: 0,
        low_sample: s.low_sample
      }
    }))
  });
  return {
    points,
    provenance: current.provenance,
    limitations: 'Same-year, dated class cohorts. Current-minus-baseline growth is matched; separate means can reflect entrants/leavers. Paper difficulty and syllabus equivalence are not established.'
  };
}
export async function compareStudents(schoolId, filters, peerId, db = sql) {
  if (!UUID.test(peerId || '')) throw failure('Invalid comparison student');
  const {
      current
    } = await report(schoolId, filters, db),
    first = current.students.find(s => s.student_id === filters.student_id),
    second = current.students.find(s => s.student_id === peerId);
  if (!first || !second) throw failure('Both students must belong to the selected assessment scope', 404);
  return {
    first: {
      id: first.student_id,
      name: first.display_name
    },
    second: {
      id: second.student_id,
      name: second.display_name
    },
    provenance: current.provenance,
    subjects: first.subjects.map(a => {
      const b = second.subjects.find(s => s.subject_id === a.subject_id),
        left = current.subjects.find(s => s.key === `${a.class_section_id}:${a.subject_id}`),
        right = current.subjects.find(s => s.key === `${b?.class_section_id}:${a.subject_id}`),
        comparison = compareSubjects(left, right, current.policy);
      return {
        subject_name: a.subject_name,
        first_percentage: a.published ? a.percentage : null,
        first_score: a.published ? a.score : null,
        first_maximum: a.max_marks,
        second_percentage: b?.published ? b.percentage : null,
        second_score: b?.published ? b.score : null,
        second_maximum: b?.max_marks ?? null,
        first_state: a.state,
        second_state: b?.state ?? 'not_applicable',
        status: comparison.status,
        difference_pp: comparison.status !== 'unsuitable' && a.published && b?.published && a.percentage != null && b.percentage != null ? a.percentage - b.percentage : null,
        limitations: comparison.limitations
      };
    })
  };
}
