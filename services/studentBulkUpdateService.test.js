import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  getStudentBulkUpdateField,
  parseStudentBulkUpdateBuffer,
  validateStudentBulkUpdateRows,
} from './studentBulkUpdateService.js';

function workbookBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Updates');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function studentDb(students) {
  const db = async (strings) => {
    const query = Array.isArray(strings) ? strings.join(' ') : String(strings);
    if (query.includes('FROM students s')) return students;
    if (query.includes('aadhaar_number AS value')) {
      return students
        .filter((student) => student.aadhaar_number)
        .map((student) => ({ id: student.id, value: student.aadhaar_number }));
    }
    throw new Error(`Unexpected test query: ${query.slice(0, 80)}`);
  };
  db.array = (values) => values;
  return db;
}

test('field registry exposes the requested high-value student details', () => {
  assert.equal(getStudentBulkUpdateField('aadhaar_number')?.label, 'Aadhaar number');
  assert.equal(getStudentBulkUpdateField('admission_date')?.inputType, 'date');
  assert.equal(getStudentBulkUpdateField('date_of_birth')?.target, 'person');
  assert.equal(getStudentBulkUpdateField('gender')?.referenceTable, 'genders');
  assert.equal(getStudentBulkUpdateField('mobile_number')?.target, 'contact');
  assert.equal(getStudentBulkUpdateField('father_name')?.label, 'Father name');
  assert.equal(getStudentBulkUpdateField('father_name')?.target, 'father');
  assert.equal(getStudentBulkUpdateField('not_a_real_field'), null);
});

test('workbook parser accepts Admission Number plus selected field and preserves numeric Aadhaar', () => {
  const parsed = parseStudentBulkUpdateBuffer(workbookBuffer([
    ['Admission Number', 'Aadhaar Number'],
    ['1001', 123456789012],
    ['1002', '2345 6789 0123'],
  ]), 'aadhaar_number');

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].admissionNo, '1001');
  assert.equal(parsed[0].rawValue, 123456789012);
  assert.equal(parsed[1].formattedValue, '2345 6789 0123');
});

test('admission-number changes require separate current and new columns', () => {
  const parsed = parseStudentBulkUpdateBuffer(workbookBuffer([
    ['Current Admission Number', 'New Admission Number'],
    ['1001', '2051'],
  ]), 'admission_number');
  assert.deepEqual(
    { admissionNo: parsed[0].admissionNo, newNumber: parsed[0].formattedValue },
    { admissionNo: '1001', newNumber: '2051' },
  );

  assert.throws(
    () => parseStudentBulkUpdateBuffer(workbookBuffer([
      ['Admission Number'],
      ['1001'],
    ]), 'admission_number'),
    /Missing required columns/,
  );
});

test('preview validation separates ready, unchanged, invalid and explicit clear rows', async () => {
  const db = studentDb([
    {
      id: '00000000-0000-0000-0000-000000000001',
      person_id: '10000000-0000-0000-0000-000000000001',
      admission_no: '1001',
      aadhaar_number: '123456789012',
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      person_id: '10000000-0000-0000-0000-000000000002',
      admission_no: '1002',
      aadhaar_number: null,
    },
    {
      id: '00000000-0000-0000-0000-000000000003',
      person_id: '10000000-0000-0000-0000-000000000003',
      admission_no: '1003',
      aadhaar_number: '345678901234',
    },
  ]);

  const parsedRows = [
    { rowNumber: 2, admissionNo: '1001', rawValue: '123456789012', formattedValue: '123456789012' },
    { rowNumber: 3, admissionNo: '1002', rawValue: '234567890123', formattedValue: '234567890123' },
    { rowNumber: 4, admissionNo: '1003', rawValue: '', formattedValue: '' },
    { rowNumber: 5, admissionNo: '9999', rawValue: '456789012345', formattedValue: '456789012345' },
  ];

  const withoutClear = await validateStudentBulkUpdateRows(db, {
    schoolId: 7,
    fieldKey: 'aadhaar_number',
    parsedRows,
    allowBlankClear: false,
  });
  assert.deepEqual(withoutClear.map((row) => row.status), ['unchanged', 'valid', 'invalid', 'invalid']);
  assert.match(withoutClear[2].errorMessage, /Enable "clear blank cells"/);

  const withClear = await validateStudentBulkUpdateRows(db, {
    schoolId: 7,
    fieldKey: 'aadhaar_number',
    parsedRows,
    allowBlankClear: true,
  });
  assert.deepEqual(withClear.map((row) => row.status), ['unchanged', 'valid', 'valid', 'invalid']);
  assert.equal(withClear[2].normalizedValue, null);
});

test('duplicate admission numbers invalidate every duplicate instead of silently choosing one', async () => {
  const db = studentDb([{
    id: '00000000-0000-0000-0000-000000000001',
    person_id: '10000000-0000-0000-0000-000000000001',
    admission_no: '1001',
    aadhaar_number: null,
  }]);
  const rows = await validateStudentBulkUpdateRows(db, {
    schoolId: 7,
    fieldKey: 'aadhaar_number',
    allowBlankClear: false,
    parsedRows: [
      { rowNumber: 2, admissionNo: '1001', rawValue: '123456789012', formattedValue: '123456789012' },
      { rowNumber: 3, admissionNo: '1001', rawValue: '234567890123', formattedValue: '234567890123' },
    ],
  });
  assert.deepEqual(rows.map((row) => row.status), ['invalid', 'invalid']);
  assert.ok(rows.every((row) => /Duplicate Admission Number/.test(row.errorMessage)));
});
