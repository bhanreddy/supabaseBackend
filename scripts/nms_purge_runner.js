// Hard-delete all data for the 5 @nms.com test accounts (school 19).
// DRY RUN by default (transaction rolls back). Set COMMIT=1 to actually delete.
//   node scripts/nms_purge_runner.js            -> dry run (rollback), prints exact counts
//   COMMIT=1 node scripts/nms_purge_runner.js   -> real hard delete + auth.users removal
import sql, { supabaseAdmin } from '../db.js';
import fs from 'fs';
import path from 'path';

const COMMIT = process.env.COMMIT === '1';
const EMAILS = ['testaccounts@nms.com','teststudent@nms.com','testdriver@nms.com','teststaff@nms.com','admin@nms.com'];

async function main() {
  // ---- resolve id sets ----
  const au = await sql`SELECT id, email FROM auth.users WHERE lower(email)=ANY(${EMAILS})`;
  const userIds = au.map(r => r.id);
  if (!userIds.length) { console.log('No matching accounts. Nothing to do.'); await sql.end(); return; }
  const pu = await sql`SELECT id, person_id FROM users WHERE id=ANY(${userIds})`;
  const personIds  = [...new Set(pu.map(r => r.person_id))];
  const studentIds = (await sql`SELECT id FROM students WHERE person_id=ANY(${personIds})`).map(r=>r.id);
  const staffIds   = (await sql`SELECT id FROM staff   WHERE person_id=ANY(${personIds})`).map(r=>r.id);

  console.log(`=== ${COMMIT ? 'COMMIT (REAL DELETE)' : 'DRY RUN (rollback)'} ===`);
  console.log({ accounts: au.map(r=>r.email), userIds: userIds.length, personIds: personIds.length, studentIds: studentIds.length, staffIds: staffIds.length });

  // ---- full backup of everything we will remove/modify ----
  const backupDir = path.resolve('./backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const snap = async (label, q) => { const rows = await q; return [label, rows]; };
  const backup = Object.fromEntries(await Promise.all([
    snap('auth.users',        sql`SELECT * FROM auth.users WHERE id=ANY(${userIds})`),
    snap('public.users',      sql`SELECT * FROM users WHERE id=ANY(${userIds})`),
    snap('persons',           sql`SELECT * FROM persons WHERE id=ANY(${personIds})`),
    snap('students',          sql`SELECT * FROM students WHERE id=ANY(${studentIds})`),
    snap('staff',             sql`SELECT * FROM staff WHERE id=ANY(${staffIds})`),
    snap('person_contacts',   sql`SELECT * FROM person_contacts WHERE person_id=ANY(${personIds})`),
    snap('student_enrollments', sql`SELECT * FROM student_enrollments WHERE student_id=ANY(${studentIds})`),
    snap('staff_attendance',  sql`SELECT * FROM staff_attendance WHERE staff_id=ANY(${staffIds}) OR marked_by=ANY(${userIds})`),
    snap('staff_payroll',     sql`SELECT * FROM staff_payroll WHERE staff_id=ANY(${staffIds})`),
    snap('user_roles',        sql`SELECT * FROM user_roles WHERE user_id=ANY(${userIds}) OR granted_by=ANY(${userIds})`),
    snap('user_devices',      sql`SELECT * FROM user_devices WHERE user_id=ANY(${userIds})`),
    snap('user_settings',     sql`SELECT * FROM user_settings WHERE user_id=ANY(${userIds})`),
    snap('audit_logs',        sql`SELECT * FROM audit_logs WHERE user_id=ANY(${userIds})`),
    snap('admin_notifications', sql`SELECT * FROM admin_notifications WHERE user_id=ANY(${userIds})`),
    snap('access_requests',   sql`SELECT * FROM access_requests WHERE requested_by=ANY(${userIds}) OR reviewed_by=ANY(${userIds})`),
    snap('temp_access_grants', sql`SELECT * FROM temp_access_grants WHERE requested_by=ANY(${userIds}) OR granted_by=ANY(${userIds})`),
  ]));
  const backupPath = path.join(backupDir, `nms_purge_backup_${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ meta: { taken_at: new Date().toISOString(), emails: EMAILS, userIds, personIds, studentIds, staffIds }, tables: backup }, null, 2));
  console.log('backup written:', backupPath, `(${Object.entries(backup).map(([k,v])=>`${k}:${v.length}`).join(', ')})`);

  // ---- deletion inside one transaction ----
  const counts = {};
  await sql.begin(async (tx) => {
    // 1) NO ACTION / no-FK blockers on users
    counts.audit_logs          = (await tx`DELETE FROM audit_logs WHERE user_id=ANY(${userIds})`).count;
    counts.admin_notifications = (await tx`DELETE FROM admin_notifications WHERE user_id=ANY(${userIds})`).count;
    // user_roles.granted_by (NO ACTION) blocks the user delete during the cascade. Null every
    // granted_by reference to our accounts first. Grantee rows (user_id in set) still cascade on
    // delete; role rows granted to OTHER users are kept, only their granted_by is cleared.
    counts.user_roles_granted_by_nulled =
      (await tx`UPDATE user_roles SET granted_by=NULL WHERE granted_by=ANY(${userIds})`).count;

    // 2) RESTRICT children of students/persons
    counts.student_enrollments = (await tx`DELETE FROM student_enrollments WHERE student_id=ANY(${studentIds})`).count;
    counts.students            = (await tx`DELETE FROM students WHERE id=ANY(${studentIds})`).count;  // cascades student_* children
    // staff: delete attendance + payroll explicitly BEFORE staff so the recalc-payroll
    // trigger (fires per-row on attendance delete) still sees a live staff row for school_id.
    counts.staff_attendance    = (await tx`DELETE FROM staff_attendance WHERE staff_id=ANY(${staffIds})`).count;
    counts.staff_payroll       = (await tx`DELETE FROM staff_payroll WHERE staff_id=ANY(${staffIds})`).count;
    counts.staff               = (await tx`DELETE FROM staff WHERE id=ANY(${staffIds})`).count;        // cascades driver_route_assignments (now-empty attendance/payroll)
    counts.person_contacts     = (await tx`DELETE FROM person_contacts WHERE person_id=ANY(${personIds})`).count;

    // 3) users (cascades user_roles/devices/settings/sessions/notifications/access_requests/temp_access_grants; SET NULLs applied)
    counts.users               = (await tx`DELETE FROM users WHERE id=ANY(${userIds})`).count;

    // 4) persons (now unreferenced)
    counts.persons             = (await tx`DELETE FROM persons WHERE id=ANY(${personIds})`).count;

    if (!COMMIT) {
      console.log('\nDRY RUN counts (will roll back):'); console.table(counts);
      throw new Error('__ROLLBACK_DRY_RUN__');
    }
  }).catch(e => { if (e.message !== '__ROLLBACK_DRY_RUN__') throw e; });

  if (!COMMIT) {
    console.log('\n✅ DRY RUN complete. No data changed. Re-run with COMMIT=1 to execute.');
    await sql.end();
    return;
  }

  console.log('\nDB transaction committed. Deleted counts:'); console.table(counts);

  // 5) auth.users (also cascades auth.identities / sessions)
  let authDeleted = 0;
  for (const u of au) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(u.id);
    if (error) console.error(`  auth delete FAILED ${u.email}: ${error.message}`);
    else { authDeleted++; console.log(`  auth.users deleted: ${u.email}`); }
  }
  console.log(`\n✅ COMMITTED. Purged ${counts.users} app users, ${counts.persons} persons, ${authDeleted}/${au.length} auth logins.`);
  console.log('   Backup:', backupPath);
  await sql.end();
}
main().catch(async e => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
