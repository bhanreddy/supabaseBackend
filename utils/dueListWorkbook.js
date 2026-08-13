import XLSX from 'xlsx';

function money(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
}

export function buildDueListWorkbook({ schoolName, academicYear, rows, filters }) {
    const generatedAt = new Date().toLocaleString('en-IN');
    const totals = rows.reduce((acc, row) => ({
        schoolTotal: acc.schoolTotal + money(row.school_total_fee),
        discount: acc.discount + money(row.discount_given),
        finalFee: acc.finalFee + money(row.final_fee),
        paid: acc.paid + money(row.paid_fee),
        due: acc.due + money(row.due_amount),
    }), { schoolTotal: 0, discount: 0, finalFee: 0, paid: 0, due: 0 });

    const filtersText = [
        filters.class_name ? `Class: ${filters.class_name}` : null,
        filters.section_name ? `Section: ${filters.section_name}` : null,
        filters.village_name ? `Village: ${filters.village_name}` : null,
        filters.overdue_only ? 'Only overdue dues' : null,
    ].filter(Boolean).join(' | ') || 'Outstanding dues and waived students';

    const sheetRows = [
        [`${schoolName || 'School'} — Pending Fees Due List`],
        ['Academic Year', academicYear],
        ['Filters', filtersText],
        ['Generated', generatedAt],
        [],
        ['Students', rows.length, 'School Total Fee', totals.schoolTotal, 'Discount Given', totals.discount, 'Final Fee', totals.finalFee, 'Paid Fee', totals.paid, 'Due Amount', totals.due],
        [],
        ['S.No.', 'Admission No.', 'Student Name', "Father's / Guardian Name", 'Contact Number', 'Class', 'Section', 'Roll No.', 'Village / Stop', 'Route', 'School Total Fee', 'Discount Given', 'Final Fee', 'Paid Fee', 'Due Amount', 'Fee Items', 'Earliest Due Date', 'Overdue'],
        ...rows.map((row, index) => [
            index + 1,
            row.admission_no || '',
            row.student_name || '',
            row.father_name || '',
            row.contact_number || '',
            row.class_name || '',
            row.section_name || '',
            row.roll_number ?? '',
            row.village || 'Not assigned',
            row.route_name || '',
            money(row.school_total_fee),
            money(row.discount_given),
            money(row.final_fee),
            money(row.paid_fee),
            money(row.due_amount),
            Number(row.fee_item_count || 0),
            row.earliest_due_date || '',
            row.is_overdue ? 'Yes' : 'No',
        ]),
        [],
        ['TOTAL', '', '', '', '', '', '', '', '', '', totals.schoolTotal, totals.discount, totals.finalFee, totals.paid, totals.due],
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
    worksheet['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 17 } },
    ];
    worksheet['!cols'] = [
        { wch: 8 }, { wch: 16 }, { wch: 28 }, { wch: 26 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 10 },
        { wch: 22 }, { wch: 20 }, { wch: 17 }, { wch: 17 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 10 },
        { wch: 17 }, { wch: 10 },
    ];
    worksheet['!autofilter'] = { ref: `A8:R${Math.max(8, rows.length + 8)}` };
    worksheet['!freeze'] = { xSplit: 0, ySplit: 8 };

    const headerStyle = {
        fill: { fgColor: { rgb: '5B21B6' } },
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    };
    const summaryLabelStyle = { font: { bold: true, color: { rgb: '4C1D95' } }, fill: { fgColor: { rgb: 'EDE9FE' } } };
    const currencyFormat = '₹#,##0.00';

    for (let col = 0; col < 18; col += 1) {
        const cell = XLSX.utils.encode_cell({ r: 7, c: col });
        if (worksheet[cell]) worksheet[cell].s = headerStyle;
    }
    for (const cell of ['A1', 'A6', 'C6', 'E6', 'G6', 'I6', 'K6']) {
        if (worksheet[cell]) worksheet[cell].s = summaryLabelStyle;
    }
    for (const cell of ['D6', 'F6', 'H6', 'J6', 'L6']) {
        if (worksheet[cell]) worksheet[cell].z = currencyFormat;
    }
    for (let row = 8; row <= rows.length + 8; row += 1) {
        for (const col of [10, 11, 12, 13, 14]) {
            const cell = XLSX.utils.encode_cell({ r: row, c: col });
            if (worksheet[cell]) worksheet[cell].z = currencyFormat;
        }
    }
    const totalRow = rows.length + 9;
    for (let col = 0; col < 18; col += 1) {
        const cell = XLSX.utils.encode_cell({ r: totalRow, c: col });
        if (worksheet[cell]) worksheet[cell].s = { font: { bold: true }, fill: { fgColor: { rgb: 'FEF3C7' } } };
    }
    for (const col of [10, 11, 12, 13, 14]) {
        const cell = XLSX.utils.encode_cell({ r: totalRow, c: col });
        if (worksheet[cell]) worksheet[cell].z = currencyFormat;
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Pending Fees');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}
