import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAdmissionNo,
  validateStudentName,
  validateGender,
  validateDOB,
  validateAadhaar,
  validatePenNumber,
  validateAparNumber,
  validateParents,
  evaluateStudentReadiness,
  UDISE_STATUS,
} from '../services/udiseReadinessService.js';

test('field validators enforce UDISE rules correctly', () => {
  // Admission No
  assert.equal(validateAdmissionNo('ADM-101').ok, true);
  assert.equal(validateAdmissionNo('').ok, false);
  assert.equal(validateAdmissionNo(null).ok, false);

  // Name
  assert.equal(validateStudentName('Rahul Sharma').ok, true);
  assert.equal(validateStudentName('   ').ok, false);

  // Gender
  assert.equal(validateGender('male').ok, true);
  assert.equal(validateGender('Female').ok, true);
  assert.equal(validateGender('other').ok, true);
  assert.equal(validateGender('unknown').ok, false);

  // Date of Birth
  assert.equal(validateDOB('2015-05-12').ok, true);
  assert.equal(validateDOB('2099-01-01').ok, false); // future date
  assert.equal(validateDOB('invalid-date').ok, false);

  // Aadhaar (12 digits)
  assert.equal(validateAadhaar('123456789012').ok, true);
  assert.equal(validateAadhaar('1234-5678-9012').ok, true); // spaces/hyphens allowed
  assert.equal(validateAadhaar('12345').ok, false); // invalid length
  assert.equal(validateAadhaar('').ok, true); // optional unless the school config says otherwise

  // PEN Number (alphanumeric 11-30 chars)
  assert.equal(validatePenNumber('PEN202600001').ok, true);
  assert.equal(validatePenNumber('12345').ok, true); // canonical PEN contract has no invented minimum

  // APAAR Number (12 digits)
  assert.equal(validateAparNumber('123456789012').ok, true);
  assert.equal(validateAparNumber('123').ok, true); // no undocumented fixed-length assumption

  // Parent names
  assert.equal(validateParents({ fatherName: 'Vikram', motherName: null, guardianName: null }).ok, true);
  assert.equal(validateParents({ fatherName: null, motherName: 'Kavita', guardianName: null }).ok, true);
  assert.equal(validateParents({ fatherName: null, motherName: null, guardianName: 'Suresh' }).ok, true);
  assert.equal(validateParents({ fatherName: null, motherName: null, guardianName: null }).ok, false);
});

test('evaluateStudentReadiness classifies students into authoritative UDISE statuses', () => {
  const completeStudent = {
    admission_no: '2026-001',
    student_name: 'Aditya Reddy',
    gender: 'male',
    dob: '2015-06-15',
    aadhaar_number: '987654321098',
    pen_number: 'PEN202600001',
    apar_number: '123456789012',
    father_name: 'Ramesh Reddy',
  };

  // Ready student
  const eval1 = evaluateStudentReadiness(completeStudent, {});
  assert.equal(eval1.status, UDISE_STATUS.READY);
  assert.equal(eval1.isReady, true);
  assert.equal(eval1.errors.length, 0);
  assert.equal(eval1.warnings.length, 0);

  // Optional national identifiers do not fabricate a readiness requirement.
  const missingPenStudent = { ...completeStudent, pen_number: null };
  const eval2 = evaluateStudentReadiness(missingPenStudent, {});
  assert.equal(eval2.status, UDISE_STATUS.READY);
  assert.equal(eval2.isReady, true);
  assert.equal(eval2.warnings.length, 0);

  // Student missing parent name -> CRITICAL_INCOMPLETE
  const missingParentStudent = { ...completeStudent, father_name: null, mother_name: null, guardian_name: null };
  const eval3 = evaluateStudentReadiness(missingParentStudent, {});
  assert.equal(eval3.status, UDISE_STATUS.CRITICAL_INCOMPLETE);
  assert.equal(eval3.isReady, false);
  assert.ok(eval3.errors.some(e => e.field === 'parent_name'));

  // Duplicate PEN -> DUPLICATE
  const duplicateSets = {
    pens: new Set(['PEN202600001']),
  };
  const eval4 = evaluateStudentReadiness(completeStudent, duplicateSets);
  assert.equal(eval4.status, UDISE_STATUS.DUPLICATE);
  assert.equal(eval4.isReady, false);
});

test('sanitizeCsvCell neutralizes formula injection including leading whitespace and escapes quotes', async () => {
  const { sanitizeCsvCell } = await import('../services/udiseReadinessService.js');

  assert.equal(sanitizeCsvCell('=SUM(A1:A10)'), "'=SUM(A1:A10)");
  assert.equal(sanitizeCsvCell('  =cmd|\' /C calc\'!A0'), "'  =cmd|' /C calc'!A0");
  assert.equal(sanitizeCsvCell('+12345'), "'+12345");
  assert.equal(sanitizeCsvCell('-500'), "'-500");
  assert.equal(sanitizeCsvCell('@special'), "'@special");
  assert.equal(sanitizeCsvCell('\t=evil'), "'\t=evil");
  assert.equal(sanitizeCsvCell('Normal Student'), 'Normal Student');
  assert.equal(sanitizeCsvCell('John "Johnny" Doe'), 'John ""Johnny"" Doe');
  assert.equal(sanitizeCsvCell(null), '');
});

test('maskAadhaarNumber masks sensitive digits for non-admin exports', async () => {
  const { maskAadhaarNumber } = await import('../services/udiseReadinessService.js');

  assert.equal(maskAadhaarNumber('123456789012'), 'XXXXXXXX9012');
  assert.equal(maskAadhaarNumber('1234 5678 9012'), 'XXXXXXXX9012');
  assert.equal(maskAadhaarNumber(null), '');
});

test('buildDuplicateSets ignores null or empty identifiers', async () => {
  const { buildDuplicateSets } = await import('../services/udiseReadinessService.js');

  const students = [
    { admission_no: 'A1', pen_number: null, aadhaar_number: null },
    { admission_no: 'A2', pen_number: null, aadhaar_number: null },
    { admission_no: 'A3', pen_number: '', aadhaar_number: '   ' },
    { admission_no: 'A4', pen_number: 'PEN100', aadhaar_number: '123456789012' },
    { admission_no: 'A5', pen_number: 'PEN100', aadhaar_number: '987654321098' },
  ];

  const sets = buildDuplicateSets(students);
  assert.equal(sets.admissionNos.size, 0); // All unique
  assert.equal(sets.aadhaars.size, 0); // All unique (nulls ignored)
  assert.equal(sets.pens.size, 1); // PEN100 is duplicate
  assert.ok(sets.pens.has('PEN100'));
});

test('evaluateStudentReadiness processes large student dataset efficiently without memory leaks', () => {
  const duplicateSets = {
    admissionNos: new Set(['DUP-001']),
    pens: new Set(['PEN-DUP']),
    aparNumbers: new Set(),
    aadhaars: new Set(),
  };

  const sampleSize = 1000;
  const students = Array.from({ length: sampleSize }, (_, i) => ({
    admission_no: i === 0 ? 'DUP-001' : `ADM-${i}`,
    student_name: `Student ${i}`,
    gender: i % 2 === 0 ? 'male' : 'female',
    dob: '2015-05-15',
    pen_number: i === 1 ? 'PEN-DUP' : (i % 3 === 0 ? null : `PEN${i.toString().padStart(8, '0')}`),
    apar_number: i % 4 === 0 ? null : '123456789012',
    aadhaar_number: i % 5 === 0 ? null : '987654321098',
    father_name: i % 10 === 0 ? null : `Father ${i}`,
    mother_name: null,
    guardian_name: null,
  }));

  const start = performance.now();
  const results = students.map(s => evaluateStudentReadiness(s, duplicateSets));
  const elapsed = performance.now() - start;

  assert.equal(results.length, sampleSize);
  // 1000 students should evaluate in under 100ms
  assert.ok(elapsed < 100, `Evaluation took ${elapsed.toFixed(2)}ms, expected < 100ms`);

  // First student has duplicate admission no
  assert.equal(results[0].status, UDISE_STATUS.DUPLICATE);
  // Second student has duplicate PEN
  assert.equal(results[1].status, UDISE_STATUS.DUPLICATE);
  // Tenth student (i=10) has no parent -> CRITICAL_INCOMPLETE
  assert.equal(results[10].status, UDISE_STATUS.CRITICAL_INCOMPLETE);
});
