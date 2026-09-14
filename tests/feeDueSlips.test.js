import test from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  getStudentsWithDueFees,
  resolveFeeDueAcademicYear,
  getStudentDetailedFeeBreakdown,
} from '../services/feeDueCalculationService.js';
import {
  inrAmountToWords,
  formatCurrencyInr,
  getSampleStudentData,
  resolveStudentDocumentData,
  interpolateVariables,
} from '../services/documentDataResolver.js';
import {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  duplicateTemplate,
  setDefaultTemplate,
  archiveTemplate,
  validateTemplate,
  getDefaultTemplateDefinition,
  DEFAULT_PAGE_SETTINGS,
} from '../services/documentTemplateService.js';
import {
  renderSingleSlipHtml,
  buildDocumentHtml,
  buildDueStudentsWorkbook,
  buildDueStudentsCsv,
  buildDocxHtml,
} from '../services/documentGenerationService.js';

test('Fee Due Slips — Currency to Words', () => {
  assert.equal(inrAmountToWords(0), 'Zero Rupees Only');
  assert.equal(inrAmountToWords(500), 'Five Hundred Rupees Only');
  assert.equal(inrAmountToWords(8000), 'Eight Thousand Rupees Only');
  assert.equal(inrAmountToWords(28500), 'Twenty Eight Thousand Five Hundred Rupees Only');
  assert.equal(inrAmountToWords(105400), 'One Lakh Five Thousand Four Hundred Rupees Only');
});

test('Fee Due Slips — Template Validation', () => {
  const invalidName = validateTemplate({ name: '', template_definition: getDefaultTemplateDefinition() });
  assert.equal(invalidName.valid, false);
  assert.match(invalidName.errors[0], /Template name is required/);

  const invalidBlocks = validateTemplate({ name: 'Test', template_definition: { blocks: [] } });
  assert.equal(invalidBlocks.valid, false);

  const valid = validateTemplate({
    name: 'Valid Template',
    template_definition: getDefaultTemplateDefinition(),
    page_settings: DEFAULT_PAGE_SETTINGS,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);
});

test('Fee Due Slips — Variable Interpolation', () => {
  const template = 'Student: {{student_name}} | Due: {{due_amount}}';
  const resolved = interpolateVariables(template, {
    student_name: 'Rahul Kumar',
    due_amount: '₹8,000',
  });
  assert.equal(resolved, 'Student: Rahul Kumar | Due: ₹8,000');
});

test('Fee Due Slips — Document Rendering & Tearable Section', () => {
  const sampleData = getSampleStudentData({ name: 'Test High School' });
  const html = renderSingleSlipHtml(getDefaultTemplateDefinition(), sampleData, DEFAULT_PAGE_SETTINGS);

  assert.ok(html.includes('fds-header'), 'Must contain header block');
  assert.ok(html.includes('fds-student-box'), 'Must contain student details box');
  assert.ok(html.includes('fds-summary-box'), 'Must contain fee summary box');
  assert.ok(html.includes('fds-tear-section'), 'Must contain tear-off section');
  assert.ok(html.includes('fds-scissor-icon'), 'Must contain scissors icon');
  assert.ok(html.includes('Rahul Kumar'), 'Must contain student name');
  assert.ok(html.includes('Suresh Kumar'), 'Must contain father name');
  assert.ok(html.includes('₹8,000'), 'Must contain due amount');
  assert.ok(html.includes('Eight Thousand Rupees Only'), 'Must contain words');
});

test('Fee Due Slips — Multi-Page Document Compilation', () => {
  const s1 = getSampleStudentData({ name: 'Test School' });
  const s2 = { ...s1, student_name: 'Arjun Reddy', admission_number: 'ADM-1024', due_amount: '₹6,500' };

  // 1 slip per page = 2 pages
  const html1 = buildDocumentHtml({
    template: { name: 'Slip', template_definition: getDefaultTemplateDefinition(), page_settings: { slips_per_page: 1 } },
    studentsData: [s1, s2],
  });
  assert.equal((html1.match(/<section class="fds-page/g) || []).length, 2);

  // 2 slips per page = 1 page
  const html2 = buildDocumentHtml({
    template: { name: 'Slip', template_definition: getDefaultTemplateDefinition(), page_settings: { slips_per_page: 2 } },
    studentsData: [s1, s2],
  });
  assert.equal((html2.match(/<section class="fds-page/g) || []).length, 1);
});

test('Fee Due Slips — Excel, CSV & DOCX Exporters', () => {
  const sample = getSampleStudentData({ name: 'Test School' });
  const workbook = buildDueStudentsWorkbook({
    schoolName: 'Test School',
    academicYear: '2026-2027',
    students: [sample],
  });
  assert.ok(Buffer.isBuffer(workbook));
  assert.ok(workbook.length > 1000);

  const csv = buildDueStudentsCsv([sample]);
  assert.ok(csv.includes('Rahul Kumar'));
  assert.ok(csv.includes('ADM-1023'));

  const docx = buildDocxHtml({
    template: { name: 'Slip', template_definition: getDefaultTemplateDefinition(), page_settings: DEFAULT_PAGE_SETTINGS },
    studentsData: [sample],
  });
  assert.ok(docx.includes('urn:schemas-microsoft-com:office:word'));
  assert.ok(docx.includes('Rahul Kumar'));
});

test('Fee Due Slips — Live Database Queries & Authoritative Ledger', async () => {
  const schoolId = 17;
  const result = await getStudentsWithDueFees(schoolId, { limit: 10 });

  assert.ok(result.academic_year != null, 'Academic year must resolve');
  assert.ok(result.summary.total_students > 0, 'Total students must be > 0');
  assert.ok(result.summary.total_due > 0, 'Total outstanding due must be > 0');
  assert.ok(result.students.length > 0, 'Must return page students');

  const firstStudent = result.students[0];
  assert.ok(firstStudent.student_name, 'Student must have name');
  assert.ok(firstStudent.admission_no, 'Student must have admission number');
  assert.ok(firstStudent.class_name, 'Student must have class name');
  assert.ok(Number(firstStudent.total_fee) >= 0, 'Total fee must be non-negative');

  // Verify authoritative equation: Total - Concession - Paid = Due (tuition due)
  const expectedTuitionDue = Math.max(
    0,
    Math.round((firstStudent.total_fee - firstStudent.concession_amount - firstStudent.paid_amount) * 100) / 100
  );
  assert.equal(
    firstStudent.tuition_due,
    expectedTuitionDue,
    'Tuition due must exactly match authoritative formula'
  );

  // Live student data resolution
  const resolved = await resolveStudentDocumentData(schoolId, firstStudent.student_id);
  assert.equal(resolved.student_name, firstStudent.student_name);
  assert.equal(resolved.due_amount, formatCurrencyInr(firstStudent.due_amount));
});

test('Fee Due Slips — Template Lifecycle in Database', async () => {
  const schoolId = 17;
  const templates = await listTemplates(schoolId);
  assert.ok(templates.length > 0, 'Must have at least default template');

  const defaultTemplate = templates.find((t) => t.is_default);
  assert.ok(defaultTemplate != null, 'Must have a default template');

  // Create a custom template
  const custom = await createTemplate(schoolId, {
    name: 'Quarterly Reminder Notice',
    description: 'Notice for 2nd quarter dues',
    template_definition: getDefaultTemplateDefinition(),
    page_settings: { ...DEFAULT_PAGE_SETTINGS, slips_per_page: 2 },
  });
  assert.ok(custom.id);
  assert.equal(custom.name, 'Quarterly Reminder Notice');

  // Update template
  const updated = await updateTemplate(schoolId, custom.id, {
    name: 'Quarterly Reminder Notice Updated',
  });
  assert.equal(updated.name, 'Quarterly Reminder Notice Updated');

  // Duplicate template
  const copy = await duplicateTemplate(schoolId, custom.id);
  assert.ok(copy.name.includes('(Copy)'));

  // Archive templates
  await archiveTemplate(schoolId, custom.id);
  await archiveTemplate(schoolId, copy.id);

  const activeTemplates = await listTemplates(schoolId);
  assert.ok(!activeTemplates.some((t) => t.id === custom.id), 'Archived template must not be in active list');
});

test.after(async () => {
  await sql.end({ timeout: 2 });
});

