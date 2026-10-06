import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessmentMarksPrint, sampleAssessmentGrade, sampleComponentGradePoint, sampleSummativeGradePoint } from './assessmentMarksPrint.js';
import { prepareSummativeMarksSection } from '../services/summativeMarksPrintService.js';

const paper = (id, name, maximum = 25, schema = 'consolidated') => ({
  exam_subject_id: id, subject_name: name, max_marks: maximum, assessment_schema: schema,
  participation_max_marks: 10, written_work_max_marks: 10, project_work_max_marks: 10, slip_test_max_marks: 20,
});
const mark = (paper, score, extra = {}) => ({
  exam_subject_id: paper.exam_subject_id, max_marks: paper.max_marks,
  mark_id: `mark-${paper.exam_subject_id}`, marks_obtained: score, ...extra,
});
const report = (papers, students, examType = 'fa_results', className = '4th') => buildAssessmentMarksPrint({
  schoolName: 'GEETHANJALI HIGH SCHOOL (E/M) - MADDUR',
  exam: { name: examType === 'fa_results' ? 'FA-1' : 'SA-1', exam_type: examType },
  sections: [{ classSection: { class_name: className, section_name: 'A' }, teacherName: 'BHANU LATHA', papers, students }],
});

test('sample grades include A2 and the photographed low-score boundaries', () => {
  for (const [score, grade] of [[100, 'A1'], [91, 'A1'], [90, 'A2'], [81, 'A2'], [80, 'B1'], [70, 'B2'], [60, 'C1'], [50, 'C2'], [40, 'D1'], [35, 'D1'], [34, 'D2']]) {
    assert.equal(sampleAssessmentGrade(score), grade);
  }
  assert.equal(sampleAssessmentGrade(null), null);
  assert.equal(sampleComponentGradePoint(95), 9);
  assert.equal(sampleComponentGradePoint(97), 10);
  assert.equal(sampleComponentGradePoint(83), 8);
});

test('consolidated FA register matches paired marks/grade columns and sample subject order', () => {
  const papers = ['Social', 'English', 'Hindi', 'Math', 'Telugu', 'Science'].map((name, index) => paper(String(index), name));
  const result = report(papers, [{ student_name: 'AKSHITHA', rank: 10, subjects: papers.map((item) => mark(item, 22)) }]);
  assert.equal(result.page_count, 1);
  assert.equal(result.student_count, 1);
  assert.match(result.html, /FORMATIVE ASSESSMENT - 1/);
  assert.match(result.html, /CLASS TEACHER NAME : BHANU LATHA/);
  assert.match(result.html, /CLASS: 4th - A/);
  assert.match(result.html, /<th>150<\/th><th>GRADE<\/th>/);
  assert.match(result.html, /<td>132<\/td><td>A2<\/td><td>10<\/td><td>88<\/td>/);
  assert.ok(result.html.indexOf('>TEL<') < result.html.indexOf('>HIN<'));
  assert.ok(result.html.indexOf('>HIN<') < result.html.indexOf('>ENG<'));
  assert.ok(result.html.indexOf('>SCIENCE<') < result.html.indexOf('>SOCIAL<'));
  assert.doesNotMatch(result.html, /Admission No|Roll No|Entry Status/);
});

test('SA register uses configured maxima and the shared grand total formula', () => {
  const papers = [paper('tel', 'Telugu', 100), paper('eng', 'English', 50)];
  const result = report(papers, [{ student_name: 'Student', rank: 4, subjects: [mark(papers[0], 84), mark(papers[1], 46)] }], 'sa_results');
  assert.match(result.html, /SUMMATIVE ASSESSMENT - 1/);
  assert.match(result.html, /<th>100<\/th><th>GRADE<\/th><th>50<\/th>/);
  assert.match(result.html, /<td>130<\/td><td>A2<\/td><td>4<\/td><td>86.67<\/td>/);
});

test('component register prints raw marks, 20% weightage and average grade points', () => {
  const papers = [paper('tel', 'Telugu', 50, 'component'), paper('eng', 'English', 50, 'component')];
  const subjects = [mark(papers[0], 48.5, { participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 18.5 }),
    mark(papers[1], 47.5, { participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 17.5 })];
  const result = report(papers, [{ student_name: 'AARTHI', subjects, rank: 2 }]);
  assert.match(result.html, /FORMATIVE ASSESSMENT - 1 MARKS LIST/);
  assert.match(result.html, /Res<br>10/);
  assert.match(result.html, /ST<br>20/);
  assert.match(result.html, /<td>48.5<\/td><td>19.4<\/td><td>10<\/td>/);
  assert.match(result.html, /<td>47.5<\/td><td>19<\/td><td>9<\/td>/);
  assert.match(result.html, /<td>96<\/td><td>96<\/td><td>2<\/td><td>A1<\/td><td>9.5<\/td>/);
});

test('Classes 6–10 FA replaces only the weightage cell with the sample subject grade', () => {
  const papers = [paper('soc', 'Social', 50, 'component')];
  const students = [{ student_name: 'Student', rank: 1, subjects: [mark(papers[0], 17.5, {
    participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 14,
  })] }];
  for (const className of ['6', '7th', 'Class 8', 'Grade 9', '10th', 'VI', 'VII', 'VIII', 'IX', 'X']) {
    const result = report(papers, students, 'fa_results', className);
    assert.match(result.html, /<th colspan="7">Social<\/th>/);
    assert.match(result.html, /<th rowspan="1" class="vertical">GRADE<\/th><th rowspan="1" class="vertical">GPA<\/th>/);
    assert.match(result.html, /<td>44<\/td><td>A2<\/td><td>9<\/td>/);
    assert.doesNotMatch(result.html, /20%|<td>17.6<\/td>/);
    assert.match(result.html, /<td>44<\/td><td>88<\/td><td>1<\/td><td>A2<\/td><td>9<\/td>/);
  }
  for (const className of ['5', '11']) {
    assert.match(report(papers, students, 'fa_results', className).html, /<td>44<\/td><td>17.6<\/td><td>9<\/td>/);
  }
});

test('secondary FA grades distinguish saved zero, absent and missing component marks', () => {
  const papers = [paper('eng', 'English', 50, 'component')];
  const subjects = [mark(papers[0], 0, { participation_marks: 0, written_work_marks: 0, project_work_marks: 0, slip_test_marks: 0 }),
    mark(papers[0], null, { is_absent: true }), null];
  const rows = subjects.map((subject, index) => ({ student_name: `Student ${index}`, subjects: subject ? [subject] : [] }));
  const result = report(papers, rows, 'fa_results', '6');
  assert.match(result.html, /(?:<td>0<\/td>){5}<td>D2<\/td><td>4<\/td>/);
  assert.match(result.html, /(?:<td>AB<\/td>){6}<td>4<\/td>/);
  assert.match(result.html, /(?:<td>—<\/td>){7}/);
});

test('secondary FA split Science replaces weightage with a grade of the combined component total', () => {
  const papers = ['Physics', 'Biology'].map((name) => paper(name, name, 25, 'component'));
  const subjects = papers.map((item) => mark(item, 5, {
    participation_marks: 5, written_work_marks: 5, project_work_marks: 5, slip_test_marks: 5,
  }));
  const result = report(papers, [{ student_name: 'Student', subjects }], 'fa_results', '8th');
  assert.match(result.html, /<th colspan="13">Science<\/th>/);
  assert.match(result.html, /<th rowspan="2" class="vertical">GRADE<\/th>/);
  assert.match(result.html, /<td>40<\/td><td>B1<\/td><td>8<\/td>/);
  assert.doesNotMatch(result.html, /20%/);
});

test('component SA adds missing subject grades while retaining its contribution and Science grouping', () => {
  const papers = [paper('eng', 'English', 50, 'component'), ...['Physics', 'Biology'].map((name) => paper(name, name, 25, 'component'))];
  const subjects = papers.map((item) => mark(item, 0, {
    participation_marks: item.max_marks / 5, written_work_marks: item.max_marks / 5,
    project_work_marks: item.max_marks / 5, slip_test_marks: item.max_marks * 2 / 5,
  }));
  const result = report(papers, [{ student_name: 'Student', subjects }], 'sa_results');
  assert.match(result.html, /<th colspan="8">English<\/th>/);
  assert.match(result.html, /<th colspan="14">Science<\/th>/);
  assert.match(result.html, /<th rowspan="2">20%<\/th><th rowspan="2" class="vertical">GRADE<\/th><th rowspan="2" class="vertical">GPA<\/th>/);
  assert.equal((result.html.match(/<td>50<\/td><td>20<\/td><td>A1<\/td><td>10<\/td>/g) || []).length, 2);
  const bodyRow = result.html.match(/<tbody>\s*(<tr>.*?<\/tr>)/s)[1];
  assert.equal((bodyRow.match(/<td\b/g) || []).length, 29);
  assert.equal((result.html.match(/<col\b/g) || []).length, 29);
});

test('higher-class format combines Physical Science and Biology in a Science group', () => {
  const papers = [paper('tel', 'Telugu', 50, 'component'), paper('phy', 'Physical Science', 25, 'component'), paper('bio', 'Biology', 25, 'component')];
  const result = report(papers, [{ student_name: 'AKSHARA', rank: 1, subjects: papers.map((item) => mark(item, item.max_marks, {
    participation_marks: item.max_marks / 5, written_work_marks: item.max_marks / 5,
    project_work_marks: item.max_marks / 5, slip_test_marks: item.max_marks * 2 / 5,
  })) }]);
  assert.match(result.html, /<th colspan="13">Science<\/th>/);
  assert.match(result.html, /<th colspan="5">Physical Science<\/th><th colspan="5">Biological Science<\/th>/);
  assert.match(result.html, /<td>50<\/td><td>20<\/td><td>10<\/td>/);
  assert.match(result.html, /<th rowspan="2">Res<br>10<\/th>/);
});

test('missing marks stay distinct from saved zeroes, with partial totals identified', () => {
  const papers = [paper('tel', 'Telugu'), paper('eng', 'English')];
  const result = report(papers, [{ student_name: 'Incomplete', rank: 9, subjects: [mark(papers[0], 0)] }]);
  assert.match(result.html, /<td>0<\/td><td>D2<\/td><td>—<\/td><td>—<\/td>/);
  assert.match(result.html, /<td>0\*<\/td><td>—<\/td><td>9<\/td><td>0<\/td>/);
  assert.match(result.html, /overall grade\/GPA awaits complete marks/);
});

test('absences remain AB while contributing zero and their maximum to totals', () => {
  const papers = [paper('tel', 'Telugu'), paper('eng', 'English')];
  const result = report(papers, [{ student_name: 'Absent', subjects: [mark(papers[0], null, { is_absent: true }), mark(papers[1], 25)] }]);
  assert.match(result.html, /<td>AB<\/td><td>AB<\/td><td>25<\/td><td>A1<\/td>/);
  assert.match(result.html, /<td>25<\/td><td>C2<\/td><td>—<\/td><td>50<\/td>/);
  assert.match(result.html, /AB = absent/);
});

test('long registers paginate with repeated class headings and continuous serial numbers', () => {
  const papers = [paper('tel', 'Telugu', 50, 'component')];
  const result = report(papers, Array.from({ length: 29 }, (_, index) => ({ student_name: `Student ${index + 1}`, subjects: [mark(papers[0], 45, {
    participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 15,
  })], rank: 12 })));
  assert.equal(result.page_count, 2);
  assert.equal(result.student_count, 29);
  assert.equal((result.html.match(/Name of the Class Teacher/g) || []).length, 2);
  assert.match(result.html, /<td>29<\/td><td class="student-name">Student 29<\/td>/);
  assert.match(result.html, /@page \{ size: A4 landscape; margin: 8mm; \}/);
});

test('empty filtered sections still produce a printable page and escape user text', () => {
  const result = buildAssessmentMarksPrint({ schoolName: '<script>alert(1)</script>', exam: { name: 'FA-1', exam_type: 'fa_results' },
    sections: [{ teacherName: 'A & B', classSection: { class_name: '4', section_name: '<A>' }, papers: [paper('tel', 'Telugu')], students: [] }] });
  assert.equal(result.page_count, 1);
  assert.match(result.html, /No students match the selected filters/);
  assert.match(result.html, /A &amp; B/);
  assert.match(result.html, /&lt;A&gt;/);
  assert.doesNotMatch(result.html, /<script>/i);
});

test('wrapped student names reserve extra height and retain all students across pages', () => {
  const papers = [paper('tel', 'Telugu', 50, 'component')];
  const students = Array.from({ length: 35 }, (_, index) => ({
    student_name: `${'Verylongstudentname'.repeat(4)} ${index}`, subjects: [mark(papers[0], 45, {
      participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 15,
    })],
  }));
  const result = report(papers, students);
  assert.ok(result.page_count >= 3);
  assert.equal(result.student_count, 35);
  assert.match(result.html, /<td>35<\/td>/);
});

test('Social uses the component sum instead of a copied consolidated total in every printed calculation', () => {
  const papers = [paper('eng', 'English', 50, 'component'), paper('soc', 'Social', 50, 'component')];
  const subjects = [mark(papers[0], 40, { participation_marks: 9, written_work_marks: 8, project_work_marks: 8, slip_test_marks: 15 }),
    mark(papers[1], 17.5, { consolidated_marks_obtained: 17.5, participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 17.5 })];
  const result = report(papers, [{ student_name: 'Student', subjects, rank: 3 }]);
  assert.match(result.html, /<td>10<\/td><td>10<\/td><td>10<\/td><td>17.5<\/td><td>47.5<\/td><td>19<\/td><td>9<\/td>/);
  assert.match(result.html, /<td>87.5<\/td><td>87.5<\/td><td>3<\/td><td>A2<\/td><td>8.5<\/td>/);
  assert.doesNotMatch(result.html, /<td>17.5<\/td><td>7<\/td><td>4<\/td>/);
});

test('component rows with no component values do not reuse a saved consolidated score', () => {
  const papers = [paper('soc', 'Social', 50, 'component')];
  const result = report(papers, [{ student_name: 'Missing components', subjects: [mark(papers[0], 17.5)] }]);
  assert.doesNotMatch(result.html, /<td>17.5<\/td>/);
  assert.match(result.html, /overall grade\/GPA awaits complete marks/);
});

const summativeReport = (papers, subjects, formativeRows, name = 'SA-1') => {
  const exam = { name, exam_type: 'sa_results' };
  const prepared = prepareSummativeMarksSection({
    classSection: { id: 'section', class_name: '8', section_name: 'B' }, teacherName: 'D J REDDY',
    papers, students: [{ student_id: 'student', student_name: 'AKSHARA', subjects }],
  }, exam, formativeRows);
  return buildAssessmentMarksPrint({ schoolName: 'GEETHANJALI HIGH SCHOOL - MADDUR', exam, sections: [prepared] });
};
const formativeSources = (papers) => papers.flatMap((item) => ['FA-1', 'FA-2'].map((name) => ({
  student_id: 'student', class_section_id: 'section', subject_id: item.subject_id,
  exam_type: 'fa_results', exam_name: name, mark_id: 'fa-mark',
  max_marks: item.max_marks === 40 ? 25 : 50,
  marks_obtained: item.max_marks === 40 ? 22.5 : 45,
})));

test('Classes 6–10 summative print shows 70 + 18 = 88, grand totals, sample grades and GPA', () => {
  const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Science', 'Social'].map((name) => ({ ...paper(name, name, 80), subject_id: name }));
  const result = summativeReport(papers, papers.map((item) => mark(item, 70)), formativeSources(papers));
  assert.match(result.html, /SUMMATIVE ASSESSMENT - 1 MARKS LIST/);
  assert.match(result.html, /EXAM<br>80/);
  assert.match(result.html, /FA1\+FA2<br>20%/);
  assert.match(result.html, /<td>70<\/td><td>18<\/td><td>88<\/td><td>A2<\/td><td>9<\/td>/);
  assert.match(result.html, /<td>528<\/td><td>88<\/td><td>A2<\/td><td>9<\/td><td>1<\/td>/);
  assert.equal(sampleSummativeGradePoint(90), 9);
  assert.equal(sampleSummativeGradePoint(76), 8);
  assert.equal(sampleSummativeGradePoint(16), 3);
  assert.equal(sampleSummativeGradePoint(null), null);
});

test('summative print groups Physics 40 + 10 and Biology 40 + 10 into a 100-mark Science result', () => {
  const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Social', 'Physics', 'Biology'].map((name) => ({
    ...paper(name, name, ['Physics', 'Biology'].includes(name) ? 40 : 80), subject_id: name,
  }));
  const result = summativeReport(papers, papers.map((item) => mark(item, item.max_marks === 40 ? 35 : 70)), formativeSources(papers));
  assert.match(result.html, /<th colspan="3">PHY<\/th><th colspan="6">BIO.SCI<\/th>/);
  assert.match(result.html, /FA1\+FA2<br>10%/);
  assert.match(result.html, /G.Total<br>100/);
  assert.match(result.html, /<td>35<\/td><td>9<\/td><td>44<\/td><td>35<\/td><td>9<\/td><td>44<\/td><td>88<\/td><td>A2<\/td><td>9<\/td>/);
  assert.match(result.html, /<td>528<\/td><td>88<\/td><td>A2<\/td><td>9<\/td><td>1<\/td>/);
});

test('summative missing FA entries keep raw exam marks visible and leave grand totals and ranks blank', () => {
  const papers = [{ ...paper('soc', 'Social', 80), subject_id: 'soc' }];
  const result = summativeReport(papers, [mark(papers[0], 70)], []);
  assert.match(result.html, /<td>70<\/td>(?:<td>—<\/td>){9}/);
  assert.match(result.html, /combined totals, grade, GPA and rank await complete marks/);
});

test('summative exam absence prints AB while retaining its FA contribution and sample D2 grade point', () => {
  const papers = [{ ...paper('soc', 'Social', 80), subject_id: 'soc' }];
  const rows = formativeSources(papers).map((row) => ({ ...row, marks_obtained: 40 }));
  const result = summativeReport(papers, [mark(papers[0], null, { is_absent: true })], rows);
  assert.match(result.html, /<td>AB<\/td><td>16<\/td><td>16<\/td><td>D2<\/td><td>3<\/td>/);
  assert.match(result.html, /AB = absent/);
});

test('summative print accepts 100-mark English and displays the actual maximum and entered score', () => {
  const papers = [{ ...paper('eng', 'English', 100), subject_id: 'eng' }];
  const result = summativeReport(papers, [mark(papers[0], 90)], formativeSources(papers));
  assert.match(result.html, /EXAM<br>100/);
  assert.match(result.html, /Total<br>120/);
  assert.match(result.html, /<td>90<\/td><td>18<\/td><td>108<\/td><td>A2<\/td><td>9<\/td>/);
  assert.match(result.html, /<td>108<\/td><td>90<\/td><td>A2<\/td><td>9<\/td><td>1<\/td>/);
});

test('Science entered with unused EVS prints a complete 150/150 row and overall grade, without a partial-total marker', () => {
  const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Science', 'Social', 'EVS'].map((name) => paper(name, name, 25));
  const result = report(papers, [{ student_name: 'AVUTLAKSHARA', rank: 1,
    subjects: papers.filter((item) => item.subject_name !== 'EVS').map((item) => mark(item, 25)) }]);
  assert.match(result.html, /<th>150<\/th><th>GRADE<\/th>/);
  assert.match(result.html, /<td>150<\/td><td>A1<\/td><td>1<\/td><td>100<\/td>/);
  assert.doesNotMatch(result.html, /150\*|marks not entered/);
  assert.doesNotMatch(result.html, /<th colspan="2">EVS<\/th>/);
  assert.match(result.html, /<th colspan="2">SCIENCE<\/th>/);
});

test('EVS-only and both-entered consolidated reports keep marks visible and count one alternative', () => {
  const papers = [paper('sci', 'Science', 25), paper('evs', 'EVS', 50)];
  const result = report(papers, [
    { student_name: 'EVS only', rank: 1, subjects: [mark(papers[1], 45)] },
    { student_name: 'Both entered', rank: 2, subjects: [mark(papers[0], 20), mark(papers[1], 50)] },
  ]);
  assert.match(result.html, /<th>25 \/ 50<\/th><th>GRADE<\/th>/);
  assert.match(result.html, /<td>45<\/td><td>A2<\/td><td>45<\/td><td>A2<\/td><td>1<\/td><td>90<\/td>/);
  assert.match(result.html, /<td>20<\/td><td>B1<\/td><td>50<\/td><td>A1<\/td><td>20<\/td><td>B1<\/td><td>2<\/td><td>80<\/td>/);
});

test('component overall GPA counts the selected Science/EVS group exactly once', () => {
  const papers = [paper('sci', 'Science', 50, 'component'), paper('evs', 'EVS', 50, 'component')];
  const marks = [mark(papers[0], 45, { participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 15 }),
    mark(papers[1], 50, { participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 20 })];
  const result = report(papers, [{ student_name: 'Both component', rank: 1, subjects: marks }]);
  assert.match(result.html, /<td>50<\/td><td>20<\/td><td>10<\/td>/);
  assert.match(result.html, /<td>45<\/td><td>90<\/td><td>1<\/td><td>A2<\/td><td>9<\/td>/);
  const onlyEvs = report(papers, [{ student_name: 'Only EVS', rank: 1, subjects: [marks[1]] }]);
  assert.match(onlyEvs.html, /<td>50<\/td><td>100<\/td><td>1<\/td><td>A1<\/td><td>10<\/td>/);
  assert.doesNotMatch(onlyEvs.html, /marks not entered/);
});

test('summative totals, GPA and ranks ignore unused EVS and hide its empty column', () => {
  const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Science', 'Social', 'EVS'].map((name) => ({ ...paper(name, name, 80), subject_id: name }));
  const actualPapers = papers.filter((item) => item.subject_name !== 'EVS');
  const result = summativeReport(papers, actualPapers.map((item) => mark(item, 70)), formativeSources(actualPapers));
  assert.doesNotMatch(result.html, /<th colspan="5">EVS<\/th>/);
  assert.match(result.html, /<td>528<\/td><td>88<\/td><td>A2<\/td><td>9<\/td><td>1<\/td>/);
  assert.doesNotMatch(result.html, /required FA\/exam marks not entered/);
});

test('the screenshot preview hides empty Science when EVS has entries, keeping the existing totals and ranks', () => {
  const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Science', 'Social', 'EVS'].map((name) => paper(name, name, 25));
  const subjects = papers.map((item) => item.subject_name === 'Science'
    ? { exam_subject_id: item.exam_subject_id, mark_id: null, marks_obtained: null }
    : mark(item, 14));
  const result = report(papers, [{ student_name: 'EVS Student', rank: 26, subjects }]);
  assert.doesNotMatch(result.html, /<th colspan="2">SCIENCE<\/th>/);
  assert.match(result.html, /<th colspan="2">EVS<\/th>/);
  assert.match(result.html, /<td>84<\/td><td>C1<\/td><td>26<\/td><td>56<\/td>/);
  assert.equal((result.html.match(/<td(?: class="student-name")?>/g) || []).length, 18);
});

test('all printed pages use the same columns when Science and EVS are entered by different students', () => {
  const papers = [paper('sci', 'Science', 25), paper('evs', 'EVS', 25)];
  const students = Array.from({ length: 31 }, (_, index) => ({
    student_name: `Student ${index}`, subjects: [mark(index === 30 ? papers[0] : papers[1], 25)], rank: 1,
  }));
  const result = report(papers, students);
  assert.equal(result.page_count, 2);
  assert.equal((result.html.match(/<th colspan="2">SCIENCE<\/th>/g) || []).length, 2);
  assert.equal((result.html.match(/<th colspan="2">EVS<\/th>/g) || []).length, 2);
});

test('a filtered preview preserves the columns selected from the whole class cohort', () => {
  const papers = [paper('sci', 'Science', 25), paper('evs', 'EVS', 25)];
  const result = buildAssessmentMarksPrint({ exam: { name: 'FA-1', exam_type: 'fa_results' }, sections: [{
    papers, displayPapers: papers, students: [{ student_name: 'Filtered EVS student', subjects: [mark(papers[1], 25)] }],
  }] });
  assert.match(result.html, /<th colspan="2">SCIENCE<\/th>/);
  assert.match(result.html, /<th colspan="2">EVS<\/th>/);
});
