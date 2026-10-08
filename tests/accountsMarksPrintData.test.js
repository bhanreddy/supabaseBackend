import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sendSuccess } from '../utils/apiResponse.js';
import { usesSummativeMarksRegister, summativeFormativeKeys } from '../services/summativeMarksPrintService.js';

// Exercise the actual route handler with an in-memory SQL boundary. Loading
// the application router would initialize production infrastructure; this
// harness never imports db.js and rejects every non-SELECT database operation.
const source = readFileSync(new URL('../routes/resultsRoutes.js', import.meta.url), 'utf8');
const start = source.indexOf("router.get('/accounts/exams/:examId/marks/export'");
const end = source.indexOf('\n/**', start);
const selectionSource = readFileSync(new URL('../services/examTimetableService.js', import.meta.url), 'utf8');
const selectionStart = selectionSource.indexOf('export function selectEffectiveSectionPapers');
const selectionEnd = selectionSource.indexOf('\n/**', selectionStart);
const schoolId = '11111111-1111-4111-8111-111111111111';
const examId = '22222222-2222-4222-8222-222222222222';

for (const summative of [false, true]) {
  test(`client ${summative ? 'SA' : 'FA'} print payload preserves saved precision and every cohort row without any writes`, async () => {
    const exam = { id: examId, name: summative ? 'SA-1' : 'FA-1', exam_type: summative ? 'sa_results' : 'fa_results', academic_year_id: 'year' };
    const sections = [{ id: 'section', class_id: 'class', class_name: '8', section_name: 'A', teacher_name: 'Teacher' }];
    const papers = [{ exam_subject_id: 'paper', subject_id: 'english', subject_name: 'English', class_id: 'class',
      class_section_id: null, assessment_schema: 'component', max_marks: '50', slip_test_max_marks: '20' }];
    const marks = Object.freeze(['student-1', 'student-2'].map((student_id) => Object.freeze({
      class_section_id: 'section', student_id, student_name: student_id, exam_subject_id: 'paper',
      max_marks: '50', mark_id: `mark-${student_id}`, marks_obtained: '43.27',
      participation_marks: '7.2', written_work_marks: '7.3', project_work_marks: '7.7', slip_test_marks: '1.23',
    })));
    const formativeRows = Object.freeze([{ student_id: 'student-1', class_section_id: 'section', marks_obtained: '18.29', slip_test_marks: '7.23' }]);
    const original = JSON.stringify({ marks, formativeRows });
    const queries = [];
    const sql = (strings, ...values) => {
      const query = strings.join('?').trim();
      if (!query || query.startsWith('AND ')) return { fragment: query, values };
      assert.match(query, /^SELECT\b/);
      assert.ok(values.includes(schoolId), 'every read must include the authenticated school');
      queries.push(query);
      if (query.includes('formative.name AS exam_name')) return Promise.resolve(formativeRows);
      if (query.includes('exam.id, exam.name')) return Promise.resolve([exam]);
      if (query.includes('COALESCE(NULLIF(teacher_person')) return Promise.resolve(sections);
      if (query.includes('subject.name AS subject_name')) return Promise.resolve(papers);
      if (query.includes('mark.id AS mark_id')) return Promise.resolve(marks);
      if (query.includes('attendance_percentage')) return Promise.resolve([]);
      if (query.includes('SELECT name FROM schools')) return Promise.resolve([{ name: 'School' }]);
      throw new Error(`Unexpected read: ${query}`);
    };
    sql.array = (values) => values;
    let handler;
    const forbiddenCalculation = () => { throw new Error('Client print must not run server print calculations'); };
    const context = {
      router: { get: (_path, ...handlers) => { handler = handlers.at(-1); } },
      requireAuth: () => {}, requireRole: () => () => {}, asyncHandler: (fn) => fn,
      UUID_RE: /^[0-9a-f-]{36}$/i, ACTIVE_STUDENT_STATUS_ID: 'active', sql,
      ASSESSMENT_PRINT_MARKS_MODES: ['original', 'passing_criteria'],
      getRequestedRankingMethod: async () => 'competition', sendSuccess,
      usesSummativeMarksRegister, summativeFormativeKeys,
      assessmentPrintSubjects: forbiddenCalculation, prepareSummativeMarksSection: forbiddenCalculation,
      buildAssessmentMarksPrint: forbiddenCalculation, buildSchoolMarksWorkbook: forbiddenCalculation,
    };
    vm.runInNewContext(selectionSource.slice(selectionStart, selectionEnd).replace('export ', '')
      + '\n' + source.slice(start, end), context);
    let status = 200;
    let response;
    const res = { status: (code) => { status = code; return res; }, json: (body) => { response = body; return body; } };
    await handler({ schoolId, params: { examId }, query: {
      format: 'print', renderer: 'client', marks_mode: 'passing_criteria', result_status: 'fail',
    } }, res);
    assert.equal(status, 200);
    assert.equal(response.school_id, schoolId);
    assert.equal(response.data.print_data_version, 1);
    assert.equal(response.data.sections[0].students.length, 2, 'client needs full cohort before ranking/filtering');
    assert.equal(response.data.sections[0].students[0].subjects[0].marks_obtained, 43.27);
    assert.equal(response.data.sections[0].students[0].subjects[0].slip_test_marks, 1.23);
    assert.equal(response.data.sections[0].students[0].subjects[0].participation_marks, 7.2);
    assert.equal(response.data.formativeRows.length, summative ? 1 : 0);
    if (summative) assert.equal(response.data.formativeRows[0].slip_test_marks, '7.23');
    assert.equal(JSON.stringify({ marks, formativeRows }), original);
    assert.equal(queries.length, summative ? 7 : 6);
  });
}
