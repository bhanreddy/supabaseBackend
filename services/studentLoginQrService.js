import sql from '../db.js';
import { supabase, supabaseAdmin } from '../db.js';
import config from '../config/env.js';
import {
  LoginQrError,
  assertSameLoginQrSchool,
  buildSchoolIMSLoginQr,
  deriveLoginQrSecret,
  hashLoginQrSecret,
  normalizeQrOtpType,
  parseSchoolIMSLoginQr,
  verifyLoginQrSecret,
} from '../utils/studentLoginQr.js';

function assertConfigured() {
  if (!config.loginQr.secret || Buffer.byteLength(config.loginQr.secret, 'utf8') < 32) {
    throw new LoginQrError('LOGIN_QR_NOT_CONFIGURED');
  }
}

function isPlaceholderSchoolName(value) {
  const name = String(value || '').trim();
  return !name || /^(default\s+school(\s+name)?|school|school\s+name|my\s+school|unnamed\s+school)$/i.test(name);
}

function firstFilled(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return null;
}

function toCredentialResponse(row) {
  const secret = deriveLoginQrSecret({
    masterSecret: config.loginQr.secret,
    credentialId: row.id,
    schoolId: row.school_id,
    userId: row.user_id,
    issuedAt: row.issued_at,
    version: row.version,
  });
  if (hashLoginQrSecret(secret) !== String(row.token_hash || '').trim()) throw new LoginQrError('LOGIN_QR_KEY_ROTATED');
  return {
    qrPayload: buildSchoolIMSLoginQr({
      credentialId: row.id,
      schoolId: row.school_id,
      secret,
      version: row.version,
    }),
    credentialId: row.id,
    expiresAt: row.expires_at,
  };
}

export async function listLoginQrMetadata(schoolId) {
  const [school, settings, academicYears, classSections] = await Promise.all([
    sql`SELECT id, name, logo_url FROM schools WHERE id = ${schoolId} AND is_active = true LIMIT 1`,
    sql`SELECT key, value FROM school_settings
        WHERE school_id = ${schoolId} AND key IN ('school_name', 'school_logo_url')`,
    sql`SELECT id, code, start_date, end_date,
          (CURRENT_DATE BETWEEN start_date AND end_date) AS is_current
        FROM academic_years
        WHERE school_id = ${schoolId}
        ORDER BY start_date DESC`,
    sql`SELECT cs.id, cs.academic_year_id, c.id AS class_id, c.name AS class_name,
          sec.id AS section_id, sec.name AS section_name
        FROM class_sections cs
        JOIN classes c ON c.id = cs.class_id AND c.school_id = ${schoolId} AND c.deleted_at IS NULL
        JOIN sections sec ON sec.id = cs.section_id AND sec.school_id = ${schoolId} AND sec.deleted_at IS NULL
        WHERE cs.school_id = ${schoolId} AND cs.deleted_at IS NULL
        ORDER BY COALESCE(c.sort_order, 9999), c.name, sec.name`,
  ]);
  const row = school[0] || null;
  const settingsMap = Object.fromEntries((settings || []).map((item) => [item.key, item.value]));
  const configuredName = firstFilled(settingsMap.school_name);
  const schoolName = (configuredName && !isPlaceholderSchoolName(configuredName)
    ? configuredName
    : (!isPlaceholderSchoolName(row?.name) ? firstFilled(row?.name) : null))
    || configuredName
    || firstFilled(row?.name);
  return {
    school: row ? {
      id: row.id,
      name: schoolName || row.name,
      logo_url: firstFilled(settingsMap.school_logo_url, row.logo_url),
    } : null,
    academicYears,
    classSections,
  };
}

export async function listLoginQrStudents(schoolId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
  const offset = (page - 1) * limit;
  const search = String(filters.search || '').trim().slice(0, 100);
  const searchPattern = `%${search}%`;
  const status = String(filters.status || 'active').toLowerCase();
  if (!['active', 'inactive', 'all'].includes(status)) throw new LoginQrError('UNSUPPORTED_STUDENT_STATUS');
  const statusFilter = status === 'all' ? sql`` : status === 'active' ? sql`AND s.status_id = 1` : sql`AND s.status_id <> 1`;

  const classFilter = filters.classId ? sql`AND c.id = ${filters.classId}` : sql``;
  const sectionFilter = filters.sectionId ? sql`AND sec.id = ${filters.sectionId}` : sql``;
  const yearFilter = filters.academicYearId ? sql`AND e.academic_year_id = ${filters.academicYearId}` : sql``;
  const searchFilter = search
    ? sql`AND (p.display_name ILIKE ${searchPattern} OR s.admission_no ILIKE ${searchPattern}
        OR COALESCE(email.contact_value, '') ILIKE ${searchPattern}
        OR COALESCE(au.email, '') ILIKE ${searchPattern})`
    : sql``;

  const base = sql`
    FROM students s
    JOIN persons p ON p.id = s.person_id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    JOIN (
      SELECT DISTINCT ON (e.student_id) e.student_id, e.class_section_id, e.academic_year_id
      FROM student_enrollments e
      WHERE e.school_id = ${schoolId} AND e.status = 'active' AND e.deleted_at IS NULL
        ${yearFilter}
      ORDER BY e.student_id, e.start_date DESC NULLS LAST, e.id
    ) se ON se.student_id = s.id
    JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id = ${schoolId} AND cs.deleted_at IS NULL
    JOIN classes c ON c.id = cs.class_id AND c.school_id = ${schoolId} AND c.deleted_at IS NULL
    JOIN sections sec ON sec.id = cs.section_id AND sec.school_id = ${schoolId} AND sec.deleted_at IS NULL
    LEFT JOIN users u ON u.person_id = s.person_id AND u.school_id = ${schoolId}
      AND u.account_status = 'active' AND u.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND ur.school_id = ${schoolId} AND r.school_id = ${schoolId}
          AND ur.deleted_at IS NULL AND r.deleted_at IS NULL AND r.code = 'student')
      AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND ur.deleted_at IS NULL AND r.deleted_at IS NULL AND r.code <> 'student')
    LEFT JOIN auth.users au ON au.id = u.id AND au.email IS NOT NULL
      AND (au.banned_until IS NULL OR au.banned_until <= NOW())
    LEFT JOIN LATERAL (
      SELECT pc.contact_value FROM person_contacts pc
      WHERE pc.person_id = p.id AND pc.school_id = ${schoolId}
        AND pc.contact_type = 'email' AND pc.is_primary = true AND pc.deleted_at IS NULL
      ORDER BY pc.created_at DESC LIMIT 1
    ) email ON true
    LEFT JOIN student_login_qr_credentials qr ON qr.student_id = s.id
      AND qr.school_id = ${schoolId} AND qr.revoked_at IS NULL AND qr.expires_at > NOW()
    WHERE s.school_id = ${schoolId} AND s.deleted_at IS NULL ${statusFilter}
      ${classFilter} ${sectionFilter} ${searchFilter}`;

  const [rows, countRows] = await Promise.all([
    sql`SELECT s.id, p.display_name AS name, s.admission_no,
          c.id AS class_id, c.name AS class_name, sec.id AS section_id, sec.name AS section_name,
          se.academic_year_id, au.email AS login_email,
          (au.id IS NOT NULL AND s.status_id = 1) AS login_configured,
          (qr.id IS NOT NULL) AS qr_ready, qr.expires_at AS qr_expires_at
        ${base}
        ORDER BY p.display_name, s.admission_no
        LIMIT ${limit} OFFSET ${offset}`,
    sql`SELECT COUNT(*)::int AS total ${base}`,
  ]);

  const total = countRows[0]?.total || 0;
  return { rows, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function findEligibleStudent(exec, schoolId, studentId) {
  const [student] = await exec`
    SELECT s.id AS student_id, s.school_id, s.admission_no, p.display_name AS student_name,
      u.id AS user_id, c.name AS class_name, sec.name AS section_name
    FROM students s
    JOIN persons p ON p.id = s.person_id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    LEFT JOIN users u ON u.person_id = s.person_id AND u.school_id = ${schoolId}
      AND u.account_status = 'active' AND u.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND ur.school_id = ${schoolId}
          AND r.school_id = ${schoolId} AND r.code = 'student'
          AND ur.deleted_at IS NULL AND r.deleted_at IS NULL
      )
      AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND ur.deleted_at IS NULL AND r.deleted_at IS NULL AND r.code <> 'student')
      AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.id AND au.email IS NOT NULL
        AND (au.banned_until IS NULL OR au.banned_until <= NOW()))
    LEFT JOIN LATERAL (
      SELECT se.class_section_id FROM student_enrollments se
      WHERE se.student_id = s.id AND se.school_id = ${schoolId}
        AND se.status = 'active' AND se.deleted_at IS NULL
      ORDER BY se.start_date DESC LIMIT 1
    ) enrollment ON true
    LEFT JOIN class_sections cs ON cs.id = enrollment.class_section_id AND cs.school_id = ${schoolId}
    LEFT JOIN classes c ON c.id = cs.class_id AND c.school_id = ${schoolId}
    LEFT JOIN sections sec ON sec.id = cs.section_id AND sec.school_id = ${schoolId}
    WHERE s.id = ${studentId} AND s.school_id = ${schoolId}
      AND s.status_id = 1 AND s.deleted_at IS NULL
    LIMIT 1`;
  return student || null;
}

export async function issueLoginQrCredential({ schoolId, studentId, actorUserId, regenerate = false }) {
  assertConfigured();
  return sql.begin(async (tx) => {
    // Serialize initial generation as well as regeneration (locking a missing QR row is insufficient).
    await tx`SELECT id FROM students WHERE id = ${studentId} AND school_id = ${schoolId} FOR UPDATE`;
    const student = await findEligibleStudent(tx, schoolId, studentId);
    if (!student) throw new LoginQrError('STUDENT_NOT_FOUND');
    if (!student.user_id) throw new LoginQrError('LOGIN_NOT_CONFIGURED');
    // Auth's reset trigger takes this same row lock. A concurrent reset must revoke
    // a just-issued card, or finish before a new card can be issued.
    await tx`SELECT id FROM auth.users WHERE id = ${student.user_id} FOR UPDATE`;

    {
      await tx`UPDATE student_login_qr_credentials
        SET revoked_at = NOW(), revoked_by = ${actorUserId}
        WHERE school_id = ${schoolId} AND student_id = ${studentId} AND revoked_at IS NULL
          AND (${regenerate} OR expires_at <= NOW() OR user_id <> ${student.user_id})`;
    }

    let [credential] = await tx`SELECT * FROM student_login_qr_credentials
      WHERE school_id = ${schoolId} AND student_id = ${studentId}
        AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY issued_at DESC LIMIT 1 FOR UPDATE`;

    let created = false;
    if (!credential) {
      const [seed] = await tx`SELECT gen_random_uuid() AS id, NOW() AS issued_at`;
      const expiresAt = new Date(new Date(seed.issued_at).getTime() + config.loginQr.ttlDays * 86400000);
      const secret = deriveLoginQrSecret({
        masterSecret: config.loginQr.secret,
        credentialId: seed.id,
        schoolId,
        userId: student.user_id,
        issuedAt: seed.issued_at,
      });
      [credential] = await tx`INSERT INTO student_login_qr_credentials
        (id, school_id, student_id, user_id, token_hash, version, issued_at, expires_at, generated_by)
        VALUES (${seed.id}, ${schoolId}, ${studentId}, ${student.user_id}, ${hashLoginQrSecret(secret)},
          1, ${seed.issued_at}, ${expiresAt}, ${actorUserId})
        RETURNING *`;
      created = true;
    }

    const response = toCredentialResponse(credential);
    await tx`INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, details)
      VALUES (${schoolId}, ${actorUserId}, ${regenerate ? 'LOGIN_QR_REGENERATED' : created ? 'LOGIN_QR_GENERATED' : 'LOGIN_QR_VIEWED'},
        'student_login_qr', ${studentId}, ${tx.json({ credential_id: credential.id, invalidated_previous_qr: regenerate })})`;
    return {
      ...response,
      created,
      student: {
        id: student.student_id,
        name: student.student_name,
        admissionNo: student.admission_no,
        className: student.class_name,
        sectionName: student.section_name,
      },
    };
  });
}

export async function revokeLoginQrForUser(userId, schoolId = null, actorUserId = null) {
  if (!userId) return 0;
  const rows = schoolId
    ? await sql`UPDATE student_login_qr_credentials SET revoked_at = NOW(), revoked_by = ${actorUserId}
        WHERE user_id = ${userId} AND school_id = ${schoolId} AND revoked_at IS NULL RETURNING id`
    : await sql`UPDATE student_login_qr_credentials SET revoked_at = NOW(), revoked_by = ${actorUserId}
        WHERE user_id = ${userId} AND revoked_at IS NULL RETURNING id`;
  return rows.length;
}

export async function resolveLoginQrCredential(rawPayload, requestedSchoolId) {
  assertConfigured();
  const parsed = parseSchoolIMSLoginQr(rawPayload);
  assertSameLoginQrSchool(parsed.schoolId, requestedSchoolId);

  const [row] = await sql`
    SELECT qr.id, qr.school_id, qr.student_id, qr.user_id, qr.token_hash, qr.version,
      qr.issued_at, qr.expires_at, qr.revoked_at,
      u.account_status, u.deleted_at AS user_deleted_at, u.person_id,
      s.status_id, s.deleted_at AS student_deleted_at, s.person_id AS student_person_id
    FROM student_login_qr_credentials qr
    LEFT JOIN users u ON u.id = qr.user_id AND u.school_id = qr.school_id
    LEFT JOIN students s ON s.id = qr.student_id AND s.school_id = qr.school_id
    WHERE qr.id = ${parsed.credentialId} AND qr.school_id = ${requestedSchoolId}
    LIMIT 1`;
  if (!row) throw new LoginQrError('QR_TOKEN_NOT_FOUND');
  if (row.revoked_at) throw new LoginQrError('QR_TOKEN_REVOKED');
  if (!(new Date(row.expires_at).getTime() > Date.now())) throw new LoginQrError('QR_TOKEN_EXPIRED');
  if (Number(row.version) !== Number(parsed.version)) throw new LoginQrError('QR_INVALID');

  const [school] = await sql`
    SELECT id FROM schools WHERE id = ${row.school_id} AND is_active = true LIMIT 1`;
  if (!school) throw new LoginQrError('QR_SCHOOL_NOT_FOUND');

  if (!row.user_id || row.user_deleted_at) throw new LoginQrError('QR_USER_NOT_FOUND');
  if (row.account_status !== 'active') throw new LoginQrError('QR_USER_INACTIVE');
  if (!row.student_id || row.student_deleted_at || Number(row.status_id) !== 1) {
    throw new LoginQrError('QR_USER_INACTIVE');
  }
  if (row.person_id && row.student_person_id && String(row.person_id) !== String(row.student_person_id)) {
    throw new LoginQrError('QR_LOGIN_NOT_ALLOWED');
  }

  const roleRows = await sql`
    SELECT r.code
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id AND r.deleted_at IS NULL
    WHERE ur.user_id = ${row.user_id} AND ur.school_id = ${row.school_id}
      AND ur.deleted_at IS NULL`;
  const roleCodes = roleRows.map((item) => item.code).filter(Boolean);
  if (!roleCodes.includes('student') || roleCodes.some((code) => code !== 'student')) {
    throw new LoginQrError('QR_LOGIN_NOT_ALLOWED');
  }

  const storedHash = String(row.token_hash || '').trim();
  const expectedSecret = deriveLoginQrSecret({
    masterSecret: config.loginQr.secret,
    credentialId: row.id,
    schoolId: row.school_id,
    userId: row.user_id,
    issuedAt: row.issued_at,
    version: row.version,
  });
  if (hashLoginQrSecret(expectedSecret) !== storedHash) {
    throw new LoginQrError('LOGIN_QR_KEY_ROTATED');
  }
  if (!verifyLoginQrSecret(parsed.secret, expectedSecret, storedHash)) {
    throw new LoginQrError('QR_INVALID');
  }

  const used = await sql`UPDATE student_login_qr_credentials
    SET last_used_at = NOW(), use_count = use_count + 1
    WHERE id = ${row.id} AND school_id = ${requestedSchoolId} AND revoked_at IS NULL
      AND expires_at > NOW() RETURNING id`;
  if (!used.length) throw new LoginQrError('QR_TOKEN_REVOKED');
  return { credentialId: row.id, userId: row.user_id, schoolId: row.school_id };
}

export async function exchangeLoginQrForSession(rawPayload, requestedSchoolId) {
  const credential = await resolveLoginQrCredential(rawPayload, requestedSchoolId);
  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(credential.userId);
  const email = userData?.user?.email;
  if (userError || !email || userData.user.id !== credential.userId ||
    (userData.user.banned_until && new Date(userData.user.banned_until) > new Date())) {
    throw new LoginQrError('QR_USER_INACTIVE');
  }

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  const emailOtp = linkData?.properties?.email_otp;
  if (linkError || (linkData?.user?.id && linkData.user.id !== credential.userId) || (!tokenHash && !emailOtp)) {
    throw new LoginQrError('QR_SESSION_CREATE_FAILED');
  }

  const verifyType = normalizeQrOtpType(linkData?.properties?.verification_type);
  let session = null;
  if (tokenHash) {
    const hashed = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: verifyType,
    });
    if (!hashed.error && hashed.data?.session?.user?.id === credential.userId) {
      session = hashed.data.session;
    }
  }
  if (!session && emailOtp) {
    const otp = await supabase.auth.verifyOtp({
      email,
      token: emailOtp,
      type: 'email',
    });
    if (!otp.error && otp.data?.session?.user?.id === credential.userId) {
      session = otp.data.session;
    }
  }
  if (!session?.access_token || !session.refresh_token) {
    throw new LoginQrError('QR_SESSION_CREATE_FAILED');
  }

  return {
    credential,
    session: {
      token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    },
  };
}
