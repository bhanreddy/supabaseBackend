import sql from '../db.js';
import config from '../config/env.js';
import {
  LoginQrError,
  buildSchoolIMSLoginQr,
  deriveLoginQrSecret,
  hashLoginQrSecret,
  verifyLoginQrSecret,
} from '../utils/studentLoginQr.js';
import {
  ROLE_LOGIN_QR_SUBJECT_CODES,
  canIssueRoleLoginQr,
  labelForRoleLoginQr,
  primaryRoleLoginQrCode,
  roleLoginQrRankSql,
  highestRoleRank,
} from '../utils/roleLoginQr.js';

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
  if (hashLoginQrSecret(secret) !== String(row.token_hash || '').trim()) {
    throw new LoginQrError('LOGIN_QR_KEY_ROTATED');
  }
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

function accountPayload(row, primaryCode) {
  return {
    id: row.user_id,
    name: row.name,
    roleCode: primaryCode,
    roleLabel: labelForRoleLoginQr(primaryCode),
    staffCode: row.staff_code || null,
    designation: row.designation || null,
    email: row.login_email || null,
  };
}

async function loadSchoolCard(schoolId) {
  const [school, settings] = await Promise.all([
    sql`SELECT id, name, logo_url FROM schools WHERE id = ${schoolId} AND is_active = true LIMIT 1`,
    sql`SELECT key, value FROM school_settings
        WHERE school_id = ${schoolId} AND key IN ('school_name', 'school_logo_url')`,
  ]);
  const row = school[0] || null;
  const settingsMap = Object.fromEntries((settings || []).map((item) => [item.key, item.value]));
  const configuredName = firstFilled(settingsMap.school_name);
  const schoolName = (configuredName && !isPlaceholderSchoolName(configuredName)
    ? configuredName
    : (!isPlaceholderSchoolName(row?.name) ? firstFilled(row?.name) : null))
    || configuredName
    || firstFilled(row?.name);
  return row ? {
    id: row.id,
    name: schoolName || row.name,
    logo_url: firstFilled(settingsMap.school_logo_url, row.logo_url),
  } : null;
}

export async function listRoleLoginQrMetadata(schoolId, actorRoleCodes) {
  const actorRank = highestRoleRank(actorRoleCodes);
  const rankSql = sql.unsafe(roleLoginQrRankSql('r.code'));
  const [school, roles] = await Promise.all([
    loadSchoolCard(schoolId),
    sql`SELECT r.code, r.name
        FROM roles r
        WHERE r.school_id = ${schoolId} AND r.deleted_at IS NULL
          AND r.code = ANY(${ROLE_LOGIN_QR_SUBJECT_CODES})
          AND ${rankSql} <= ${actorRank}
          AND ${rankSql} > 0
        ORDER BY ${rankSql} DESC, r.name`,
  ]);
  return {
    school,
    roles: roles.map((role) => ({
      code: role.code,
      label: labelForRoleLoginQr(role.code) || role.name,
    })),
  };
}

export async function listRoleLoginQrUsers(schoolId, actorRoleCodes, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
  const offset = (page - 1) * limit;
  const search = String(filters.search || '').trim().slice(0, 100).replace(/[%_]/g, '');
  const searchPattern = `%${search}%`;
  const roleCode = String(filters.role || '').trim().toLowerCase();
  if (roleCode && !ROLE_LOGIN_QR_SUBJECT_CODES.includes(roleCode)) {
    throw new LoginQrError('UNSUPPORTED_ROLE');
  }
  const actorRank = highestRoleRank(actorRoleCodes);
  const rankSql = sql.unsafe(roleLoginQrRankSql('r.code'));
  const roleFilter = roleCode
    ? sql`AND EXISTS (
        SELECT 1 FROM user_roles urf
        JOIN roles rf ON rf.id = urf.role_id AND rf.school_id = urf.school_id AND rf.deleted_at IS NULL
        WHERE urf.user_id = u.id AND urf.school_id = ${schoolId} AND urf.deleted_at IS NULL
          AND rf.code = ${roleCode}
      )`
    : sql``;
  const searchFilter = search
    ? sql`AND (p.display_name ILIKE ${searchPattern}
        OR COALESCE(au.email, '') ILIKE ${searchPattern}
        OR COALESCE(st.staff_code, '') ILIKE ${searchPattern})`
    : sql``;

  const base = sql`
    FROM users u
    JOIN persons p ON p.id = u.person_id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    JOIN LATERAL (
      SELECT r.code, ${rankSql} AS role_rank
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id AND r.deleted_at IS NULL
      WHERE ur.user_id = u.id AND ur.school_id = ${schoolId} AND ur.deleted_at IS NULL
        AND r.code = ANY(${ROLE_LOGIN_QR_SUBJECT_CODES})
      ORDER BY role_rank DESC, r.code
      LIMIT 1
    ) primary_role ON true
    LEFT JOIN staff st ON st.person_id = u.person_id AND st.school_id = ${schoolId} AND st.deleted_at IS NULL
    LEFT JOIN staff_designations sd ON sd.id = st.designation_id AND sd.school_id = ${schoolId}
    LEFT JOIN auth.users au ON au.id = u.id AND au.email IS NOT NULL
      AND (au.banned_until IS NULL OR au.banned_until <= NOW())
    LEFT JOIN role_login_qr_credentials qr ON qr.user_id = u.id
      AND qr.school_id = ${schoolId} AND qr.revoked_at IS NULL AND qr.expires_at > NOW()
    WHERE u.school_id = ${schoolId} AND u.deleted_at IS NULL AND u.account_status = 'active'
      AND primary_role.role_rank <= ${actorRank}
      AND primary_role.role_rank > 0
      ${roleFilter}
      ${searchFilter}`;

  const [rows, countRows] = await Promise.all([
    sql`SELECT u.id, p.display_name AS name, primary_role.code AS role_code,
          st.staff_code, sd.name AS designation, au.email AS login_email,
          (au.id IS NOT NULL) AS login_configured,
          (qr.id IS NOT NULL) AS qr_ready, qr.expires_at AS qr_expires_at
        ${base}
        ORDER BY p.display_name, u.id
        LIMIT ${limit} OFFSET ${offset}`,
    sql`SELECT COUNT(*)::int AS total ${base}`,
  ]);

  const total = countRows[0]?.total || 0;
  return {
    rows: rows.map((row) => ({
      ...row,
      role_label: labelForRoleLoginQr(row.role_code),
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function findEligibleAccount(exec, schoolId, userId) {
  const [account] = await exec`
    SELECT u.id AS user_id, p.display_name AS name, st.staff_code, sd.name AS designation,
      au.email AS login_email
    FROM users u
    JOIN persons p ON p.id = u.person_id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    LEFT JOIN staff st ON st.person_id = u.person_id AND st.school_id = ${schoolId} AND st.deleted_at IS NULL
    LEFT JOIN staff_designations sd ON sd.id = st.designation_id AND sd.school_id = ${schoolId}
    LEFT JOIN auth.users au ON au.id = u.id AND au.email IS NOT NULL
      AND (au.banned_until IS NULL OR au.banned_until <= NOW())
    WHERE u.id = ${userId} AND u.school_id = ${schoolId}
      AND u.account_status = 'active' AND u.deleted_at IS NULL
    LIMIT 1`;
  if (!account) return null;
  const roles = await exec`
    SELECT r.code
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id AND r.deleted_at IS NULL
    WHERE ur.user_id = ${userId} AND ur.school_id = ${schoolId} AND ur.deleted_at IS NULL`;
  return { ...account, role_codes: roles.map((role) => role.code).filter(Boolean) };
}

export async function issueRoleLoginQrCredential({
  schoolId,
  userId,
  actorUserId,
  actorRoleCodes,
  regenerate = false,
}) {
  assertConfigured();
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${userId} AND school_id = ${schoolId} FOR UPDATE`;
    const account = await findEligibleAccount(tx, schoolId, userId);
    if (!account) throw new LoginQrError('USER_NOT_FOUND');
    const primaryCode = primaryRoleLoginQrCode(account.role_codes);
    if (!primaryCode) throw new LoginQrError('QR_LOGIN_NOT_ALLOWED');
    if (!canIssueRoleLoginQr(actorRoleCodes, account.role_codes)) {
      throw new LoginQrError('QR_ROLE_OUT_OF_SCOPE');
    }
    if (!account.login_email) throw new LoginQrError('LOGIN_NOT_CONFIGURED');
    await tx`SELECT id FROM auth.users WHERE id = ${account.user_id} FOR UPDATE`;

    await tx`UPDATE role_login_qr_credentials
      SET revoked_at = NOW(), revoked_by = ${actorUserId}
      WHERE school_id = ${schoolId} AND user_id = ${userId} AND revoked_at IS NULL
        AND (${regenerate} OR expires_at <= NOW())`;

    let [credential] = await tx`SELECT * FROM role_login_qr_credentials
      WHERE school_id = ${schoolId} AND user_id = ${userId}
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
        userId: account.user_id,
        issuedAt: seed.issued_at,
      });
      [credential] = await tx`INSERT INTO role_login_qr_credentials
        (id, school_id, user_id, role_code, token_hash, version, issued_at, expires_at, generated_by)
        VALUES (${seed.id}, ${schoolId}, ${userId}, ${primaryCode}, ${hashLoginQrSecret(secret)},
          1, ${seed.issued_at}, ${expiresAt}, ${actorUserId})
        RETURNING *`;
      created = true;
    }

    const response = toCredentialResponse(credential);
    await tx`INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, details)
      VALUES (${schoolId}, ${actorUserId},
        ${regenerate ? 'LOGIN_QR_REGENERATED' : created ? 'LOGIN_QR_GENERATED' : 'LOGIN_QR_VIEWED'},
        'role_login_qr', ${userId},
        ${tx.json({
          credential_id: credential.id,
          role_code: primaryCode,
          invalidated_previous_qr: regenerate,
        })})`;
    return { ...response, created, account: accountPayload(account, primaryCode) };
  });
}

export async function resolveRoleLoginQrCredential(parsed, requestedSchoolId) {
  assertConfigured();
  const [row] = await sql`
    SELECT qr.id, qr.school_id, qr.user_id, qr.token_hash, qr.version,
      qr.issued_at, qr.expires_at, qr.revoked_at,
      u.account_status, u.deleted_at AS user_deleted_at
    FROM role_login_qr_credentials qr
    LEFT JOIN users u ON u.id = qr.user_id AND u.school_id = qr.school_id
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

  const roleRows = await sql`
    SELECT r.code
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id AND r.deleted_at IS NULL
    WHERE ur.user_id = ${row.user_id} AND ur.school_id = ${row.school_id}
      AND ur.deleted_at IS NULL`;
  if (!primaryRoleLoginQrCode(roleRows.map((item) => item.code))) {
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

  const used = await sql`UPDATE role_login_qr_credentials
    SET last_used_at = NOW(), use_count = use_count + 1
    WHERE id = ${row.id} AND school_id = ${requestedSchoolId} AND revoked_at IS NULL
      AND expires_at > NOW() RETURNING id`;
  if (!used.length) throw new LoginQrError('QR_TOKEN_REVOKED');
  return {
    credentialId: row.id,
    userId: row.user_id,
    schoolId: row.school_id,
    subject: 'role',
  };
}

export async function assertRoleLoginQrExportScope(schoolId, userIds, actorRoleCodes) {
  const actorRank = highestRoleRank(actorRoleCodes);
  const rankSql = sql.unsafe(roleLoginQrRankSql('r.code'));
  const scoped = await sql`
    SELECT u.id
    FROM users u
    JOIN LATERAL (
      SELECT ${rankSql} AS role_rank
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id AND r.deleted_at IS NULL
      WHERE ur.user_id = u.id AND ur.school_id = ${schoolId} AND ur.deleted_at IS NULL
        AND r.code = ANY(${ROLE_LOGIN_QR_SUBJECT_CODES})
      ORDER BY role_rank DESC
      LIMIT 1
    ) primary_role ON true
    WHERE u.school_id = ${schoolId} AND u.deleted_at IS NULL
      AND u.id = ANY(${userIds}::uuid[])
      AND primary_role.role_rank <= ${actorRank}
      AND primary_role.role_rank > 0`;
  return scoped.length === userIds.length;
}
