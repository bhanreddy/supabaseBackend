import sql from '../db.js';
import logger from '../utils/logger.js';
import { validatePenNumber as validateCanonicalPen } from '../utils/studentPen.js';

export const UDISE_STATUS = {
  READY: 'ready',
  NEEDS_ATTENTION: 'needs_attention',
  CRITICAL_INCOMPLETE: 'critical_incomplete',
  DUPLICATE: 'duplicate',
};

/**
 * Pure validators for UDISE+ fields
 */
export function validateAdmissionNo(val) {
  if (!val || String(val).trim() === '') {
    return { ok: false, severity: 'critical', field: 'admission_no', error: 'Admission number is required' };
  }
  if (String(val).trim().length > 30) {
    return { ok: false, severity: 'critical', field: 'admission_no', error: 'Admission number cannot exceed 30 characters' };
  }
  return { ok: true };
}

export function validateStudentName(val) {
  if (!val || String(val).trim() === '') {
    return { ok: false, severity: 'critical', field: 'student_name', error: 'Student name is required' };
  }
  return { ok: true };
}

export function validateGender(val) {
  if (!val || String(val).trim() === '') {
    return { ok: false, severity: 'critical', field: 'gender', error: 'Gender is required' };
  }
  const clean = String(val).trim().toLowerCase();
  if (!['male', 'female', 'other'].includes(clean)) {
    return { ok: false, severity: 'critical', field: 'gender', error: 'Invalid gender value' };
  }
  return { ok: true };
}

export function validateDOB(val) {
  if (!val) {
    return { ok: false, severity: 'critical', field: 'dob', error: 'Date of birth is required' };
  }
  const dob = new Date(val);
  if (isNaN(dob.getTime())) {
    return { ok: false, severity: 'critical', field: 'dob', error: 'Invalid date of birth' };
  }
  const now = new Date();
  if (dob > now) {
    return { ok: false, severity: 'critical', field: 'dob', error: 'Date of birth cannot be in the future' };
  }
  const ageYears = (now.getTime() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (ageYears < 2.5 || ageYears > 25) {
    return { ok: false, severity: 'warning', field: 'dob', error: `Age (${Math.round(ageYears * 10) / 10} yrs) outside standard school range` };
  }
  return { ok: true };
}

export function validateAadhaar(val) {
  if (!val || String(val).trim() === '') {
    return { ok: true, value: null };
  }
  const clean = String(val).replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(clean)) {
    return { ok: false, severity: 'critical', field: 'aadhaar_number', error: 'Aadhaar number must be exactly 12 digits' };
  }
  return { ok: true };
}

export function validatePenNumber(val) {
  const result = validateCanonicalPen(val);
  return result.ok
    ? result
    : { ok: false, severity: 'critical', field: 'pen_number', error: result.error };
}

export function validateAparNumber(val) {
  if (!val || String(val).trim() === '') {
    return { ok: true, value: null };
  }
  const clean = String(val).trim().toUpperCase();
  if (clean.length > 30 || !/^[A-Z0-9]+$/.test(clean)) {
    return { ok: false, severity: 'critical', field: 'apar_number', error: 'APAAR must contain at most 30 letters and numbers' };
  }
  return { ok: true, value: clean };
}

export function validateParents({ fatherName, motherName, guardianName }) {
  const hasParent = Boolean(
    (fatherName && String(fatherName).trim() !== '') ||
    (motherName && String(motherName).trim() !== '') ||
    (guardianName && String(guardianName).trim() !== '')
  );
  if (!hasParent) {
    return { ok: false, severity: 'critical', field: 'parent_name', error: 'At least one parent/guardian name is required' };
  }
  return { ok: true };
}

/**
 * Evaluates full UDISE validation for a single student row.
 */
export function evaluateStudentReadiness(student, duplicates = {}) {
  const errors = [];
  const warnings = [];

  // Check duplicates
  const isDuplicateAdmission = Boolean(duplicates.admissionNos?.has(student.admission_no));
  const isDuplicateAadhaar = Boolean(student.aadhaar_number && duplicates.aadhaars?.has(student.aadhaar_number));
  const isDuplicatePen = Boolean(student.pen_number && duplicates.pens?.has(student.pen_number));
  const isDuplicateApar = Boolean(student.apar_number && duplicates.apars?.has(student.apar_number));

  if (isDuplicateAdmission) errors.push({ field: 'admission_no', error: 'Duplicate Admission Number in school', severity: 'critical' });
  if (isDuplicateAadhaar) errors.push({ field: 'aadhaar_number', error: 'Duplicate Aadhaar Number in school', severity: 'critical' });
  if (isDuplicatePen) errors.push({ field: 'pen_number', error: 'Duplicate PEN Number in school', severity: 'critical' });
  if (isDuplicateApar) errors.push({ field: 'apar_number', error: 'Duplicate APAAR Number in school', severity: 'critical' });

  // Field validations
  const checks = [
    validateAdmissionNo(student.admission_no),
    validateStudentName(student.student_name),
    validateGender(student.gender),
    validateDOB(student.dob),
    validateAadhaar(student.aadhaar_number),
    validatePenNumber(student.pen_number),
    validateAparNumber(student.apar_number),
    validateParents({
      fatherName: student.father_name,
      motherName: student.mother_name,
      guardianName: student.guardian_name,
    }),
  ];

  for (const check of checks) {
    if (!check.ok) {
      if (check.severity === 'critical') errors.push(check);
      else warnings.push(check);
    }
  }

  let status = UDISE_STATUS.READY;
  if (isDuplicateAdmission || isDuplicateAadhaar || isDuplicatePen || isDuplicateApar) {
    status = UDISE_STATUS.DUPLICATE;
  } else if (errors.length > 0) {
    status = UDISE_STATUS.CRITICAL_INCOMPLETE;
  } else if (warnings.length > 0) {
    status = UDISE_STATUS.NEEDS_ATTENTION;
  }

  return {
    status,
    errors,
    warnings,
    isReady: status === UDISE_STATUS.READY,
  };
}

/**
 * Build school-wide duplicate lookup sets.
 */
export function buildDuplicateSets(students = []) {
  const count = (arr, key) => {
    const map = new Map();
    for (const item of arr) {
      const val = item[key] ? String(item[key]).trim().toUpperCase() : null;
      if (val) {
        map.set(val, (map.get(val) || 0) + 1);
      }
    }
    const dupes = new Set();
    for (const [val, freq] of map.entries()) {
      if (freq > 1) dupes.add(val);
    }
    return dupes;
  };

  return {
    admissionNos: count(students, 'admission_no'),
    aadhaars: count(students, 'aadhaar_number'),
    pens: count(students, 'pen_number'),
    apars: count(students, 'apar_number'),
  };
}

/**
 * Fetch raw students dataset for UDISE readiness analysis.
 */
export async function fetchSchoolStudentsForUdise(schoolId, { classId = null, sectionId = null, db = sql } = {}) {
  const rows = await db`
    SELECT
      s.id AS student_id,
      s.admission_no,
      s.pen_number,
      s.apar_number,
      s.aadhaar_number,
      s.admission_date,
      p.id AS person_id,
      p.display_name AS student_name,
      p.first_name,
      p.last_name,
      p.dob,
      LOWER(g.name) AS gender,
      g.name AS gender_name,
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name,
      cs.id AS class_section_id,
      (
        SELECT p_par.display_name
        FROM student_parents sp
        JOIN parents par ON par.id = sp.parent_id AND par.school_id = ${schoolId}
        JOIN persons p_par ON p_par.id = par.person_id
        LEFT JOIN relationship_types rt ON rt.id = sp.relationship_id
        WHERE sp.student_id = s.id AND sp.school_id = ${schoolId} AND LOWER(COALESCE(rt.name, '')) LIKE '%father%'
        LIMIT 1
      ) AS father_name,
      (
        SELECT p_par.display_name
        FROM student_parents sp
        JOIN parents par ON par.id = sp.parent_id AND par.school_id = ${schoolId}
        JOIN persons p_par ON p_par.id = par.person_id
        LEFT JOIN relationship_types rt ON rt.id = sp.relationship_id
        WHERE sp.student_id = s.id AND sp.school_id = ${schoolId} AND LOWER(COALESCE(rt.name, '')) LIKE '%mother%'
        LIMIT 1
      ) AS mother_name,
      (
        SELECT p_par.display_name
        FROM student_parents sp
        JOIN parents par ON par.id = sp.parent_id AND par.school_id = ${schoolId}
        JOIN persons p_par ON p_par.id = par.person_id
        WHERE sp.student_id = s.id AND sp.school_id = ${schoolId}
        LIMIT 1
      ) AS guardian_name
    FROM students s
    JOIN persons p ON s.person_id = p.id
    LEFT JOIN genders g ON p.gender_id = g.id
    JOIN student_enrollments se ON se.student_id = s.id AND se.status = 'active' AND se.school_id = ${schoolId} AND se.deleted_at IS NULL
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      ${classId ? db`AND c.id = ${classId}` : db``}
      ${sectionId ? db`AND sec.id = ${sectionId}` : db``}
    ORDER BY c.name, sec.name, p.display_name
  `;

  return rows;
}

/**
 * Get aggregated UDISE readiness overview and class breakdowns.
 */
export async function getUdiseReadinessOverview(schoolId, db = sql) {
  const students = await fetchSchoolStudentsForUdise(schoolId, { db });
  const duplicates = buildDuplicateSets(students);

  let readyCount = 0;
  let needsAttentionCount = 0;
  let criticalCount = 0;
  let duplicateCount = 0;

  const missingStats = {
    penNumber: 0,
    aparNumber: 0,
    aadhaarNumber: 0,
    dob: 0,
    parentName: 0,
  };

  const classMap = new Map();

  for (const student of students) {
    const evaluation = evaluateStudentReadiness(student, duplicates);

    if (evaluation.status === UDISE_STATUS.READY) readyCount++;
    else if (evaluation.status === UDISE_STATUS.NEEDS_ATTENTION) needsAttentionCount++;
    else if (evaluation.status === UDISE_STATUS.CRITICAL_INCOMPLETE) criticalCount++;
    else if (evaluation.status === UDISE_STATUS.DUPLICATE) duplicateCount++;

    // Missing counts
    if (!student.pen_number) missingStats.penNumber++;
    if (!student.apar_number) missingStats.aparNumber++;
    if (!student.aadhaar_number) missingStats.aadhaarNumber++;
    if (!student.dob) missingStats.dob++;
    if (!student.father_name && !student.mother_name && !student.guardian_name) missingStats.parentName++;

    // Class aggregation
    const classKey = `${student.class_id}:${student.section_id}`;
    if (!classMap.has(classKey)) {
      classMap.set(classKey, {
        class_id: student.class_id,
        class_name: student.class_name,
        section_id: student.section_id,
        section_name: student.section_name,
        total: 0,
        ready: 0,
        needs_attention: 0,
        critical: 0,
        duplicate: 0,
      });
    }

    const cls = classMap.get(classKey);
    cls.total++;
    if (evaluation.status === UDISE_STATUS.READY) cls.ready++;
    else if (evaluation.status === UDISE_STATUS.NEEDS_ATTENTION) cls.needs_attention++;
    else if (evaluation.status === UDISE_STATUS.CRITICAL_INCOMPLETE) cls.critical++;
    else if (evaluation.status === UDISE_STATUS.DUPLICATE) cls.duplicate++;
  }

  const total = students.length;
  const overallPercentage = total > 0 ? Math.round((readyCount / total) * 1000) / 10 : 100;

  const classBreakdown = Array.from(classMap.values()).map(cls => ({
    ...cls,
    readiness_percentage: cls.total > 0 ? Math.round((cls.ready / cls.total) * 1000) / 10 : 100,
  }));

  return {
    summary: {
      totalStudents: total,
      readyCount,
      needsAttentionCount,
      criticalCount,
      duplicateCount,
      readinessPercentage: overallPercentage,
      missingStats,
    },
    classBreakdown,
  };
}

/**
 * Get filtered student list with specific validation errors for the interactive grid.
 */
export async function getUdiseStudentList(schoolId, filters = {}, db = sql) {
  const { classId, sectionId, status, missingField, limit = 50, page = 1 } = filters;

  const students = await fetchSchoolStudentsForUdise(schoolId, { classId, sectionId, db });
  const duplicates = buildDuplicateSets(students);

  const evaluated = students.map(s => {
    const evalResult = evaluateStudentReadiness(s, duplicates);
    return {
      ...s,
      udise_status: evalResult.status,
      errors: evalResult.errors,
      warnings: evalResult.warnings,
      is_ready: evalResult.isReady,
    };
  });

  let filtered = evaluated;

  if (status) {
    filtered = filtered.filter(s => s.udise_status === status);
  }

  if (missingField) {
    filtered = filtered.filter(s => {
      if (missingField === 'pen_number') return !s.pen_number;
      if (missingField === 'apar_number') return !s.apar_number;
      if (missingField === 'aadhaar_number') return !s.aadhaar_number;
      if (missingField === 'dob') return !s.dob;
      if (missingField === 'parent_name') return !s.father_name && !s.mother_name && !s.guardian_name;
      return true;
    });
  }

  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const paginated = filtered.slice(offset, offset + safeLimit);

  return {
    students: paginated,
    pagination: {
      total: filtered.length,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(filtered.length / safeLimit),
    },
  };
}

/**
 * Sanitize cell value against CSV formula injection and escape double quotes per RFC 4180.
 */
export function sanitizeCsvCell(value) {
  if (value == null) return '';
  let str = String(value);
  // Neutralize formula injection: if untrimmed or trimmed string begins with formula triggers
  if (/^\s*[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return str.replace(/"/g, '""');
}

/**
 * Mask Aadhaar number for non-admin viewers to protect sensitive PII.
 */
export function maskAadhaarNumber(val) {
  if (!val) return '';
  const clean = String(val).replace(/[\s-]/g, '');
  if (clean.length === 12) {
    return `XXXXXXXX${clean.slice(8)}`;
  }
  return 'XXXXXXXXXXXX';
}

/**
 * Generate compliant UDISE CSV string.
 */
export async function generateUdiseCsv(schoolId, { classId = null, maskAadhaar = false } = {}, db = sql) {
  const students = await fetchSchoolStudentsForUdise(schoolId, { classId, db });
  const duplicates = buildDuplicateSets(students);

  const headers = [
    'Admission Number',
    'Student Name',
    'Class',
    'Section',
    'Gender',
    'Date of Birth',
    'PEN Number',
    'APAAR Number',
    'Aadhaar Number',
    'Father Name',
    'Mother Name',
    'UDISE Status',
    'Validation Notes',
  ];

  const rows = [headers.join(',')];

  for (const s of students) {
    const evalResult = evaluateStudentReadiness(s, duplicates);
    const notes = [...evalResult.errors, ...evalResult.warnings].map(i => i.error).join('; ');
    const rawAadhaar = s.aadhaar_number || '';
    const displayedAadhaar = maskAadhaar ? maskAadhaarNumber(rawAadhaar) : rawAadhaar;

    const line = [
      `"${sanitizeCsvCell(s.admission_no)}"`,
      `"${sanitizeCsvCell(s.student_name)}"`,
      `"${sanitizeCsvCell(s.class_name)}"`,
      `"${sanitizeCsvCell(s.section_name)}"`,
      `"${sanitizeCsvCell(s.gender_name || s.gender)}"`,
      `"${sanitizeCsvCell(s.dob ? new Date(s.dob).toISOString().slice(0, 10) : '')}"`,
      `"${sanitizeCsvCell(s.pen_number || '')}"`,
      `"${sanitizeCsvCell(s.apar_number || '')}"`,
      `"${sanitizeCsvCell(displayedAadhaar)}"`,
      `"${sanitizeCsvCell(s.father_name || '')}"`,
      `"${sanitizeCsvCell(s.mother_name || '')}"`,
      `"${sanitizeCsvCell(evalResult.status)}"`,
      `"${sanitizeCsvCell(notes)}"`,
    ];

    rows.push(line.join(','));
  }

  return rows.join('\r\n');
}
