/**
 * Login QR cards for every non-student portal role.
 * Students keep the class-based student login QR. Issuers cannot mint a card
 * for an account whose highest role outranks them.
 */
export const ROLE_LOGIN_QR_SUBJECTS = Object.freeze([
  { code: 'admin', label: 'Administrator', rank: 100 },
  { code: 'principal', label: 'Principal', rank: 90 },
  { code: 'management', label: 'Management', rank: 90 },
  { code: 'accounts', label: 'Accounts', rank: 70 },
  { code: 'accountant', label: 'Accountant', rank: 70 },
  { code: 'librarian', label: 'Librarian', rank: 60 },
  { code: 'staff', label: 'Staff', rank: 40 },
  { code: 'teacher', label: 'Teacher', rank: 40 },
  { code: 'driver', label: 'Driver', rank: 30 },
  { code: 'gate_keeper', label: 'Gate Keeper', rank: 30 },
  { code: 'gatekeeper', label: 'Gate Keeper', rank: 30 },
  { code: 'parent', label: 'Parent', rank: 20 },
]);

export const ROLE_LOGIN_QR_SUBJECT_CODES = Object.freeze(
  ROLE_LOGIN_QR_SUBJECTS.map((role) => role.code),
);

const RANK_BY_CODE = Object.freeze(Object.fromEntries(
  ROLE_LOGIN_QR_SUBJECTS.map((role) => [role.code, role.rank]),
));

export function roleLoginQrRankSql(codeColumn = 'r.code') {
  if (!/^[a-z_]+\.[a-z_]+$/i.test(codeColumn)) {
    throw new Error('Invalid role rank column');
  }
  const branches = ROLE_LOGIN_QR_SUBJECTS
    .map((role) => `WHEN '${role.code}' THEN ${role.rank}`)
    .join(' ');
  return `CASE ${codeColumn} ${branches} ELSE 0 END`;
}

export function highestRoleRank(roleCodes) {
  if (!Array.isArray(roleCodes)) return 0;
  return roleCodes.reduce((max, code) => {
    const rank = RANK_BY_CODE[String(code || '').trim().toLowerCase()] || 0;
    return Math.max(max, rank);
  }, 0);
}

export function canIssueRoleLoginQr(actorRoleCodes, targetRoleCodes) {
  const targetRank = highestRoleRank(targetRoleCodes);
  if (targetRank <= 0) return false;
  return highestRoleRank(actorRoleCodes) >= targetRank;
}

export function labelForRoleLoginQr(code) {
  const normalized = String(code || '').trim().toLowerCase();
  return ROLE_LOGIN_QR_SUBJECTS.find((role) => role.code === normalized)?.label || normalized;
}

export function primaryRoleLoginQrCode(roleCodes) {
  const eligible = (Array.isArray(roleCodes) ? roleCodes : [])
    .map((code) => String(code || '').trim().toLowerCase())
    .filter((code) => (RANK_BY_CODE[code] || 0) > 0);
  eligible.sort((left, right) => (
    (RANK_BY_CODE[right] || 0) - (RANK_BY_CODE[left] || 0) || left.localeCompare(right)
  ));
  return eligible[0] || null;
}
