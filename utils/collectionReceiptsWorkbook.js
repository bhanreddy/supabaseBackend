import XLSX from 'xlsx';

export const COLLECTION_RECEIPT_COLUMN_KEYS = [
    'fee_type',
    'receipt_no',
    'student_name',
    'father_name',
    'admission_no',
    'class_section',
    'payment_method',
    'time',
    'transaction_ref',
    'remarks',
    'received_by',
    'amount',
];

const DEFAULT_COLLECTION_RECEIPT_COLUMNS = [
    'time',
    'receipt_no',
    'student_name',
    'admission_no',
    'father_name',
    'class_section',
    'fee_type',
    'payment_method',
    'amount',
    'received_by',
];

const VALID_COLUMN_KEYS = new Set(COLLECTION_RECEIPT_COLUMN_KEYS);

export function normalizeCollectionReceiptColumns(value) {
    if (value == null || value === '') return [...DEFAULT_COLLECTION_RECEIPT_COLUMNS];
    const requested = Array.isArray(value) ? value : String(value).split(',');
    const normalized = [];
    for (const rawKey of requested) {
        const key = String(rawKey).trim();
        if (VALID_COLUMN_KEYS.has(key) && !normalized.includes(key)) normalized.push(key);
    }
    return normalized.length > 0 ? normalized : [...DEFAULT_COLLECTION_RECEIPT_COLUMNS];
}

function money(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
}

function formatPaidDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatPaidTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

const FIXED_COLUMNS = [
    // This also holds the "Payment mode" summary label below the table.
    { key: 'serial', heading: 'S.No.', width: 14, value: (_row, index) => index + 1 },
    { key: 'date', heading: 'Date', width: 14, value: (row) => formatPaidDate(row.paid_at) },
];

const OPTIONAL_COLUMNS = [
    { key: 'time', heading: 'Time', width: 12, value: (row) => formatPaidTime(row.paid_at) },
    { key: 'receipt_no', heading: 'Receipt No.', width: 18, value: (row) => row.receipt_no || '' },
    { key: 'student_name', heading: 'Student Name', width: 28, value: (row) => row.student_name || '' },
    { key: 'admission_no', heading: 'Admission No.', width: 16, value: (row) => row.admission_no || '' },
    { key: 'father_name', heading: 'Father Name', width: 22, value: (row) => row.father_name || '' },
    { key: 'class_section', heading: 'Class', width: 12, value: (row) => row.class_name || '' },
    { key: 'class_section', heading: 'Section', width: 12, value: (row) => row.section_name || '' },
    { key: 'fee_type', heading: 'Fee Type', width: 20, value: (row) => row.fee_type || '' },
    {
        key: 'payment_method',
        heading: 'Payment Mode',
        width: 14,
        value: (row) => String(row.payment_method || 'CASH').toUpperCase(),
    },
    {
        key: 'transaction_ref',
        heading: 'Transaction Reference',
        width: 24,
        value: (row) => row.transaction_ref || '',
    },
    { key: 'remarks', heading: 'Remarks', width: 30, value: (row) => row.remarks || '' },
    { key: 'amount', heading: 'Amount', width: 14, numeric: true, value: (row) => money(row.amount) },
    { key: 'received_by', heading: 'Received By', width: 20, value: (row) => row.received_by || '' },
];

export function buildCollectionReceiptsWorkbook({ schoolName, fromDate, toDate, rows, columns }) {
    const selectedColumns = normalizeCollectionReceiptColumns(columns);
    const visibleColumns = [
        ...FIXED_COLUMNS,
        ...selectedColumns.flatMap((key) => OPTIONAL_COLUMNS.filter((column) => column.key === key)),
    ];
    const generatedAt = new Date().toLocaleString('en-IN');
    const grandTotal = rows.reduce((sum, row) => sum + money(row.amount), 0);
    const byMode = {};
    for (const row of rows) {
        const mode = String(row.payment_method || 'CASH').toUpperCase();
        if (!byMode[mode]) byMode[mode] = { count: 0, total: 0 };
        byMode[mode].count += 1;
        byMode[mode].total += money(row.amount);
    }

    const headerRowIndex = 6;
    const amountColumnIndex = visibleColumns.findIndex((column) => column.key === 'amount');
    const totalCells = visibleColumns.map(() => '');
    totalCells[0] = 'TOTAL';
    if (amountColumnIndex >= 0) totalCells[amountColumnIndex] = grandTotal;

    const sheetRows = [
        [`${schoolName || 'School'} — Fee Collection Receipts`],
        ['From', fromDate, 'To', toDate],
        ['Generated', generatedAt],
        [],
        ['Receipts', rows.length, 'Grand Total', grandTotal],
        [],
        visibleColumns.map((column) => column.heading),
        ...rows.map((row, index) => visibleColumns.map((column) => column.value(row, index))),
        [],
        totalCells,
        [],
        ['Payment mode', 'Count', 'Amount'],
        ...Object.entries(byMode)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([mode, bucket]) => [mode, bucket.count, bucket.total]),
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
    const lastTableColumnIndex = visibleColumns.length - 1;
    const titleLastColumnIndex = Math.max(lastTableColumnIndex, 3);
    worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: titleLastColumnIndex } }];
    worksheet['!cols'] = visibleColumns.map((column) => ({ wch: column.width }));
    const lastDataRow = headerRowIndex + rows.length;
    const lastTableColumn = XLSX.utils.encode_col(lastTableColumnIndex);
    worksheet['!autofilter'] = {
        ref: `A${headerRowIndex + 1}:${lastTableColumn}${Math.max(headerRowIndex + 1, lastDataRow + 1)}`,
    };
    worksheet['!freeze'] = { xSplit: 0, ySplit: headerRowIndex + 1 };

    const headerStyle = {
        fill: { fgColor: { rgb: '5B21B6' } },
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    };
    for (let col = 0; col < visibleColumns.length; col += 1) {
        const cell = XLSX.utils.encode_cell({ r: headerRowIndex, c: col });
        if (worksheet[cell]) worksheet[cell].s = headerStyle;
    }

    const currencyFormat = '₹#,##0.00';
    if (worksheet.D5) worksheet.D5.z = currencyFormat;
    if (amountColumnIndex >= 0) {
        for (let row = headerRowIndex + 1; row <= lastDataRow; row += 1) {
            const cell = XLSX.utils.encode_cell({ r: row, c: amountColumnIndex });
            if (worksheet[cell]) worksheet[cell].z = currencyFormat;
        }
    }

    const totalRow = lastDataRow + 2;
    for (let col = 0; col < visibleColumns.length; col += 1) {
        const cell = XLSX.utils.encode_cell({ r: totalRow, c: col });
        if (worksheet[cell]) {
            worksheet[cell].s = { font: { bold: true }, fill: { fgColor: { rgb: 'FEF3C7' } } };
        }
    }
    if (amountColumnIndex >= 0) {
        const totalCell = XLSX.utils.encode_cell({ r: totalRow, c: amountColumnIndex });
        if (worksheet[totalCell]) worksheet[totalCell].z = currencyFormat;
    }

    const modeStart = totalRow + 3;
    for (let i = 0; i < Object.keys(byMode).length; i += 1) {
        const cell = XLSX.utils.encode_cell({ r: modeStart + i, c: 2 });
        if (worksheet[cell]) worksheet[cell].z = currencyFormat;
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Collection Receipts');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}
