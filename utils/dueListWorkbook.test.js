import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';
import { buildDueListWorkbook } from './dueListWorkbook.js';

const sampleRow = {
    admission_no: 'ADM-001',
    student_name: 'Ananya Reddy',
    father_name: 'Suresh Reddy',
    contact_number: '+91 98765 43210',
    class_name: '5',
    section_name: 'A',
    roll_number: '12',
    village: 'Central Stop',
    route_name: 'Route 1',
    school_total_fee: '15000',
    discount_given: '1000',
    final_fee: '14000',
    paid_fee: '9000',
    due_amount: '5000',
    transport_pending_fee: '2400',
    fee_item_count: 3,
    earliest_due_date: '2026-07-15',
    is_overdue: true,
};

function readWorkbook(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets['Pending Fees'];
    return {
        worksheet,
        rows: XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true }),
    };
}

test('due-list workbook includes father, linked mobile, and transport pending fee without shifting school fee totals', () => {
    const { worksheet, rows } = readWorkbook(buildDueListWorkbook({
        schoolName: 'Slate School',
        academicYear: '2026-27',
        rows: [sampleRow],
        filters: {},
    }));

    assert.deepEqual(rows[7], [
        'S.No.',
        'Admission No.',
        'Student Name',
        "Father's Name",
        'Mobile Number',
        'Class',
        'Section',
        'Roll No.',
        'Village / Stop',
        'Route',
        'School Total Fee',
        'Discount Given',
        'Final Fee',
        'Paid Fee',
        'School Due Amount',
        'Transport Pending Fee',
        'Fee Items',
        'Earliest Due Date',
        'Overdue',
    ]);
    assert.equal(rows[8][3], 'Suresh Reddy');
    assert.equal(rows[8][4], '+91 98765 43210');
    assert.deepEqual(rows[8].slice(10, 16), [15000, 1000, 14000, 9000, 5000, 2400]);
    assert.deepEqual(rows[10].slice(10, 16), [15000, 1000, 14000, 9000, 5000, 2400]);
    assert.equal(worksheet['!autofilter'].ref, 'A8:S9');
});

test('due-list workbook keeps missing father and linked mobile data blank', () => {
    const { rows } = readWorkbook(buildDueListWorkbook({
        schoolName: 'Slate School',
        academicYear: '2026-27',
        rows: [{ ...sampleRow, father_name: null, contact_number: null }],
        filters: {},
    }));

    assert.equal(rows[8][3], '');
    assert.equal(rows[8][4], '');
});

test('due-list workbook leaves unavailable transport fee blank but keeps configured zero', () => {
    const { rows } = readWorkbook(buildDueListWorkbook({
        schoolName: 'Slate School',
        academicYear: '2026-27',
        rows: [
            { ...sampleRow, transport_pending_fee: null },
            { ...sampleRow, transport_pending_fee: '0' },
        ],
        filters: {},
    }));

    assert.equal(rows[8][15], '');
    assert.equal(rows[9][15], 0);
});

test('due-list workbook records a selected fee type in the applied filters', () => {
    const { rows } = readWorkbook(buildDueListWorkbook({
        schoolName: 'Slate School',
        academicYear: '2026-27',
        rows: [sampleRow],
        filters: { fee_type_name: 'Tuition Fee' },
    }));

    assert.equal(rows[2][1], 'Fee type: Tuition Fee');
});
