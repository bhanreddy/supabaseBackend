import XLSX from 'xlsx';

export const MAX_STUDENT_BULK_UPDATE_ROWS = 2000;
export const STUDENT_BULK_UPDATE_PREVIEW_LIMIT = 250;
const INSERT_CHUNK_SIZE = 500;

const HEADER_ALIASES = {
  admissionLookup: [
    'admission number',
    'admission no',
    'admission_no',
    'admissionnumber',
    'adm no',
    'adm_no',
    'current admission number',
    'current admission no',
  ],
};

const FIELD_DEFINITIONS = [
  {
    key: 'aadhaar_number',
    label: 'Aadhaar number',
    templateHeader: 'Aadhaar Number',
    aliases: ['aadhaar', 'aadhaar no', 'aadhaar number', 'adhaar', 'adhaar no', 'adhaar number'],
    inputType: 'aadhaar',
    target: 'student',
    column: 'aadhaar_number',
    nullable: true,
    unique: true,
    example: '123456789012',
    rule: 'Exactly 12 digits. Spaces and hyphens are removed.',
  },
  {
    key: 'admission_date',
    label: 'Admission date',
    templateHeader: 'Admission Date',
    aliases: ['admission date', 'date of admission', 'admitted on'],
    inputType: 'date',
    target: 'student',
    column: 'admission_date',
    nullable: false,
    example: '2026-06-01',
    rule: 'Use YYYY-MM-DD or DD-MM-YYYY.',
  },
  {
    key: 'date_of_birth',
    label: 'Date of birth',
    templateHeader: 'Date of Birth',
    aliases: ['date of birth', 'dob', 'birth date'],
    inputType: 'date',
    target: 'person',
    column: 'dob',
    nullable: true,
    rejectFuture: true,
    example: '2014-08-21',
    rule: 'Use YYYY-MM-DD or DD-MM-YYYY. Future dates are rejected.',
  },
  {
    key: 'gender',
    label: 'Gender',
    templateHeader: 'Gender',
    aliases: ['gender', 'sex'],
    inputType: 'reference',
    referenceTable: 'genders',
    target: 'person',
    column: 'gender_id',
    nullable: false,
    example: 'Female',
    rule: 'Use a configured gender name or ID.',
  },
  {
    key: 'mobile_number',
    label: 'Mobile number',
    templateHeader: 'Mobile Number',
    aliases: ['mobile', 'mobile no', 'mobile number', 'phone', 'phone no', 'phone number'],
    inputType: 'phone',
    target: 'contact',
    contactType: 'phone',
    nullable: true,
    example: '9876543210',
    rule: '10 to 15 digits; an optional leading + is accepted.',
  },
  {
    key: 'first_name',
    label: 'First name',
    templateHeader: 'First Name',
    aliases: ['first name', 'firstname', 'given name'],
    inputType: 'text',
    target: 'person',
    column: 'first_name',
    nullable: false,
    maxLength: 50,
    example: 'Ananya',
    rule: 'Required; maximum 50 characters.',
  },
  {
    key: 'middle_name',
    label: 'Middle name',
    templateHeader: 'Middle Name',
    aliases: ['middle name', 'middlename'],
    inputType: 'text',
    target: 'person',
    column: 'middle_name',
    nullable: true,
    maxLength: 50,
    example: 'Reddy',
    rule: 'Maximum 50 characters.',
  },
  {
    key: 'last_name',
    label: 'Last name',
    templateHeader: 'Last Name',
    aliases: ['last name', 'lastname', 'surname'],
    inputType: 'text',
    target: 'person',
    column: 'last_name',
    nullable: true,
    maxLength: 50,
    example: 'Sharma',
    rule: 'Maximum 50 characters.',
  },
  {
    key: 'father_name',
    label: 'Father name',
    templateHeader: 'Father Name',
    aliases: ['father name', 'father', 'fathers name', "father's name", 'parent name'],
    inputType: 'text',
    target: 'father',
    column: 'father_name',
    nullable: true,
    maxLength: 50,
    example: 'Ramesh Kumar',
    rule: 'Maximum 50 characters. Creates a Father parent link when the student has none.',
  },
  {
    key: 'admission_number',
    label: 'Admission number',
    templateHeader: 'New Admission Number',
    aliases: ['new admission number', 'new admission no', 'replacement admission number'],
    inputType: 'text',
    target: 'student',
    column: 'admission_no',
    nullable: false,
    unique: true,
    maxLength: 30,
    example: '2051',
    rule: 'Required and unique. Use Current Admission Number in the first column.',
  },
  {
    key: 'pen_number',
    label: 'PEN number',
    templateHeader: 'PEN Number',
    aliases: ['pen', 'pen no', 'pen number', 'permanent education number'],
    inputType: 'pen',
    target: 'student',
    column: 'pen_number',
    nullable: true,
    unique: true,
    example: 'PEN20260001',
    rule: 'Letters and numbers only; maximum 30 characters.',
  },
  {
    key: 'apar_number',
    label: 'APAAR number',
    templateHeader: 'APAAR Number',
    aliases: ['apaar', 'apaar no', 'apaar number', 'apar', 'apar no', 'apar number'],
    inputType: 'text',
    target: 'student',
    column: 'apar_number',
    nullable: true,
    unique: true,
    maxLength: 50,
    example: 'APAAR123456',
    rule: 'Maximum 50 characters.',
  },
  {
    key: 'village',
    label: 'Village / locality',
    templateHeader: 'Village',
    aliases: ['village', 'locality', 'place'],
    inputType: 'text',
    target: 'student',
    column: 'village',
    nullable: true,
    maxLength: 100,
    example: 'Madhapur',
    rule: 'Maximum 100 characters.',
  },
  {
    key: 'tc_number',
    label: 'TC number',
    templateHeader: 'TC Number',
    aliases: ['tc', 'tc no', 'tc number', 'transfer certificate number'],
    inputType: 'text',
    target: 'student',
    column: 'tc_number',
    nullable: true,
    maxLength: 50,
    example: 'TC-2026-014',
    rule: 'Maximum 50 characters.',
  },
  {
    key: 'previous_school',
    label: 'Previous school attended',
    templateHeader: 'Previous School',
    aliases: ['previous school', 'previous school attended', 'transfer student'],
    inputType: 'boolean',
    target: 'student',
    column: 'previous_school',
    nullable: true,
    example: 'Yes',
    rule: 'Use Yes/No, True/False, or 1/0.',
  },
  {
    key: 'category',
    label: 'Student category',
    templateHeader: 'Category',
    aliases: ['category', 'student category', 'caste category'],
    inputType: 'reference',
    referenceTable: 'student_categories',
    target: 'student',
    column: 'category_id',
    nullable: true,
    example: 'General',
    rule: 'Use a configured category name or ID.',
  },
  {
    key: 'religion',
    label: 'Religion',
    templateHeader: 'Religion',
    aliases: ['religion'],
    inputType: 'reference',
    referenceTable: 'religions',
    target: 'student',
    column: 'religion_id',
    nullable: true,
    example: 'Hindu',
    rule: 'Use a configured religion name or ID.',
  },
  {
    key: 'blood_group',
    label: 'Blood group',
    templateHeader: 'Blood Group',
    aliases: ['blood group', 'bloodgroup', 'blood type'],
    inputType: 'reference',
    referenceTable: 'blood_groups',
    target: 'student',
    column: 'blood_group_id',
    nullable: true,
    example: 'O+',
    rule: 'Use a configured blood-group name or ID.',
  },
];

const FIELD_BY_KEY = new Map(FIELD_DEFINITIONS.map((field) => [field.key, field]));

const SECOND_EXAMPLES = {
  aadhaar_number: '234567890123',
  admission_date: '2026-06-15',
  date_of_birth: '2015-01-10',
  gender: 'Male',
  mobile_number: '9123456789',
  first_name: 'Arjun',
  middle_name: 'Kumar',
  last_name: 'Reddy',
  father_name: 'Suresh Reddy',
  admission_number: '2052',
  pen_number: 'PEN20260002',
  apar_number: 'APAAR234567',
  village: 'Kondapur',
  tc_number: 'TC-2026-015',
  previous_school: 'No',
  category: 'OBC',
  religion: 'Christian',
  blood_group: 'A+',
};

const normalizeHeader = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const stringValue = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (value == null) return '';
  return String(value).trim();
};

const publicField = (field, options = []) => ({
  key: field.key,
  label: field.label,
  template_header: field.templateHeader,
  input_type: field.inputType,
  nullable: field.nullable,
  example: field.example,
  rule: field.rule,
  options,
});

export const getStudentBulkUpdateField = (fieldKey) => FIELD_BY_KEY.get(String(fieldKey || '')) || null;

const loadReferenceOptions = async (db, field) => {
  if (!field?.referenceTable) return [];
  const rows = await db`SELECT id, name FROM ${db(field.referenceTable)} ORDER BY id ASC`;
  return rows.map((row) => ({ id: Number(row.id), name: String(row.name) }));
};

export async function listStudentBulkUpdateFields(db) {
  return Promise.all(
    FIELD_DEFINITIONS.map(async (field) => publicField(field, await loadReferenceOptions(db, field))),
  );
}

export function isLikelyStudentUpdateWorkbook(buffer, filename = '') {
  if (!buffer || buffer.length < 4) return false;
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.csv')) return true;
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return true; // xlsx ZIP
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf) return true; // legacy xls OLE
  return false;
}

export function parseStudentBulkUpdateBuffer(buffer, fieldKey) {
  const field = getStudentBulkUpdateField(fieldKey);
  if (!field) throw new Error('Select a supported student field before uploading the file.');

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The workbook has no worksheets.');

  const sheet = workbook.Sheets[sheetName];
  const formattedRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd',
  });
  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
  });
  if (!formattedRows.length) throw new Error('The uploaded file is empty.');

  const headers = (formattedRows[0] || []).map(normalizeHeader);
  const admissionIndex = headers.findIndex((header) => HEADER_ALIASES.admissionLookup.includes(header));
  const valueAliases = [field.templateHeader, field.key, ...field.aliases].map(normalizeHeader);
  const valueIndex = headers.findIndex((header, index) => index !== admissionIndex && valueAliases.includes(header));

  if (admissionIndex < 0 || valueIndex < 0) {
    const lookupHeader = field.key === 'admission_number'
      ? 'Current Admission Number'
      : 'Admission Number';
    throw new Error(
      `Missing required columns. Expected "${lookupHeader}" and "${field.templateHeader}".`,
    );
  }

  const parsed = [];
  for (let index = 1; index < formattedRows.length; index += 1) {
    const formattedRow = formattedRows[index] || [];
    const rawRow = rawRows[index] || [];
    const admissionNo = stringValue(formattedRow[admissionIndex] ?? rawRow[admissionIndex]);
    const rawValue = rawRow[valueIndex];
    const formattedValue = formattedRow[valueIndex];
    if (!admissionNo && stringValue(formattedValue) === '' && stringValue(rawValue) === '') continue;

    parsed.push({
      rowNumber: index + 1,
      admissionNo,
      rawValue,
      formattedValue,
    });
  }

  if (parsed.length === 0) throw new Error('No update rows were found in the uploaded file.');
  if (parsed.length > MAX_STUDENT_BULK_UPDATE_ROWS) {
    throw new Error(
      `The file contains ${parsed.length} rows. The maximum is ${MAX_STUDENT_BULK_UPDATE_ROWS}.`,
    );
  }
  return parsed;
}

const pad = (value) => String(value).padStart(2, '0');

const makeIsoDate = (year, month, day) => {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
};

const normalizeDate = (rawValue, formattedValue) => {
  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
    return makeIsoDate(rawValue.getUTCFullYear(), rawValue.getUTCMonth() + 1, rawValue.getUTCDate());
  }
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    const decoded = XLSX.SSF.parse_date_code(rawValue);
    if (decoded) return makeIsoDate(decoded.y, decoded.m, decoded.d);
  }

  const value = stringValue(formattedValue || rawValue);
  let match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return makeIsoDate(match[1], match[2], match[3]);
  match = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) return makeIsoDate(match[3], match[2], match[1]);
  return null;
};

const normalizedInputString = (rawValue, formattedValue) => {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return Number.isInteger(rawValue) ? String(rawValue) : String(rawValue);
  }
  return stringValue(formattedValue ?? rawValue);
};

function normalizeFieldValue(field, row, { allowBlankClear, referenceLookup }) {
  const input = normalizedInputString(row.rawValue, row.formattedValue).trim();
  if (!input) {
    if (!field.nullable) return { error: `${field.label} cannot be blank.` };
    if (!allowBlankClear) {
      return { error: `${field.label} is blank. Enable "clear blank cells" to remove existing values.` };
    }
    return { value: null, displayValue: 'Clear value' };
  }

  if (field.inputType === 'date') {
    const value = normalizeDate(row.rawValue, row.formattedValue);
    if (!value) return { error: 'Invalid date. Use YYYY-MM-DD or DD-MM-YYYY.' };
    if (field.rejectFuture && value > new Date().toISOString().slice(0, 10)) {
      return { error: 'Date of birth cannot be in the future.' };
    }
    return { value, displayValue: value };
  }

  if (field.inputType === 'aadhaar') {
    const value = input.replace(/\D/g, '');
    if (value.length !== 12) return { error: 'Aadhaar number must be exactly 12 digits.' };
    return { value, displayValue: value };
  }

  if (field.inputType === 'phone') {
    const value = input.replace(/[\s()-]/g, '');
    if (!/^\+?\d{10,15}$/.test(value)) {
      return { error: 'Mobile number must contain 10 to 15 digits.' };
    }
    return { value, displayValue: value };
  }

  if (field.inputType === 'boolean') {
    const token = input.toLowerCase();
    if (['yes', 'true', '1', 'y'].includes(token)) return { value: 'true', displayValue: 'Yes' };
    if (['no', 'false', '0', 'n'].includes(token)) return { value: 'false', displayValue: 'No' };
    return { error: 'Use Yes/No, True/False, or 1/0.' };
  }

  if (field.inputType === 'reference') {
    const option = referenceLookup.get(input.toLowerCase());
    if (!option) return { error: `${input} is not a configured ${field.label.toLowerCase()} value.` };
    return { value: String(option.id), displayValue: option.name };
  }

  if (field.inputType === 'pen') {
    const value = input.toUpperCase();
    if (value.length > 30 || !/^[A-Z0-9]+$/.test(value)) {
      return { error: 'PEN number must contain only letters and numbers (maximum 30).' };
    }
    return { value, displayValue: value };
  }

  if (field.maxLength && input.length > field.maxLength) {
    return { error: `${field.label} must be at most ${field.maxLength} characters.` };
  }
  return { value: input, displayValue: input };
}

const loadStudentRows = async (db, schoolId, admissionNumbers) => {
  if (!admissionNumbers.length) return [];
  return db`
    SELECT
      s.id,
      s.person_id,
      s.admission_no,
      s.pen_number,
      s.apar_number,
      s.village,
      s.aadhaar_number,
      s.tc_number,
      s.previous_school,
      s.admission_date,
      s.category_id,
      s.religion_id,
      s.blood_group_id,
      p.first_name,
      p.middle_name,
      p.last_name,
      p.dob,
      p.gender_id,
      (SELECT contact_value
       FROM person_contacts pc
       WHERE pc.person_id = p.id
         AND pc.school_id = ${schoolId}
         AND pc.contact_type = 'phone'
         AND pc.is_primary = TRUE
         AND pc.deleted_at IS NULL
       LIMIT 1) AS mobile_number,
      (SELECT pp.display_name
       FROM student_parents sp
       JOIN parents pa ON pa.id = sp.parent_id AND pa.deleted_at IS NULL
       JOIN persons pp ON pp.id = pa.person_id AND pp.school_id = ${schoolId}
       WHERE sp.student_id = s.id
         AND sp.school_id = ${schoolId}
         AND sp.relationship_id = 1
         AND sp.deleted_at IS NULL
       LIMIT 1) AS father_name,
      g.name AS gender_name,
      sc.name AS category_name,
      r.name AS religion_name,
      bg.name AS blood_group_name
    FROM students s
    JOIN persons p ON p.id = s.person_id AND p.school_id = ${schoolId}
    LEFT JOIN genders g ON g.id = p.gender_id
    LEFT JOIN student_categories sc ON sc.id = s.category_id
    LEFT JOIN religions r ON r.id = s.religion_id
    LEFT JOIN blood_groups bg ON bg.id = s.blood_group_id
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND s.admission_no = ANY(${db.array(admissionNumbers)}::varchar[])
  `;
};

const isoDatabaseDate = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const currentFieldValue = (field, student) => {
  if (field.key === 'date_of_birth') return { value: isoDatabaseDate(student.dob), display: isoDatabaseDate(student.dob) };
  if (field.key === 'admission_date') return { value: isoDatabaseDate(student.admission_date), display: isoDatabaseDate(student.admission_date) };
  if (field.key === 'gender') return { value: String(student.gender_id), display: student.gender_name };
  if (field.key === 'category') return { value: student.category_id == null ? null : String(student.category_id), display: student.category_name };
  if (field.key === 'religion') return { value: student.religion_id == null ? null : String(student.religion_id), display: student.religion_name };
  if (field.key === 'blood_group') return { value: student.blood_group_id == null ? null : String(student.blood_group_id), display: student.blood_group_name };
  if (field.key === 'mobile_number') return { value: student.mobile_number || null, display: student.mobile_number || null };
  if (field.key === 'father_name') return { value: student.father_name || null, display: student.father_name || null };
  if (field.key === 'admission_number') return { value: student.admission_no, display: student.admission_no };

  const raw = student[field.column];
  if (field.inputType === 'boolean') {
    return {
      value: raw == null ? null : String(Boolean(raw)),
      display: raw == null ? null : (raw ? 'Yes' : 'No'),
    };
  }
  return { value: raw == null ? null : String(raw), display: raw == null ? null : String(raw) };
};

const buildReferenceLookup = (options) => {
  const lookup = new Map();
  for (const option of options) {
    lookup.set(String(option.id), option);
    lookup.set(option.name.trim().toLowerCase(), option);
  }
  return lookup;
};

const invalidRow = (row, message, extra = {}) => ({
  ...row,
  ...extra,
  status: 'invalid',
  errorMessage: message,
});

export async function validateStudentBulkUpdateRows(db, {
  schoolId,
  fieldKey,
  parsedRows,
  allowBlankClear,
}) {
  const field = getStudentBulkUpdateField(fieldKey);
  if (!field) throw new Error('Unsupported student field.');

  const referenceOptions = await loadReferenceOptions(db, field);
  const referenceLookup = buildReferenceLookup(referenceOptions);
  const admissionCounts = new Map();
  for (const row of parsedRows) {
    if (!row.admissionNo) continue;
    admissionCounts.set(row.admissionNo, (admissionCounts.get(row.admissionNo) || 0) + 1);
  }

  const admissionNumbers = [...new Set(parsedRows.map((row) => row.admissionNo).filter(Boolean))];
  const students = await loadStudentRows(db, schoolId, admissionNumbers);
  const studentMap = new Map(students.map((student) => [String(student.admission_no), student]));

  let validated = parsedRows.map((row) => {
    const base = {
      rowNumber: row.rowNumber,
      admissionNo: row.admissionNo,
      rawValue: stringValue(row.formattedValue ?? row.rawValue),
      normalizedValue: null,
      newDisplayValue: null,
      currentValue: null,
      studentId: null,
      personId: null,
      status: 'valid',
      errorMessage: null,
    };

    if (!row.admissionNo) return invalidRow(base, 'Admission Number is required.');
    if ((admissionCounts.get(row.admissionNo) || 0) > 1) {
      return invalidRow(base, 'Duplicate Admission Number in the file. Remove every duplicate row and retry.');
    }

    const student = studentMap.get(row.admissionNo);
    if (!student) return invalidRow(base, 'No active student was found for this Admission Number.');

    const normalized = normalizeFieldValue(field, row, { allowBlankClear, referenceLookup });
    const current = currentFieldValue(field, student);
    if (normalized.error) {
      return invalidRow(base, normalized.error, {
        studentId: student.id,
        personId: student.person_id,
        currentValue: current.display,
      });
    }
    if (field.key === 'previous_school' && normalized.value === 'true' && !student.tc_number) {
      return invalidRow(base, 'Add the student TC number before marking Previous School as Yes.', {
        studentId: student.id,
        personId: student.person_id,
        currentValue: current.display,
      });
    }

    const next = {
      ...base,
      studentId: student.id,
      personId: student.person_id,
      normalizedValue: normalized.value,
      newDisplayValue: normalized.displayValue,
      currentValue: current.display,
    };
    if ((current.value ?? null) === (normalized.value ?? null)) {
      return { ...next, status: 'unchanged' };
    }
    return next;
  });

  const validRows = validated.filter((row) => row.status === 'valid');
  if (field.unique && validRows.length) {
    const valueCounts = new Map();
    for (const row of validRows) {
      if (row.normalizedValue == null) continue;
      valueCounts.set(row.normalizedValue, (valueCounts.get(row.normalizedValue) || 0) + 1);
    }

    const desiredValues = [...valueCounts.keys()];
    let conflicts;
    if (field.key === 'admission_number') {
      conflicts = await db`
          SELECT id, admission_no AS value
          FROM students
          WHERE school_id = ${schoolId}
            AND deleted_at IS NULL
            AND admission_no = ANY(${db.array(desiredValues)}::varchar[])
        `;
    } else if (field.key === 'pen_number') {
      conflicts = await db`
          SELECT id, pen_number AS value
          FROM students
          WHERE school_id = ${schoolId}
            AND deleted_at IS NULL
            AND pen_number = ANY(${db.array(desiredValues)}::varchar[])
        `;
    } else if (field.key === 'aadhaar_number') {
      conflicts = await db`
          SELECT id, aadhaar_number AS value
          FROM students
          WHERE school_id = ${schoolId}
            AND deleted_at IS NULL
            AND aadhaar_number = ANY(${db.array(desiredValues)}::varchar[])
        `;
    } else {
      conflicts = await db`
          SELECT id, apar_number AS value
          FROM students
          WHERE school_id = ${schoolId}
            AND deleted_at IS NULL
            AND apar_number = ANY(${db.array(desiredValues)}::varchar[])
        `;
    }
    const conflictMap = new Map(conflicts.map((entry) => [String(entry.value), String(entry.id)]));

    validated = validated.map((row) => {
      if (row.status !== 'valid' || row.normalizedValue == null) return row;
      if ((valueCounts.get(row.normalizedValue) || 0) > 1) {
        return invalidRow(row, `${field.label} is repeated for multiple students in this file.`);
      }
      const ownerId = conflictMap.get(row.normalizedValue);
      if (ownerId && ownerId !== String(row.studentId)) {
        return invalidRow(row, `${field.label} '${row.normalizedValue}' already belongs to another student.`);
      }
      return row;
    });
  }

  return validated;
}

const summaryForRows = (rows) => ({
  total_rows: rows.length,
  valid_rows: rows.filter((row) => row.status === 'valid').length,
  invalid_rows: rows.filter((row) => row.status === 'invalid').length,
  unchanged_rows: rows.filter((row) => row.status === 'unchanged').length,
});

const responseRow = (row) => ({
  row_number: row.rowNumber ?? row.row_number,
  admission_no: row.admissionNo ?? row.admission_no,
  raw_value: row.rawValue ?? row.raw_value,
  current_value: row.currentValue ?? row.current_value,
  new_value: row.newDisplayValue ?? row.new_display_value,
  status: row.status,
  error_message: row.errorMessage ?? row.error_message,
});

async function insertPreviewRows(tx, batchId, schoolId, rows) {
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK_SIZE);
    await tx`
      INSERT INTO student_bulk_update_rows (
        batch_id, school_id, row_number, admission_no, raw_value,
        normalized_value, new_display_value, current_value,
        student_id, person_id, status, error_message
      )
      SELECT
        ${batchId},
        ${schoolId},
        u.row_number,
        u.admission_no,
        u.raw_value,
        u.normalized_value,
        u.new_display_value,
        u.current_value,
        u.student_id,
        u.person_id,
        u.status,
        u.error_message
      FROM unnest(
        ${tx.array(chunk.map((row) => row.rowNumber))}::int[],
        ${tx.array(chunk.map((row) => row.admissionNo || null))}::text[],
        ${tx.array(chunk.map((row) => row.rawValue || null))}::text[],
        ${tx.array(chunk.map((row) => row.normalizedValue))}::text[],
        ${tx.array(chunk.map((row) => row.newDisplayValue))}::text[],
        ${tx.array(chunk.map((row) => row.currentValue))}::text[],
        ${tx.array(chunk.map((row) => row.studentId))}::uuid[],
        ${tx.array(chunk.map((row) => row.personId))}::uuid[],
        ${tx.array(chunk.map((row) => row.status))}::text[],
        ${tx.array(chunk.map((row) => row.errorMessage))}::text[]
      ) AS u(
        row_number, admission_no, raw_value, normalized_value,
        new_display_value, current_value, student_id, person_id,
        status, error_message
      )
    `;
  }
}

export async function createStudentBulkUpdatePreview(db, {
  schoolId,
  uploadedBy,
  originalFilename,
  fieldKey,
  allowBlankClear,
  parsedRows,
}) {
  const field = getStudentBulkUpdateField(fieldKey);
  if (!field) throw new Error('Unsupported student field.');
  const rows = await validateStudentBulkUpdateRows(db, {
    schoolId,
    fieldKey,
    parsedRows,
    allowBlankClear,
  });
  const summary = summaryForRows(rows);

  return db.begin(async (tx) => {
    const [batch] = await tx`
      INSERT INTO student_bulk_update_batches (
        school_id, uploaded_by, original_filename, field_key, field_label,
        allow_blank_clear, status, total_rows, valid_rows, invalid_rows, unchanged_rows
      )
      VALUES (
        ${schoolId}, ${uploadedBy}, ${originalFilename}, ${field.key}, ${field.label},
        ${allowBlankClear}, 'preview', ${summary.total_rows}, ${summary.valid_rows},
        ${summary.invalid_rows}, ${summary.unchanged_rows}
      )
      RETURNING id, field_key, field_label, status, created_at
    `;
    await insertPreviewRows(tx, batch.id, schoolId, rows);
    return {
      batch_id: batch.id,
      field: publicField(field),
      summary,
      rows: rows.slice(0, STUDENT_BULK_UPDATE_PREVIEW_LIMIT).map(responseRow),
      preview_truncated: rows.length > STUDENT_BULK_UPDATE_PREVIEW_LIMIT,
    };
  });
}

const typedValueFragment = (tx, field) => {
  if (field.inputType === 'date') return tx`u.value::date`;
  if (field.inputType === 'reference') return tx`u.value::smallint`;
  if (field.inputType === 'boolean') return tx`u.value::boolean`;
  return tx`u.value`;
};

async function applyContactUpdates(tx, schoolId, field, rows) {
  let applied = 0;
  for (const row of rows) {
    if (row.normalized_value == null) {
      const deleted = await tx`
        DELETE FROM person_contacts
        WHERE school_id = ${schoolId}
          AND person_id = ${row.person_id}
          AND contact_type = ${field.contactType}
          AND is_primary = TRUE
        RETURNING id
      `;
      // Clearing an already-missing contact is still a successful idempotent update.
      applied += deleted.length > 0 ? 1 : 1;
      continue;
    }

    const [primary] = await tx`
      SELECT id
      FROM person_contacts
      WHERE school_id = ${schoolId}
        AND person_id = ${row.person_id}
        AND contact_type = ${field.contactType}
        AND is_primary = TRUE
      LIMIT 1
    `;
    if (primary) {
      await tx`
        DELETE FROM person_contacts
        WHERE school_id = ${schoolId}
          AND person_id = ${row.person_id}
          AND contact_type = ${field.contactType}
          AND id <> ${primary.id}
          AND lower(contact_value) = lower(${row.normalized_value})
      `;
      await tx`
        UPDATE person_contacts
        SET contact_value = ${row.normalized_value}, deleted_at = NULL, updated_at = now()
        WHERE id = ${primary.id} AND school_id = ${schoolId}
      `;
    } else {
      const [sameContact] = await tx`
        SELECT id
        FROM person_contacts
        WHERE school_id = ${schoolId}
          AND person_id = ${row.person_id}
          AND contact_type = ${field.contactType}
          AND lower(contact_value) = lower(${row.normalized_value})
        LIMIT 1
      `;
      if (sameContact) {
        await tx`
          UPDATE person_contacts
          SET is_primary = TRUE, deleted_at = NULL, updated_at = now()
          WHERE id = ${sameContact.id} AND school_id = ${schoolId}
        `;
      } else {
        await tx`
          INSERT INTO person_contacts (
            school_id, person_id, contact_type, contact_value, is_primary
          )
          VALUES (${schoolId}, ${row.person_id}, ${field.contactType}, ${row.normalized_value}, TRUE)
        `;
      }
    }
    applied += 1;
  }
  return applied;
}

const FATHER_RELATIONSHIP_ID = 1;

async function applyFatherNameUpdates(tx, schoolId, rows) {
  let applied = 0;
  for (const row of rows) {
    const [existingLink] = await tx`
      SELECT sp.id AS link_id, pa.id AS parent_id, pp.id AS person_id
      FROM student_parents sp
      JOIN parents pa ON pa.id = sp.parent_id AND pa.deleted_at IS NULL
      JOIN persons pp ON pp.id = pa.person_id AND pp.school_id = ${schoolId}
      WHERE sp.student_id = ${row.student_id}
        AND sp.school_id = ${schoolId}
        AND sp.relationship_id = ${FATHER_RELATIONSHIP_ID}
        AND sp.deleted_at IS NULL
      LIMIT 1
    `;

    if (row.normalized_value == null) {
      if (existingLink) {
        await tx`
          UPDATE student_parents
          SET deleted_at = now()
          WHERE id = ${existingLink.link_id}
            AND school_id = ${schoolId}
            AND deleted_at IS NULL
        `;
      }
      applied += 1;
      continue;
    }

    if (existingLink) {
      await tx`
        UPDATE persons
        SET first_name = ${row.normalized_value},
            middle_name = NULL,
            last_name = NULL,
            gender_id = 1,
            updated_at = now()
        WHERE id = ${existingLink.person_id}
          AND school_id = ${schoolId}
      `;
    } else {
      const [parentPerson] = await tx`
        INSERT INTO persons (school_id, first_name, last_name, gender_id)
        VALUES (${schoolId}, ${row.normalized_value}, NULL, 1)
        RETURNING id
      `;
      const [parentRecord] = await tx`
        INSERT INTO parents (school_id, person_id)
        VALUES (${schoolId}, ${parentPerson.id})
        RETURNING id
      `;
      await tx`
        INSERT INTO student_parents (
          school_id, student_id, parent_id, relationship_id, is_primary_contact, is_legal_guardian
        )
        VALUES (
          ${schoolId}, ${row.student_id}, ${parentRecord.id}, ${FATHER_RELATIONSHIP_ID}, FALSE, FALSE
        )
      `;
    }
    applied += 1;
  }
  return applied;
}

async function applyScalarUpdates(tx, schoolId, field, rows) {
  const studentIds = rows.map((row) => row.student_id);
  const values = rows.map((row) => row.normalized_value);
  const typedValue = typedValueFragment(tx, field);

  if (field.target === 'student') {
    const updated = await tx`
      UPDATE students AS target
      SET ${tx(field.column)} = ${typedValue}
      FROM unnest(
        ${tx.array(studentIds)}::uuid[],
        ${tx.array(values)}::text[]
      ) AS u(student_id, value)
      WHERE target.id = u.student_id
        AND target.school_id = ${schoolId}
        AND target.deleted_at IS NULL
      RETURNING target.id
    `;
    return updated.length;
  }

  const updated = await tx`
    UPDATE persons AS target
    SET ${tx(field.column)} = ${typedValue}
    FROM students s
    JOIN unnest(
      ${tx.array(studentIds)}::uuid[],
      ${tx.array(values)}::text[]
    ) AS u(student_id, value) ON u.student_id = s.id
    WHERE target.id = s.person_id
      AND target.school_id = ${schoolId}
      AND s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
    RETURNING target.id
  `;
  return updated.length;
}

export async function commitStudentBulkUpdate(db, { schoolId, batchId }) {
  return db.begin(async (tx) => {
    const [batch] = await tx`
      SELECT *
      FROM student_bulk_update_batches
      WHERE id = ${batchId} AND school_id = ${schoolId}
      FOR UPDATE
    `;
    if (!batch) {
      const error = new Error('Bulk update batch not found.');
      error.statusCode = 404;
      throw error;
    }
    if (batch.status === 'committed') {
      return {
        batch_id: batch.id,
        field_key: batch.field_key,
        field_label: batch.field_label,
        success_rows: batch.success_rows,
        invalid_rows: batch.invalid_rows,
        unchanged_rows: batch.unchanged_rows,
        already_committed: true,
      };
    }
    if (batch.status !== 'preview') {
      const error = new Error('This bulk update batch cannot be committed.');
      error.statusCode = 409;
      throw error;
    }

    const field = getStudentBulkUpdateField(batch.field_key);
    if (!field) throw new Error('The batch references an unsupported student field.');
    const rows = await tx`
      SELECT *
      FROM student_bulk_update_rows
      WHERE batch_id = ${batch.id}
        AND school_id = ${schoolId}
        AND status = 'valid'
      ORDER BY row_number ASC
    `;
    if (!rows.length) {
      const error = new Error('There are no valid changed rows to update.');
      error.statusCode = 400;
      throw error;
    }

    let applied;
    if (field.target === 'contact') {
      applied = await applyContactUpdates(tx, schoolId, field, rows);
    } else if (field.target === 'father') {
      applied = await applyFatherNameUpdates(tx, schoolId, rows);
    } else {
      applied = await applyScalarUpdates(tx, schoolId, field, rows);
    }
    if (applied !== rows.length) {
      throw new Error(`Expected to update ${rows.length} students, but only ${applied} were updated.`);
    }

    await tx`
      UPDATE student_bulk_update_rows
      SET status = 'success', applied_at = now()
      WHERE batch_id = ${batch.id}
        AND school_id = ${schoolId}
        AND status = 'valid'
    `;
    const [committed] = await tx`
      UPDATE student_bulk_update_batches
      SET status = 'committed', success_rows = ${applied}, committed_at = now()
      WHERE id = ${batch.id} AND school_id = ${schoolId}
      RETURNING *
    `;

    return {
      batch_id: committed.id,
      field_key: committed.field_key,
      field_label: committed.field_label,
      success_rows: committed.success_rows,
      invalid_rows: committed.invalid_rows,
      unchanged_rows: committed.unchanged_rows,
      already_committed: false,
    };
  });
}

export async function buildStudentBulkUpdateTemplate(db, fieldKey) {
  const field = getStudentBulkUpdateField(fieldKey);
  if (!field) throw new Error('Select a supported student field.');
  const options = await loadReferenceOptions(db, field);
  const firstExample = options[0]?.name || field.example;
  const secondExample = options[1]?.name || SECOND_EXAMPLES[field.key] || field.example;
  const lookupHeader = field.key === 'admission_number' ? 'Current Admission Number' : 'Admission Number';
  const updates = XLSX.utils.aoa_to_sheet([
    [lookupHeader, field.templateHeader],
    ['1001', firstExample],
    ['1002', secondExample],
  ]);
  updates['!cols'] = [{ wch: 28 }, { wch: 30 }];

  const instructions = XLSX.utils.aoa_to_sheet([
    ['Bulk student field update'],
    ['Selected field', field.label],
    ['Match students by', lookupHeader],
    ['Rule', field.rule],
    ['Important', 'Replace the example rows, do not rename the two column headers, and preview before confirming.'],
    ['Blank cells', field.nullable
      ? 'Blank cells are rejected unless Clear blank cells is enabled on the upload screen.'
      : 'This field is required and cannot be cleared.'],
  ]);
  instructions['!cols'] = [{ wch: 22 }, { wch: 95 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, updates, 'Updates');
  XLSX.utils.book_append_sheet(workbook, instructions, 'Instructions');

  if (options.length) {
    const allowed = XLSX.utils.aoa_to_sheet([
      ['ID', 'Allowed value'],
      ...options.map((option) => [option.id, option.name]),
    ]);
    allowed['!cols'] = [{ wch: 12 }, { wch: 32 }];
    XLSX.utils.book_append_sheet(workbook, allowed, 'Allowed Values');
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

export async function buildStudentBulkUpdateFailureWorkbook(db, { schoolId, batchId }) {
  const [batch] = await db`
    SELECT id, field_label
    FROM student_bulk_update_batches
    WHERE id = ${batchId} AND school_id = ${schoolId}
  `;
  if (!batch) return null;
  const rows = await db`
    SELECT row_number, admission_no, raw_value, current_value, new_display_value, status, error_message
    FROM student_bulk_update_rows
    WHERE batch_id = ${batchId}
      AND school_id = ${schoolId}
      AND status = 'invalid'
    ORDER BY row_number ASC
  `;
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Row', 'Admission Number', 'Uploaded Value', 'Current Value', 'Normalized Value', 'Error'],
    ...rows.map((row) => [
      row.row_number,
      row.admission_no,
      row.raw_value,
      row.current_value,
      row.new_display_value,
      row.error_message,
    ]),
  ]);
  sheet['!cols'] = [{ wch: 8 }, { wch: 22 }, { wch: 24 }, { wch: 24 }, { wch: 24 }, { wch: 65 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Errors');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
