// BACKUP (read-only): exports every row that delete_school17_students.sql will
// remove, using the SAME scope/predicates, into one JSON snapshot. Restorable.
import sql from '../db.js';
import fs from 'fs';
import path from 'path';

const S = 17;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('./backups');
const outFile = path.join(outDir, `school17_students_backup_${stamp}.json`);

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  // ---- id-sets (identical definitions to the delete script) ----
  const stu  = (await sql`SELECT id FROM students WHERE school_id=${S}`).map(r => r.id);
  const sfee = (await sql`SELECT id FROM student_fees WHERE school_id=${S}`).map(r => r.id);
  const senr = (await sql`SELECT id FROM student_enrollments WHERE school_id=${S}`).map(r => r.id);
  const suser = (await sql`
    SELECT DISTINCT ur.user_id AS id FROM user_roles ur JOIN roles r ON r.id=ur.role_id
    WHERE ur.school_id=${S} AND r.name='Student'
      AND ur.user_id NOT IN (SELECT ur2.user_id FROM user_roles ur2 JOIN roles r2 ON r2.id=ur2.role_id
                             WHERE ur2.school_id=${S} AND r2.name<>'Student')`).map(r => r.id);
  let pers = (await sql`
    SELECT person_id AS id FROM students WHERE school_id=${S} AND person_id IS NOT NULL
    UNION SELECT person_id FROM parents WHERE school_id=${S} AND person_id IS NOT NULL`).map(r => r.id);
  const keepPers = new Set([
    ...(await sql`SELECT person_id AS id FROM staff WHERE school_id=${S}`).map(r => r.id),
    ...(await sql`SELECT person_id AS id FROM users WHERE school_id=${S} AND person_id IS NOT NULL AND id NOT IN ${sql(suser.length?suser:['00000000-0000-0000-0000-000000000000'])}`).map(r => r.id),
  ]);
  pers = pers.filter(id => !keepPers.has(id));

  const inStu = stu.length ? stu : ['_'];
  const inSfee = sfee.length ? sfee : ['_'];
  const inSenr = senr.length ? senr : ['_'];
  const inSuser = suser.length ? suser : ['_'];
  const inPers = pers.length ? pers : ['_'];

  // ---- per-table SELECTs (same predicates as the deletes) ----
  const q = {
    marks: sql`SELECT * FROM marks WHERE school_id=${S} AND student_enrollment_id IN ${sql(inSenr)}`,
    daily_attendance: sql`SELECT * FROM daily_attendance WHERE school_id=${S} AND student_enrollment_id IN ${sql(inSenr)}`,
    receipt_items: sql`SELECT * FROM receipt_items WHERE school_id=${S} AND (receipt_id IN (SELECT id FROM receipts WHERE student_id IN ${sql(inStu)}) OR fee_transaction_id IN (SELECT id FROM fee_transactions WHERE student_fee_id IN ${sql(inSfee)}))`,
    fee_transactions: sql`SELECT * FROM fee_transactions WHERE student_fee_id IN ${sql(inSfee)}`,
    fee_adjustments: sql`SELECT * FROM fee_adjustments WHERE school_id=${S} AND (student_id IN ${sql(inStu)} OR student_fee_id IN ${sql(inSfee)})`,
    defaulter_payments: sql`SELECT * FROM defaulter_payments WHERE school_id=${S} AND defaulter_due_id IN (SELECT id FROM defaulter_dues WHERE student_id IN ${sql(inStu)})`,
    receipts: sql`SELECT * FROM receipts WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    defaulter_dues: sql`SELECT * FROM defaulter_dues WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    discipline_records: sql`SELECT * FROM discipline_records WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    hostel_allocations: sql`SELECT * FROM hostel_allocations WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    issued_certificates: sql`SELECT * FROM issued_certificates WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    complaints: sql`SELECT * FROM complaints WHERE school_id=${S} AND raised_for_student_id IN ${sql(inStu)}`,
    student_life_values_progress: sql`SELECT * FROM student_life_values_progress WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    student_money_science_progress: sql`SELECT * FROM student_money_science_progress WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    student_science_projects: sql`SELECT * FROM student_science_projects WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    student_transport: sql`SELECT * FROM student_transport WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    transport_fee_payments: sql`SELECT * FROM transport_fee_payments WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    transport_import_rows: sql`SELECT * FROM transport_import_rows WHERE school_id=${S} AND student_id IN ${sql(inStu)}`,
    student_fees: sql`SELECT * FROM student_fees WHERE school_id=${S}`,
    student_enrollments: sql`SELECT * FROM student_enrollments WHERE school_id=${S}`,
    student_parents: sql`SELECT * FROM student_parents WHERE school_id=${S}`,
    notification_dispatch_recipients: sql`SELECT * FROM notification_dispatch_recipients WHERE user_id IN ${sql(inSuser)}`,
    notifications: sql`SELECT * FROM notifications WHERE user_id IN ${sql(inSuser)}`,
    notification_events: sql`SELECT * FROM notification_events WHERE target_user_id IN ${sql(inSuser)}`,
    notification_preferences: sql`SELECT * FROM notification_preferences WHERE user_id IN ${sql(inSuser)}`,
    notification_logs: sql`SELECT * FROM notification_logs WHERE user_id IN ${sql(inSuser)}`,
    user_settings: sql`SELECT * FROM user_settings WHERE user_id IN ${sql(inSuser)}`,
    user_devices: sql`SELECT * FROM user_devices WHERE user_id IN ${sql(inSuser)}`,
    user_roles: sql`SELECT * FROM user_roles WHERE user_id IN ${sql(inSuser)}`,
    audit_logs: sql`SELECT * FROM audit_logs WHERE user_id IN ${sql(inSuser)}`,
    students: sql`SELECT * FROM students WHERE school_id=${S}`,
    parents: sql`SELECT * FROM parents WHERE school_id=${S}`,
    users: sql`SELECT * FROM users WHERE id IN ${sql(inSuser)}`,
    person_contacts: sql`SELECT * FROM person_contacts WHERE person_id IN ${sql(inPers)}`,
    persons: sql`SELECT * FROM persons WHERE id IN ${sql(inPers)}`,
  };

  const out = { meta: { school_id: S, taken_at: new Date().toISOString(), id_sets: { students: stu.length, student_fees: sfee.length, enrollments: senr.length, student_users: suser.length, persons: pers.length } }, tables: {} };
  const summary = [];
  for (const [t, p] of Object.entries(q)) {
    const rows = await p;
    out.tables[t] = rows;
    summary.push({ table: t, rows: rows.length });
  }

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  const total = summary.reduce((a, b) => a + b.rows, 0);
  console.log('BACKUP WRITTEN:', outFile);
  console.log('file size:', (fs.statSync(outFile).size / 1048576).toFixed(2), 'MB');
  console.log('total rows captured:', total);
  console.table(summary.filter(r => r.rows > 0));
  await sql.end();
}
main().catch(async e => { console.error('BACKUP FAILED:', e); try { await sql.end(); } catch {} process.exit(1); });
