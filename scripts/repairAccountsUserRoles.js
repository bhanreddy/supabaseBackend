/**
 * Repair accounts staff users created without a user_roles row
 * (e.g. when role_code "accountant" was sent but DB role is "accounts").
 *
 * Usage:
 *   node scripts/repairAccountsUserRoles.js [school_id]
 *
 * Optional: pass a person email to fix one user only:
 *   node scripts/repairAccountsUserRoles.js 13 accounts@example.com
 */
import 'dotenv/config';
import sql from '../db.js';
import { resolveDbRoleCode } from '../utils/roleCodes.js';

const schoolId = process.argv[2] ? Number(process.argv[2]) : null;
const emailFilter = process.argv[3] ? String(process.argv[3]).trim().toLowerCase() : null;

if (!schoolId || Number.isNaN(schoolId)) {
  console.error('Usage: node scripts/repairAccountsUserRoles.js <school_id> [email]');
  process.exit(1);
}

const accountsRoleCode = resolveDbRoleCode('accountant');

const [accountsRole] = await sql`
  SELECT id, code, name FROM roles
  WHERE code = ${accountsRoleCode} AND school_id = ${schoolId}
  LIMIT 1
`;

if (!accountsRole) {
  console.error(`Role "${accountsRoleCode}" not found for school_id=${schoolId}`);
  process.exit(1);
}

const orphans = await sql`
  SELECT u.id AS user_id, u.person_id, pc.contact_value AS email
  FROM users u
  JOIN staff st ON st.person_id = u.person_id AND st.school_id = u.school_id AND st.deleted_at IS NULL
  LEFT JOIN person_contacts pc ON pc.person_id = u.person_id
    AND pc.school_id = u.school_id
    AND pc.contact_type = 'email'
    AND pc.is_primary = true
    AND pc.deleted_at IS NULL
  WHERE u.school_id = ${schoolId}
    AND u.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id
    )
    ${emailFilter ? sql`AND lower(pc.contact_value) = ${emailFilter}` : sql``}
`;

if (orphans.length === 0) {
  console.log('No users without roles found.', emailFilter ? `(email=${emailFilter})` : '');
  process.exit(0);
}

console.log(`Repairing ${orphans.length} user(s) with role "${accountsRole.code}"...`);

for (const row of orphans) {
  await sql`
    INSERT INTO user_roles (user_id, role_id, school_id)
    VALUES (${row.user_id}, ${accountsRole.id}, ${schoolId})
    ON CONFLICT DO NOTHING
  `;
  console.log(`  ✅ user_id=${row.user_id} email=${row.email || '(no email)'}`);
}

console.log('Done.');
