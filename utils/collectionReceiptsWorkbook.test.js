import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';
import {
    buildCollectionReceiptsWorkbook,
    normalizeCollectionReceiptColumns,
} from './collectionReceiptsWorkbook.js';

const sampleRows = [
    {
        amount: 5000,
        paid_at: '2026-08-02T12:15:00+05:30',
        payment_method: 'cash',
        transaction_ref: 'CASH-42',
        remarks: 'Term 1 books',
        receipt_no: 'RCT-1001',
        student_name: 'Ravi Kumar',
        admission_no: '194',
        father_name: 'Mohan Kumar',
        class_name: '5',
        section_name: 'Star',
        fee_type: 'SCHOOL FEE',
        received_by: 'Bhanu Chary',
    },
];

function readSheetRows(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets['Collection Receipts'];
    return XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true });
}

test('normalizes requested receipt columns and rejects unknown values', () => {
    assert.deepEqual(
        normalizeCollectionReceiptColumns('remarks,unknown,payment_method,remarks,amount'),
        ['remarks', 'payment_method', 'amount'],
    );
    assert.ok(normalizeCollectionReceiptColumns('').includes('time'));
});

test('receipt workbook uses the selected columns and includes remarks', () => {
    const buffer = buildCollectionReceiptsWorkbook({
        schoolName: 'Slate School',
        fromDate: '2026-08-02',
        toDate: '2026-08-02',
        rows: sampleRows,
        columns: ['remarks', 'receipt_no', 'student_name', 'payment_method', 'amount'],
    });
    const rows = readSheetRows(buffer);

    assert.deepEqual(rows[6], [
        'S.No.',
        'Date',
        'Remarks',
        'Receipt No.',
        'Student Name',
        'Payment Mode',
        'Amount',
    ]);
    assert.equal(rows[7][2], 'Term 1 books');
    assert.equal(rows[7][5], 'CASH');
    assert.equal(rows[7][6], 5000);
    assert.ok(!rows[6].includes('Time'));
    assert.ok(!rows[6].includes('Received By'));
});

test('class and section are controlled by one saved option', () => {
    const buffer = buildCollectionReceiptsWorkbook({
        schoolName: 'Slate School',
        fromDate: '2026-08-02',
        toDate: '2026-08-02',
        rows: sampleRows,
        columns: ['class_section'],
    });
    const rows = readSheetRows(buffer);

    assert.deepEqual(rows[6], ['S.No.', 'Date', 'Class', 'Section']);
    assert.deepEqual(rows[7].slice(2), ['5', 'Star']);
});
