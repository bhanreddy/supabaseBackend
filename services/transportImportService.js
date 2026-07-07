import XLSX from 'xlsx';

export const MAX_IMPORT_ROWS = 2000;
export const COMMIT_CHUNK_SIZE = 250;
export const PREVIEW_ROW_LIMIT = 200;
export const PREVIEW_INSERT_CHUNK_SIZE = 500;

const HEADER_ALIASES = {
  fullName: ['full name', 'fullname', 'name', 'student name', 'student_name'],
  admissionNo: ['admission number', 'admission no', 'admission_no', 'admissionno', 'adm no', 'adm_no'],
  stopName: ['stop name', 'stop_name', 'stop', 'boarding stop', 'boarding_stop'],
};

const normalizeHeader = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const normalizeStopKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const normalizePersonName = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

export const detectColumnMap = (headers) => {
  const map = { fullName: null, admissionNo: null, stopName: null };
  for (let i = 0; i < headers.length; i += 1) {
    const h = normalizeHeader(headers[i]);
    if (!h) continue;
    if (map.fullName == null && HEADER_ALIASES.fullName.includes(h)) map.fullName = i;
    if (map.admissionNo == null && HEADER_ALIASES.admissionNo.includes(h)) map.admissionNo = i;
    if (map.stopName == null && HEADER_ALIASES.stopName.includes(h)) map.stopName = i;
  }
  return map;
};

export const parseExcelBuffer = (buffer) => {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('Excel file has no worksheets');
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (!rows.length) {
    throw new Error('Excel file is empty');
  }

  const headerRow = rows[0].map((c) => String(c ?? '').trim());
  const colMap = detectColumnMap(headerRow);
  if (colMap.admissionNo == null || colMap.stopName == null) {
    throw new Error(
      'Missing required columns. Expected headers like: Full Name, Admission Number, Stop Name',
    );
  }

  const parsed = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const fullName = colMap.fullName != null ? String(row[colMap.fullName] ?? '').trim() : '';
    const admissionNo = String(row[colMap.admissionNo] ?? '').trim();
    const stopName = String(row[colMap.stopName] ?? '').trim();
    if (!admissionNo && !stopName && !fullName) continue;
    parsed.push({
      rowNumber: i + 1,
      fullName: fullName || null,
      admissionNo,
      stopName,
    });
  }

  if (parsed.length === 0) {
    throw new Error('No data rows found in Excel file');
  }
  if (parsed.length > MAX_IMPORT_ROWS) {
    throw new Error(`Too many rows (${parsed.length}). Maximum allowed is ${MAX_IMPORT_ROWS}`);
  }

  return parsed;
};

export const isLikelyExcelBuffer = (buffer, filename = '') => {
  if (!buffer || buffer.length < 4) return false;
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.csv')) return true;
  // ZIP (xlsx)
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return true;
  // OLE (xls)
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf) return true;
  return false;
};

export const resolveCurrentAcademicYear = async (db, schoolId) => {
  const [ay] = await db`
    SELECT id, code
    FROM academic_years
    WHERE CURRENT_DATE BETWEEN start_date AND end_date
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return ay || null;
};

const loadStudentMap = async (db, schoolId, admissionNumbers) => {
  if (!admissionNumbers.length) return new Map();
  const rows = await db`
    SELECT s.id, s.admission_no, p.display_name
    FROM students s
    JOIN persons p ON s.person_id = p.id
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND s.admission_no = ANY(${db.array(admissionNumbers)}::varchar[])
  `;
  return new Map(rows.map((r) => [String(r.admission_no), r]));
};

const loadStopLookup = async (db, schoolId) => {
  const rows = await db`
    SELECT
      ts.id AS stop_id,
      ts.name AS stop_name,
      ts.stop_order,
      tr.id AS route_id,
      tr.name AS route_name,
      tr.bus_id
    FROM transport_stops ts
    JOIN transport_routes tr ON tr.id = ts.route_id AND tr.school_id = ${schoolId}
    WHERE ts.school_id = ${schoolId}
      AND ts.deleted_at IS NULL
      AND tr.deleted_at IS NULL
    ORDER BY tr.name ASC, ts.stop_order ASC
  `;

  const byKey = new Map();
  for (const row of rows) {
    const key = normalizeStopKey(row.stop_name);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return byKey;
};

export const validateImportRows = (parsedRows, studentMap, stopLookup) => {
  const lastIndexByAdmission = new Map();
  const validated = parsedRows.map((row, idx) => {
    const base = { ...row, status: 'valid', errorMessage: null, warningMessage: null, studentId: null, stopId: null, routeId: null, routeName: null, busId: null };

    if (!row.admissionNo) {
      return { ...base, status: 'invalid', errorMessage: 'Admission Number is required' };
    }
    if (!row.stopName) {
      return { ...base, status: 'invalid', errorMessage: 'Stop Name is required' };
    }

    const student = studentMap.get(row.admissionNo);
    if (!student) {
      return { ...base, status: 'invalid', errorMessage: 'Student not found for this Admission Number' };
    }

    const stop = stopLookup.get(normalizeStopKey(row.stopName));
    if (!stop) {
      return { ...base, status: 'invalid', errorMessage: 'Stop Name not found on any active route' };
    }

    if (row.fullName) {
      const expected = normalizePersonName(student.display_name);
      const provided = normalizePersonName(row.fullName);
      if (expected && provided && expected !== provided) {
        base.warningMessage = `Name mismatch: file has "${row.fullName}", system has "${student.display_name}"`;
      }
    }

    lastIndexByAdmission.set(row.admissionNo, idx);
    return {
      ...base,
      studentId: student.id,
      stopId: stop.stop_id,
      routeId: stop.route_id,
      routeName: stop.route_name,
      busId: stop.bus_id,
    };
  });

  for (const [admissionNo, keepIdx] of lastIndexByAdmission.entries()) {
    for (let i = 0; i < validated.length; i += 1) {
      if (i === keepIdx) continue;
      if (validated[i].admissionNo !== admissionNo || validated[i].status !== 'valid') continue;
      validated[i] = {
        ...validated[i],
        status: 'invalid',
        errorMessage: 'Duplicate Admission Number in file (later row kept)',
        studentId: null,
        stopId: null,
        routeId: null,
        routeName: null,
        busId: null,
      };
    }
  }

  return validated;
};

const insertImportRowsBulk = async (tx, batchId, schoolId, rows) => {
  if (!rows.length) return;

  await tx`
    INSERT INTO transport_import_rows (
      batch_id, school_id, row_number, full_name, admission_no, stop_name,
      student_id, stop_id, route_id, route_name, status, error_message, warning_message
    )
    SELECT
      ${batchId},
      ${schoolId},
      u.row_number,
      u.full_name,
      u.admission_no,
      u.stop_name,
      u.student_id,
      u.stop_id,
      u.route_id,
      u.route_name,
      u.status,
      u.error_message,
      u.warning_message
    FROM unnest(
      ${tx.array(rows.map((r) => r.rowNumber))}::int[],
      ${tx.array(rows.map((r) => r.fullName))}::text[],
      ${tx.array(rows.map((r) => r.admissionNo))}::text[],
      ${tx.array(rows.map((r) => r.stopName))}::text[],
      ${tx.array(rows.map((r) => r.studentId))}::uuid[],
      ${tx.array(rows.map((r) => r.stopId))}::uuid[],
      ${tx.array(rows.map((r) => r.routeId))}::uuid[],
      ${tx.array(rows.map((r) => r.routeName))}::text[],
      ${tx.array(rows.map((r) => r.status))}::text[],
      ${tx.array(rows.map((r) => r.errorMessage))}::text[],
      ${tx.array(rows.map((r) => r.warningMessage))}::text[]
    ) AS u(
      row_number, full_name, admission_no, stop_name,
      student_id, stop_id, route_id, route_name,
      status, error_message, warning_message
    )
  `;
};

export const createPreviewBatch = async (db, {
  schoolId,
  uploadedBy,
  originalFilename,
  academicYearId,
  parsedRows,
}) => {
  const admissionNumbers = [...new Set(parsedRows.map((r) => r.admissionNo).filter(Boolean))];
  const [studentMap, stopLookup] = await Promise.all([
    loadStudentMap(db, schoolId, admissionNumbers),
    loadStopLookup(db, schoolId),
  ]);

  const validated = validateImportRows(parsedRows, studentMap, stopLookup);
  const validRows = validated.filter((r) => r.status === 'valid').length;
  const invalidRows = validated.filter((r) => r.status === 'invalid').length;
  const warningRows = validated.filter((r) => r.warningMessage).length;

  return db.begin(async (tx) => {
    const [batch] = await tx`
      INSERT INTO transport_import_batches (
        school_id, uploaded_by, original_filename, academic_year_id,
        status, total_rows, valid_rows, failed_rows, skipped_rows
      )
      VALUES (
        ${schoolId}, ${uploadedBy}, ${originalFilename}, ${academicYearId},
        'preview', ${validated.length}, ${validRows}, ${invalidRows}, 0
      )
      RETURNING *
    `;

    for (let i = 0; i < validated.length; i += PREVIEW_INSERT_CHUNK_SIZE) {
      const chunk = validated.slice(i, i + PREVIEW_INSERT_CHUNK_SIZE);
      await insertImportRowsBulk(tx, batch.id, schoolId, chunk);
    }

    return {
      batch,
      summary: {
        total_rows: validated.length,
        valid_rows: validRows,
        invalid_rows: invalidRows,
        warning_rows: warningRows,
      },
      rows: validated.slice(0, PREVIEW_ROW_LIMIT).map((r) => ({
        row_number: r.rowNumber,
        full_name: r.fullName,
        admission_no: r.admissionNo,
        stop_name: r.stopName,
        route_name: r.routeName,
        status: r.status,
        error_message: r.errorMessage,
        warning_message: r.warningMessage,
      })),
    };
  });
};

const upsertAssignmentsChunk = async (tx, schoolId, academicYearId, rows) => {
  if (!rows.length) return [];

  const studentIds = rows.map((r) => r.student_id);
  const routeIds = rows.map((r) => r.route_id);
  const stopIds = rows.map((r) => r.stop_id);
  const busIds = rows.map((r) => r.bus_id);

  const upserted = await tx`
    INSERT INTO student_transport (
      school_id, student_id, route_id, stop_id, bus_id, academic_year_id, is_active
    )
    SELECT
      ${schoolId},
      u.student_id,
      u.route_id,
      u.stop_id,
      u.bus_id,
      ${academicYearId},
      TRUE
    FROM unnest(
      ${tx.array(studentIds)}::uuid[],
      ${tx.array(routeIds)}::uuid[],
      ${tx.array(stopIds)}::uuid[],
      ${tx.array(busIds)}::uuid[]
    ) AS u(student_id, route_id, stop_id, bus_id)
    ON CONFLICT (student_id, academic_year_id)
    DO UPDATE SET
      school_id = EXCLUDED.school_id,
      route_id = EXCLUDED.route_id,
      stop_id = EXCLUDED.stop_id,
      bus_id = EXCLUDED.bus_id,
      is_active = TRUE
    RETURNING student_id
  `;

  return upserted.map((r) => String(r.student_id));
};

export const commitImportBatch = async (db, { schoolId, batchId }) => {
  const [batch] = await db`
    SELECT *
    FROM transport_import_batches
    WHERE id = ${batchId} AND school_id = ${schoolId}
  `;
  if (!batch) {
    const err = new Error('Import batch not found');
    err.statusCode = 404;
    throw err;
  }
  if (batch.status === 'committed') {
    const err = new Error('Import batch already committed');
    err.statusCode = 409;
    throw err;
  }

  const validRows = await db`
    SELECT
      ir.id,
      ir.student_id,
      ir.stop_id,
      ir.route_id,
      tr.bus_id
    FROM transport_import_rows ir
    LEFT JOIN transport_routes tr ON tr.id = ir.route_id AND tr.school_id = ${schoolId}
    WHERE ir.batch_id = ${batchId}
      AND ir.school_id = ${schoolId}
      AND ir.status = 'valid'
    ORDER BY ir.row_number ASC
  `;

  if (validRows.length === 0) {
    const err = new Error('No valid rows to import');
    err.statusCode = 400;
    throw err;
  }

  // Re-validate student + stop still exist
  const studentIds = [...new Set(validRows.map((r) => r.student_id).filter(Boolean))];
  const stopIds = [...new Set(validRows.map((r) => r.stop_id).filter(Boolean))];

  const [activeStudents, activeStops] = await Promise.all([
    db`
      SELECT id FROM students
      WHERE school_id = ${schoolId}
        AND deleted_at IS NULL
        AND id = ANY(${db.array(studentIds)}::uuid[])
    `,
    db`
      SELECT ts.id, tr.id AS route_id, tr.bus_id
      FROM transport_stops ts
      JOIN transport_routes tr ON tr.id = ts.route_id AND tr.school_id = ${schoolId}
      WHERE ts.school_id = ${schoolId}
        AND ts.deleted_at IS NULL
        AND tr.deleted_at IS NULL
        AND ts.id = ANY(${db.array(stopIds)}::uuid[])
    `,
  ]);

  const activeStudentSet = new Set(activeStudents.map((s) => String(s.id)));
  const stopMap = new Map(activeStops.map((s) => [String(s.id), s]));

  const commitRows = [];
  const failedRowIds = [];

  for (const row of validRows) {
    if (!activeStudentSet.has(String(row.student_id)) || !stopMap.has(String(row.stop_id))) {
      failedRowIds.push(row.id);
      continue;
    }
    const stop = stopMap.get(String(row.stop_id));
    commitRows.push({
      id: row.id,
      student_id: row.student_id,
      route_id: stop.route_id,
      stop_id: row.stop_id,
      bus_id: stop.bus_id ?? null,
    });
  }

  let successCount = 0;
  const invalidCount = batch.total_rows - batch.valid_rows;

  await db.begin(async (tx) => {
    for (let i = 0; i < commitRows.length; i += COMMIT_CHUNK_SIZE) {
      const chunk = commitRows.slice(i, i + COMMIT_CHUNK_SIZE);
      const successStudentIds = await upsertAssignmentsChunk(
        tx,
        schoolId,
        batch.academic_year_id,
        chunk,
      );
      successCount += successStudentIds.length;

      const chunkRowIds = chunk.map((r) => r.id);
      await tx`
        UPDATE transport_import_rows
        SET status = 'success'
        WHERE id = ANY(${tx.array(chunkRowIds)}::uuid[])
          AND school_id = ${schoolId}
      `;
    }

    if (failedRowIds.length) {
      await tx`
        UPDATE transport_import_rows
        SET status = 'failed',
            error_message = COALESCE(error_message, 'Student or stop no longer available at commit time')
        WHERE id = ANY(${tx.array(failedRowIds)}::uuid[])
          AND school_id = ${schoolId}
      `;
    }

    await tx`
      UPDATE transport_import_batches
      SET status = 'committed',
          success_rows = ${successCount},
          failed_rows = ${failedRowIds.length + invalidCount},
          committed_at = NOW()
      WHERE id = ${batchId} AND school_id = ${schoolId}
    `;
  });

  return {
    batch_id: batchId,
    success_rows: successCount,
    failed_rows: failedRowIds.length + invalidCount,
    skipped_rows: invalidCount,
  };
};

export const getImportBatch = async (db, { schoolId, batchId, page = 1, limit = 100 }) => {
  const [batch] = await db`
    SELECT b.*, ay.code AS academic_year_code, p.display_name AS uploaded_by_name
    FROM transport_import_batches b
    LEFT JOIN academic_years ay ON ay.id = b.academic_year_id
    LEFT JOIN users u ON u.id = b.uploaded_by
    LEFT JOIN persons p ON p.id = u.person_id
    WHERE b.id = ${batchId} AND b.school_id = ${schoolId}
  `;
  if (!batch) return null;

  const offset = (page - 1) * limit;
  const rows = await db`
    SELECT *
    FROM transport_import_rows
    WHERE batch_id = ${batchId} AND school_id = ${schoolId}
    ORDER BY row_number ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return { batch, rows };
};

export const listImportBatches = async (db, { schoolId, page = 1, limit = 20 }) => {
  const offset = (page - 1) * limit;
  const batches = await db`
    SELECT b.*, ay.code AS academic_year_code, p.display_name AS uploaded_by_name
    FROM transport_import_batches b
    LEFT JOIN academic_years ay ON ay.id = b.academic_year_id
    LEFT JOIN users u ON u.id = b.uploaded_by
    LEFT JOIN persons p ON p.id = u.person_id
    WHERE b.school_id = ${schoolId}
    ORDER BY b.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return batches;
};

export const buildFailureExportBuffer = async (db, { schoolId, batchId }) => {
  const rows = await db`
    SELECT row_number, full_name, admission_no, stop_name, route_name, error_message, warning_message, status
    FROM transport_import_rows
    WHERE batch_id = ${batchId}
      AND school_id = ${schoolId}
      AND status IN ('invalid', 'failed')
    ORDER BY row_number ASC
  `;

  const sheetRows = [
    ['Row Number', 'Full Name', 'Admission Number', 'Stop Name', 'Route', 'Error', 'Warning', 'Status'],
    ...rows.map((r) => [
      r.row_number,
      r.full_name || '',
      r.admission_no || '',
      r.stop_name || '',
      r.route_name || '',
      r.error_message || '',
      r.warning_message || '',
      r.status,
    ]),
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Failures');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

/**
 * Blank import template with required headers and example rows.
 */
export const buildImportTemplateBuffer = () => {
  const importSheet = XLSX.utils.aoa_to_sheet([
    ['Full Name', 'Admission Number', 'Stop Name'],
    ['Ravi Kumar', 'ADM-2024-001', 'Main Gate'],
    ['Priya Sharma', 'ADM-2024-042', 'Sector 12'],
  ]);

  importSheet['!cols'] = [{ wch: 24 }, { wch: 20 }, { wch: 20 }];

  const instructions = XLSX.utils.aoa_to_sheet([
    ['Bulk Student Stop Assignment — Instructions'],
    [''],
    ['Required columns (row 1 of Import sheet):'],
    ['  Full Name', 'Optional — used for preview only; matching uses Admission Number'],
    ['  Admission Number', 'Required — must match an active student admission number exactly'],
    ['  Stop Name', 'Required — must match an existing stop on an active route'],
    [''],
    ['Notes:'],
    ['  • Delete the two example rows before uploading your real data'],
    ['  • One student per row; duplicate admission numbers keep the last row only'],
    ['  • If the same stop name exists on multiple routes, the first route (A–Z) is used'],
    ['  • Assignments apply to the current academic year'],
  ]);
  instructions['!cols'] = [{ wch: 22 }, { wch: 58 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, importSheet, 'Import');
  XLSX.utils.book_append_sheet(workbook, instructions, 'Instructions');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};
