// READ-ONLY post-delete verification.
import sql from '../db.js';
const S = 17;
async function main() {
  console.log('--- school 17 row still present? ---');
  console.log(await sql`SELECT id, name, code, is_active FROM schools WHERE id=${S}`);

  console.log('\n--- should be ZERO now ---');
  for (const t of ['students','parents','student_fees','student_enrollments','student_parents','fee_transactions','receipts']) {
    const [{ n }] = await sql.unsafe(`SELECT count(*)::int n FROM ${t} WHERE school_id=${S}`);
    console.log(`  ${t.padEnd(22)} = ${n}`);
  }
  const [{ n: su }] = await sql`SELECT count(*)::int n FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.school_id=${S} AND r.name='Student'`;
  console.log(`  Student-role users     = ${su}`);

  console.log('\n--- should be PRESERVED ---');
  for (const t of ['staff','staff_payroll','roles','permissions','role_permissions','school_settings','classes','sections','class_sections','fee_structures','fee_types','academic_years','financial_audit_logs']) {
    const [{ n }] = await sql.unsafe(`SELECT count(*)::int n FROM ${t} WHERE school_id=${S}`);
    console.log(`  ${t.padEnd(22)} = ${n}`);
  }
  const [{ n: staffUsers }] = await sql`SELECT count(*)::int n FROM users WHERE school_id=${S}`;
  const [{ n: persLeft }] = await sql`SELECT count(*)::int n FROM persons WHERE school_id=${S}`;
  console.log(`  users (staff/admin)    = ${staffUsers}`);
  console.log(`  persons (staff/admin)  = ${persLeft}`);

  console.log('\n--- append-only guard re-enabled? (tgenabled should be O) ---');
  console.log(await sql.unsafe(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname='trg_guard_fee_txn'`));

  console.log('\n--- orphan check: any child rows referencing now-deleted students? (should be 0) ---');
  for (const [t, col] of [['student_fees','student_id'],['student_enrollments','student_id'],['receipts','student_id'],['student_transport','student_id']]) {
    const [{ n }] = await sql.unsafe(`SELECT count(*)::int n FROM ${t} ch WHERE ch.${col} NOT IN (SELECT id FROM students)`);
    console.log(`  orphan ${t}.${col} = ${n}`);
  }

  console.log('\n--- deletion audit log (this purge) ---');
  console.log(await sql`SELECT table_name, rows_deleted FROM tenant_student_deletion_audit WHERE school_id=${S} ORDER BY id DESC LIMIT 20`);

  await sql.end();
}
main().catch(async e=>{console.error('FAILED:',e.message);try{await sql.end();}catch{}process.exit(1);});
