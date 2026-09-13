import test, { mock } from 'node:test';
import fs from 'node:fs';
import { initializeReleaseDatabase } from '../scripts/migrate_release.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createFeeRecoveryFixture } from './support/feeRecoveryDatabase.js';
import { applyBatch1Migrations } from '../scripts/run_batch1_migrations.js';

// Refuse default .env and every remote database. This suite creates/drops only a
// uniquely named local test database, and mocks the external notification boundary.
const url = process.env.FEE_RECOVERY_TEST_DATABASE_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('Set FEE_RECOVERY_TEST_DATABASE_URL to an isolated local PostgreSQL admin connection; remote/default DB forbidden');
}
const admin = postgres(url, { ssl: false, max: 1 });
const database = `schoolims_recovery_test_${process.pid}`;
await admin.unsafe(`CREATE DATABASE ${database}`);
const localUrl = new URL(url); localUrl.pathname = `/${database}`;
const db = postgres(localUrl.toString(), { ssl: false, max: 10, prepare: false, onnotice: () => {} });
mock.module('../config/env.js', { defaultExport: { nodeEnv: 'test', logLevel: 'silent', transportJobs: { enabled: false, databaseUrl: localUrl.toString() }, diaryDigestJobs: { enabled: false }, feeRecoveryJobs: { enabled: true } } });
let sends = [];
let provider = async () => ({ successCount: 1, failureCount: 0, noTokenCount: 0 });
mock.module('../db.js', { defaultExport: db, namedExports: { supabase: {}, supabaseAdmin: {} } });
mock.module('../services/notificationService.js', { namedExports: {
  sendNotificationToUsersWithReport: async (...args) => { sends.push(args); return provider(...args); },
  sendNotificationToUsers: async () => { throw new Error('Use tracked sender'); },
} });
const { getFeeRecoveryOverview, getFeeDefaultersList, getFeeReminderHistory } = await import('../services/feeRecoveryService.js');
const { dispatchFeeReminder, resolveStudentRecipientUserIds } = await import('../services/automationActionService.js');
const { upsertSchoolAutomationRule, RULE_KEYS } = await import('../services/automationRuleService.js');
const { scanAndDispatchFeeRemindersForSchool, runNightlyFeeReminderScan } = await import('../services/feeAutomationJobService.js');
const { feeToday } = await import('../services/feeRecoveryScope.js');
let server;
let school1, school2;

async function school(id) {
  await db`INSERT INTO schools (id,name,code) VALUES (${id}, ${`School ${id}`}, ${String(id)})`;
  const [year] = await db`INSERT INTO academic_years (school_id,code,start_date,end_date) VALUES (${id}, '2026', '2026-04-01','2027-03-31') RETURNING id`;
  const [cls] = await db`INSERT INTO classes (school_id,name) VALUES (${id},'Class 1') RETURNING id`;
  const [section] = await db`INSERT INTO sections (school_id,name) VALUES (${id},'A') RETURNING id`;
  const [cs] = await db`INSERT INTO class_sections (school_id,class_id,section_id,academic_year_id) VALUES (${id},${cls.id},${section.id},${year.id}) RETURNING id`;
  const [type] = await db`INSERT INTO fee_types (school_id,name) VALUES (${id},'Tuition') RETURNING id`;
  const [structure] = await db`INSERT INTO fee_structures (school_id,academic_year_id,class_id,fee_type_id,amount) VALUES (${id},${year.id},${cls.id},${type.id},1000) RETURNING id`;
  for (const role of ['admin','accounts','principal','management','parent','student','staff','driver']) await db`INSERT INTO roles (school_id,code,name) VALUES (${id},${role},${role}) ON CONFLICT (school_id,code) DO NOTHING`;
  await upsertSchoolAutomationRule(id, RULE_KEYS.FEE_DUE_REMINDER, { is_enabled: true });
  return { id, year: year.id, cs: cs.id, structure: structure.id, section: section.id };
}
async function student(school, { due = 1000, paid = 0, discount = 0, days = 7, status = 'pending', active = true, structure = school.structure } = {}) {
  const [person] = await db`INSERT INTO persons (school_id,first_name,display_name,gender_id) VALUES (${school.id},'Test','Test Student',1) RETURNING id`;
  const [s] = await db`INSERT INTO students (school_id,person_id,admission_no,admission_date,status_id) VALUES (${school.id},${person.id},${randomUUID().slice(0,20)},'2026-04-01',${active ? 1 : 2}) RETURNING id`;
  await db`INSERT INTO student_enrollments (school_id,student_id,academic_year_id,class_section_id,start_date) VALUES (${school.id},${s.id},${school.year},${school.cs},'2026-04-01')`;
  const [user] = await db`INSERT INTO users (school_id,person_id) VALUES (${school.id},${person.id}) RETURNING id`;
  const dueDate = days == null ? null : new Date(Date.parse(feeToday()) - days*86400000).toISOString().slice(0,10);
  const [fee] = process.env.FEE_RECOVERY_FULL_SCHEMA === 'true'
    ? await db.begin(async tx => {
      // The deployed schema auto-assigns the structure when enrollment is
      // inserted. Reuse that authoritative row while setting controlled test
      // values; the GUC is the schema's documented recalculation boundary.
      await tx`SELECT set_config('app.fee_recalc_mode', 'true', true)`;
      await tx`UPDATE student_fees SET deleted_at=now()
        WHERE school_id=${school.id} AND student_id=${s.id}
          AND fee_structure_id<>${structure} AND deleted_at IS NULL`;
      const [assigned] = await tx`SELECT id FROM student_fees
        WHERE school_id=${school.id} AND student_id=${s.id} AND fee_structure_id=${structure} AND deleted_at IS NULL`;
      if (assigned && status === 'waived') {
        // The production status trigger derives paid/partial state on UPDATE.
        // A waiver is an explicit assignment state, so create that state via
        // INSERT after retiring the automatic pending assignment.
        await tx`UPDATE student_fees SET deleted_at=now() WHERE id=${assigned.id}`;
        return tx`INSERT INTO student_fees (school_id,student_id,fee_structure_id,amount_due,amount_paid,discount,status,due_date)
          VALUES (${school.id},${s.id},${structure},${due},${paid},${discount},${status},${dueDate}) RETURNING *`;
      }
      if (assigned) return tx`UPDATE student_fees SET amount_due=${due}, amount_paid=${paid}, discount=${discount},
        status=${status}, due_date=${dueDate} WHERE id=${assigned.id} RETURNING *`;
      return tx`INSERT INTO student_fees (school_id,student_id,fee_structure_id,amount_due,amount_paid,discount,status,due_date)
        VALUES (${school.id},${s.id},${structure},${due},${paid},${discount},${status},${dueDate}) RETURNING *`;
    })
    : await db`INSERT INTO student_fees (school_id,student_id,fee_structure_id,amount_due,amount_paid,discount,status,due_date)
      VALUES (${school.id},${s.id},${structure},${due},${paid},${discount},${status},${dueDate}) RETURNING *`;
  return { studentId: s.id, studentFeeId: fee.id, schoolId: school.id, userId: user.id, fee };
}
const manual = row => ({ schoolId: row.schoolId, studentId: row.studentId });
async function pay(row, amount, refundOf = null) {
  const [payment] = await db`INSERT INTO fee_transactions (school_id,student_fee_id,amount,payment_method,transaction_ref,refund_of)
    VALUES (${row.schoolId},${row.studentFeeId},${amount},'cash',${randomUUID()},${refundOf}) RETURNING id`;
  return payment.id;
}

test.before(async () => {
  if (process.env.FEE_RECOVERY_FULL_SCHEMA === 'true') {
    await db.unsafe(fs.readFileSync(new URL('./support/supabasePlatform.sql', import.meta.url), 'utf8'));
    await initializeReleaseDatabase(db);
  } else await createFeeRecoveryFixture(db);
  await db`INSERT INTO genders (id,name) VALUES (1,'Male') ON CONFLICT DO NOTHING`;
  await db`INSERT INTO student_statuses (id,code) VALUES (1,'active'),(2,'withdrawn') ON CONFLICT DO NOTHING`;
  await applyBatch1Migrations(db);
  school1 = await school(1); school2 = await school(2);
});
test.beforeEach(() => { sends = []; provider = async () => ({ successCount: 1, failureCount: 0, noTokenCount: 0 }); });
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.end({ timeout: 1 });
  await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
  await admin.end({ timeout: 1 });
});

test('forward migrations reapply without data loss; student history index is valid; portal has no policies', async () => {
  await applyBatch1Migrations(db);
  assert.equal((await db`SELECT count(*)::int n FROM schools`)[0].n, 2);
  const [index] = await db`SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_auto_exec_student_created'::regclass`;
  assert.equal(index.indisvalid, true);
  assert.equal((await db`SELECT * FROM pg_policies WHERE tablename IN ('automation_execution_logs','school_automation_rules') AND roles && ARRAY['public','anon','authenticated']::name[]`).length, 0);
});

test('ledger totals include paid, partial and concession; per-fee buckets sum exactly to outstanding', async () => {
  await student(school1, { due: 1000 });
  await student(school1, { due: 1000, paid: 400, discount: 100, status: 'partial' });
  await student(school1, { due: 1000, paid: 1000, status: 'paid' });
  const ov = await getFeeRecoveryOverview(1);
  assert.equal(ov.summary.total_expected, 2900);
  assert.equal(ov.summary.total_collected, 1400);
  assert.equal(ov.summary.total_outstanding, 1500);
  assert.equal(ov.summary.collection_efficiency, 48.3);
  assert.equal(Object.values(ov.ageing_buckets).reduce((n,b) => n+b.amount,0),1500);
});

test('every exact age boundary, null date and future date enters exactly one bucket', async () => {
  const sc = await school(3);
  for (const days of [null,-1,0,1,7,8,30,31,60,61,90,91]) await student(sc, { due: 100, days });
  const b = (await getFeeRecoveryOverview(3)).ageing_buckets;
  assert.deepEqual(Object.values(b).map(x => x.amount), [300,200,200,200,200,100]);
});

test('inactive/deleted structure, inactive mode, withdrawal, waived and zero fees cannot demand payment', async () => {
  const sc = await school(4);
  if (process.env.FEE_RECOVERY_FULL_SCHEMA === 'true') await db`UPDATE schools SET fee_mode='per_section' WHERE id=${sc.id}`;
  const inactiveMode = await db`INSERT INTO fee_structures (school_id,academic_year_id,class_id,section_id,fee_type_id,amount)
    SELECT school_id,academic_year_id,class_id,${sc.section},fee_type_id,amount FROM fee_structures WHERE id=${sc.structure} RETURNING id`;
  if (process.env.FEE_RECOVERY_FULL_SCHEMA === 'true') await db`UPDATE schools SET fee_mode='per_class' WHERE id=${sc.id}`;
  for (const opts of [{active:false},{status:'waived'},{due:0},{structure:inactiveMode[0].id}]) {
    const row = await student(sc,opts); assert.equal((await dispatchFeeReminder(manual(row))).reason,'NO_DUES');
  }
  const row = await student(sc); await db`UPDATE fee_structures SET deleted_at=now() WHERE id=${sc.structure}`;
  assert.equal((await dispatchFeeReminder(manual(row))).reason,'NO_DUES');
  assert.equal((await getFeeRecoveryOverview(sc.id)).summary.total_outstanding,0);
  assert.equal(sends.length,0);
});

test('payment/refund/cancellation ledger triggers immediately change recovery and reminders', async () => {
  const sc = await school(5); const row = await student(sc);
  const payment = await pay(row,400);
  assert.equal((await getFeeRecoveryOverview(sc.id)).summary.total_outstanding,600);
  await pay(row,-400,payment);
  assert.equal((await getFeeRecoveryOverview(sc.id)).summary.total_outstanding,1000);
  await pay(row,1000);
  assert.equal((await getFeeRecoveryOverview(sc.id)).summary.total_outstanding,0);
  assert.equal((await dispatchFeeReminder({...manual(row),amountDue:99999})).reason,'NO_DUES');
  assert.equal(sends.length,0);
});

test('concurrent workers/manual/scheduler and different fee stages have only one provider call', async () => {
  const row = await student(school2);
  const results = await Promise.all(Array.from({length:12},(_,i) => dispatchFeeReminder(i%2
    ? manual(row) : {...manual(row),studentFeeId:row.studentFeeId,stage:'overdue_7d'})));
  assert.equal(results.filter(x=>x.success).length,1);
  assert.equal(sends.length,1);
  assert.equal((await getFeeReminderHistory(2,{studentId:row.studentId})).length,1);
});

test('scanner twice concurrently produces one side effect per student', async () => {
  const sc = await school(6); await student(sc);
  await Promise.all([scanAndDispatchFeeRemindersForSchool(sc.id),scanAndDispatchFeeRemindersForSchool(sc.id)]);
  assert.equal(sends.length,1);
});

test('cross-school student/fee payloads and history IDs cannot resolve or deliver foreign data', async () => {
  const row = await student(school2);
  assert.equal((await dispatchFeeReminder({...manual(row),schoolId:1})).reason,'NO_DUES');
  const own = await student(school1);
  assert.equal((await dispatchFeeReminder({...manual(own),studentFeeId:row.studentFeeId,stage:'overdue_7d'})).reason,'NO_DUES');
  assert.deepEqual(await resolveStudentRecipientUserIds([row.studentId],1),[]);
  assert.equal((await getFeeReminderHistory(1,{studentId:row.studentId})).length,0);
  assert.equal(sends.length,0);
});

test('disabled feature, disabled school and disabled automation suppress scheduled side effects', async () => {
  const sc=await school(7);const row=await student(sc);
  await db`INSERT INTO school_feature_flags (school_id,role,feature_key,enabled)
    VALUES (${sc.id},'student','nav.fees',false)`;
  assert.equal((await dispatchFeeReminder(manual(row))).reason,'FEATURE_DISABLED');
  await db`UPDATE school_feature_flags SET enabled=true WHERE school_id=${sc.id}`;
  await db`UPDATE schools SET is_active=false WHERE id=${sc.id}`;
  assert.equal((await dispatchFeeReminder(manual(row))).reason,'FEATURE_DISABLED');
  await db`UPDATE schools SET is_active=true WHERE id=${sc.id}`;
  await upsertSchoolAutomationRule(sc.id,RULE_KEYS.FEE_DUE_REMINDER,{is_enabled:false});
  assert.equal((await dispatchFeeReminder({...manual(row),studentFeeId:row.studentFeeId,stage:'overdue_7d'})).reason,'RULE_DISABLED');
  assert.equal(sends.length,0);
});

test('no recipient, no token and FCM failure are never reported delivered', async () => {
  const row=await student(school2);await db`UPDATE users SET deleted_at=now() WHERE id=${row.userId}`;
  assert.equal((await dispatchFeeReminder(manual(row))).reason,'NO_RECIPIENTS');
  assert.equal(sends.length,0);
  provider=async()=>({successCount:0,failureCount:0,noTokenCount:1});
  const noToken=await student(school2); assert.equal((await dispatchFeeReminder(manual(noToken))).skipped,true);
  provider=async()=>({successCount:0,failureCount:1});
  const failed=await student(school2); assert.equal((await dispatchFeeReminder(manual(failed))).success,false);
  const [log]=await getFeeReminderHistory(2,{studentId:failed.studentId});assert.equal(log.status,'failed');
});

test('provider success then persistence failure stays visible and cannot be resent', async () => {
  const row=await student(school2);
  await db.unsafe(`CREATE FUNCTION reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RAISE EXCEPTION 'simulated persistence failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_completion BEFORE UPDATE ON automation_execution_logs FOR EACH ROW EXECUTE FUNCTION reject_completion();`);
  try {
    assert.equal((await dispatchFeeReminder(manual(row))).error,'DELIVERY_OUTCOME_UNKNOWN');
    assert.equal((await dispatchFeeReminder(manual(row))).skipped,true);
    assert.equal(sends.length,1);
  } finally { await db.unsafe('DROP TRIGGER reject_completion ON automation_execution_logs; DROP FUNCTION reject_completion()'); }
});

test('payment committed after scan but before dispatch is rechecked; caller amount ignored', async () => {
  const row=await student(school2); await pay(row,600);
  await dispatchFeeReminder({...manual(row),amountDue:1000,studentName:'Spoofed'});
  assert.match(sends[0][2].message,/₹400/); assert.doesNotMatch(sends[0][2].message,/Spoofed/);
});

test('manual future obligation is never called overdue; overpayment is rejected by existing constraint', async () => {
  const row=await student(school2,{days:-30});
  await dispatchFeeReminder(manual(row)); assert.doesNotMatch(sends[0][2].message,/overdue/);
  await assert.rejects(pay(row,1001),/chk_paid_not_exceed/);
});

test('malformed tenant config does not prevent subsequent school processing and surfaces job failure', async () => {
  const sc=await school(8);const healthy=await school(9);await student(healthy);
  await db`UPDATE school_automation_rules SET trigger_config='{"overdue_stages":"bad"}'::jsonb WHERE school_id=${sc.id}`;
  await assert.rejects(runNightlyFeeReminderScan(),/failures/);
  assert.ok(sends.some(args=>args[3].schoolId===healthy.id));
  await db`UPDATE school_automation_rules SET trigger_config='{}'::jsonb WHERE school_id=${sc.id}`;
});

test('pagination and repeat segmentation work with actual SQL', async () => {
  const sc=await school(10);
  for(let i=0;i<6;i++) await student(sc,{days:8});
  const first=await getFeeDefaultersList(sc.id,{page:1,limit:3});const second=await getFeeDefaultersList(sc.id,{page:2,limit:3});
  assert.equal(first.pagination.total,6); assert.equal(first.data.length,3);
  assert.equal(new Set([...first.data,...second.data].map(x=>x.student_id)).size,6);
  assert.ok(first.data.every(x=>x.segmentation==='new'));
});

test('HTTP RBAC matrix, cross-tenant body, preview, validation and business audits', async () => {
  const express=(await import('express')).default; const router=(await import('../routes/feeRecoveryRoutes.js')).default;
  const app=express();app.use(express.json());
  const actors={};
  for(const role of ['admin','accounts','principal','management','parent','student','staff','driver']) {
    const row=await student(school2);actors[role]=row.userId;
    await db`INSERT INTO user_roles (school_id,user_id,role_id) SELECT 2,${row.userId},id FROM roles WHERE school_id=2 AND code=${role}`;
  }
  app.use((req,res,next)=>{const role=req.headers['x-test-role']; if(role) req.user={id:actors[role],internal_id:actors[role],schoolId:2,roles:[role],permissions:['fees.view',...(['admin','accounts','principal','management'].includes(role)&&req.headers['x-test-read-only']!=='true'?['fees.manage']:[])]};req.schoolId=2;next();});
  app.use('/recovery',router);app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/recovery`;
  for(const role of Object.keys(actors)) for(const endpoint of ['overview','defaulters','rules','reminders/history']) {
    const res=await fetch(`${base}/${endpoint}`,{headers:{'x-test-role':role}});
    assert.equal(res.status,['admin','accounts','principal','management'].includes(role)?200:403,`${role} ${endpoint}`);
  }
  const matrixStudent=await student(school2);
  for (const role of Object.keys(actors)) {
    for (const [endpoint, method, body] of [
      ['remind','POST',{student_ids:[matrixStudent.studentId],dry_run:true}],
      ['rules','PUT',{is_enabled:true}],
      ['scan','POST',{dry_run:true}],
    ]) {
      const response=await fetch(`${base}/${endpoint}`,{method,headers:{'x-test-role':role,'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,['admin','accounts','principal','management'].includes(role)?200:403,`${role} ${method} ${endpoint}`);
    }
  }
  const readOnlyHeaders={'x-test-role':'accounts','x-test-read-only':'true','Content-Type':'application/json'};
  assert.equal((await fetch(`${base}/overview`,{headers:readOnlyHeaders})).status,200);
  assert.equal((await fetch(`${base}/rules`,{headers:readOnlyHeaders})).status,403);
  assert.equal((await fetch(`${base}/remind`,{method:'POST',headers:readOnlyHeaders,body:JSON.stringify({student_ids:[matrixStudent.studentId],dry_run:true})})).status,403);
  assert.equal((await fetch(`${base}/overview`)).status,401);
  const post=async(body)=>fetch(`${base}/remind`,{method:'POST',headers:{'x-test-role':'accounts','Content-Type':'application/json'},body:JSON.stringify(body)});
  const row=await student(school2);
  assert.equal((await post({student_ids:[row.studentId],dry_run:true})).status,200);
  assert.equal((await post({student_ids:[row.studentId],dry_run:'false'})).status,400);
  const foreign=await student(school1);assert.equal((await post({student_ids:[foreign.studentId]})).status,404);
  const sent=await post({student_ids:[row.studentId],custom_message:'Thank you'});assert.equal(sent.status,200);assert.equal((await sent.json()).data.dispatched_count,1);
  assert.ok((await db`SELECT id FROM audit_logs WHERE school_id=2 AND action='fee_recovery.reminders.requested'`).length);
});

async function until(check, timeout = 10000) {
  const deadline = Date.now()+timeout;
  while(Date.now()<deadline) { const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,20)); }
  throw new Error('Timed out waiting for database state');
}

test('payment racing after persisted claim wins before worker financial lock', async () => {
  const row=await student(school2);
  const locked=await db.reserve();await locked.unsafe('BEGIN');
  await locked`SELECT id FROM student_fees WHERE id=${row.studentFeeId} FOR UPDATE`;
  const dispatch=dispatchFeeReminder(manual(row));
  try {
    await until(async()=> (await db`SELECT id FROM automation_execution_logs WHERE student_id=${row.studentId}`)[0]);
    await locked`INSERT INTO fee_transactions (school_id,student_fee_id,amount,payment_method,transaction_ref)
      VALUES (2,${row.studentFeeId},1000,'cash',${randomUUID()})`;
    await locked.unsafe('COMMIT');
    assert.equal((await dispatch).reason,'NO_DUES');assert.equal(sends.length,0);
  } finally { await locked.unsafe('ROLLBACK');locked.release(); }
});

test('rule disabled between claim and final check suppresses scheduled notification', async () => {
  const sc=await school(11); const row=await student(sc);
  // A real DB trigger changes mutable state at the committed-claim boundary.
  await db.unsafe(`CREATE FUNCTION disable_claim_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE school_automation_rules SET is_enabled=false WHERE school_id=NEW.school_id; RETURN NEW; END $$;
    CREATE TRIGGER disable_claim_rule AFTER INSERT ON automation_execution_logs FOR EACH ROW EXECUTE FUNCTION disable_claim_rule();`);
  try {
    assert.equal((await dispatchFeeReminder({...manual(row),studentFeeId:row.studentFeeId,stage:'overdue_7d'})).reason,'RULE_DISABLED');
    assert.equal(sends.length,0);
  } finally { await db.unsafe('DROP TRIGGER disable_claim_rule ON automation_execution_logs; DROP FUNCTION disable_claim_rule()'); }
});

test('pre-delivery database failure retries a claim, but completed/no-token claims enforce cooldown', async () => {
  const row=await student(school2);
  await db.unsafe(`CREATE SEQUENCE fail_read_once;
    CREATE FUNCTION fail_read_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('fail_read_once')=1 THEN RAISE EXCEPTION 'temporary DB failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_read_once BEFORE UPDATE ON automation_execution_logs FOR EACH ROW EXECUTE FUNCTION fail_read_once();`);
  // Force a permanent skip before sender so its result write fails once.
  await db`UPDATE users SET deleted_at=now() WHERE id=${row.userId}`;
  try { await assert.rejects(dispatchFeeReminder(manual(row)),/temporary DB failure/); }
  finally { await db.unsafe('DROP TRIGGER fail_read_once ON automation_execution_logs; DROP FUNCTION fail_read_once(); DROP SEQUENCE fail_read_once'); }
  await db`UPDATE users SET deleted_at=NULL WHERE id=${row.userId}`;
  assert.equal((await dispatchFeeReminder(manual(row))).success,true);
  const [log]=await db`SELECT attempt FROM automation_execution_logs WHERE student_id=${row.studentId}`;assert.equal(log.attempt,2);
  const noToken=await student(school2);provider=async()=>({successCount:0,failureCount:0,noTokenCount:1});
  await dispatchFeeReminder(manual(noToken));
  assert.equal((await dispatchFeeReminder({...manual(noToken),studentFeeId:noToken.studentFeeId,stage:'overdue_7d'})).skipped,true);
  assert.equal(sends.length,2);
});

test('malformed cross-tenant parent link does not leak contact details or recipient identity', async () => {
  const own=await student(school1), foreign=await student(school2);
  const [pr]=await db`INSERT INTO parents (school_id,person_id) SELECT 2,person_id FROM students WHERE id=${foreign.studentId} RETURNING id`;
  await db`INSERT INTO student_parents (school_id,student_id,parent_id) VALUES (1,${own.studentId},${pr.id})`;
  const recipients=await resolveStudentRecipientUserIds([own.studentId],1);
  assert.ok(!recipients.includes(foreign.userId));
  const list=await getFeeDefaultersList(1,{search:own.fee.admission_no});
  assert.equal(list.data.find(r=>r.student_id===own.studentId)?.parent_contact,null);
});

test('real pg-boss fee-only startup, singleton schedule, retries and graceful shutdown', async () => {
  const {startTransportJobs,stopTransportJobs,isFeeRecoveryJobsReady}=await import('../services/transportJobService.js');
  const PgBoss=(await import('pg-boss')).default;
  let producer;
  try {
    await startTransportJobs();await startTransportJobs();assert.equal(isFeeRecoveryJobsReady(),true);
    const schedules=await db`SELECT * FROM pgboss.schedule WHERE name='fee-recovery-scan'`;
    assert.equal(schedules.length,1); assert.equal(schedules[0].cron,'0 9 * * *');
    producer=new PgBoss({connectionString:localUrl.toString(),schema:'pgboss'});producer.on('error',()=>{});await producer.start();
    // Existing worker will fail for malformed config, then retry after repair.
    await db`UPDATE school_automation_rules SET trigger_config='{"overdue_stages":"bad"}'::jsonb,is_enabled=true WHERE school_id=11`;
    const job=await producer.send('fee-recovery-scan',{}, {retryLimit:1,retryDelay:2});
    await until(async()=>{const [r]=await db`SELECT state FROM pgboss.job WHERE id=${job}`;return r?.state==='retry';},15000);
    await db`UPDATE school_automation_rules SET trigger_config='{}'::jsonb WHERE school_id=11`;
    await until(async()=>{const [r]=await db`SELECT state FROM pgboss.job WHERE id=${job}`;return r?.state==='completed';},15000);
    const [finished]=await db`SELECT retrycount FROM pgboss.job WHERE id=${job}`;assert.equal(finished.retrycount,1);
  } finally {
    if(producer)await producer.stop({graceful:true,timeout:1000});
    await stopTransportJobs();assert.equal(isFeeRecoveryJobsReady(),false);
  }
});

test('legacy student without active enrollment remains visible without multiplying fee totals', async () => {
  const sc=await school(12),row=await student(sc);
  await db`UPDATE student_enrollments SET deleted_at=now() WHERE student_id=${row.studentId}`;
  const list=await getFeeDefaultersList(sc.id);assert.equal(list.pagination.total,1);assert.equal(list.data[0].class_name,'Unassigned');
  assert.equal((await getFeeRecoveryOverview(sc.id)).class_breakdown[0].outstanding_amount,1000);
});

test('existing Accounts payment function preserves partial payment, adjustment and duplicate-reference semantics', async () => {
  const {postTermFeePayment}=await import('../services/feePaymentService.js');
  const sc=await school(13),row=await student(sc),reference=randomUUID();
  await db.begin(tx=>postTermFeePayment(tx,{student_fee_id:row.studentFeeId,amount:250,payment_method:'cash',transaction_ref:reference,schoolId:sc.id}));
  assert.equal((await getFeeRecoveryOverview(sc.id)).summary.total_outstanding,750);
  await db`UPDATE student_fees SET discount=100 WHERE id=${row.studentFeeId}`;
  assert.equal((await getFeeRecoveryOverview(sc.id)).summary.total_outstanding,650);
  await assert.rejects(db.begin(tx=>postTermFeePayment(tx,{student_fee_id:row.studentFeeId,amount:250,payment_method:'cash',transaction_ref:reference,schoolId:sc.id})),/already exists/);
});

test('1000-student scan is paged and financial reads have bounded output; EXPLAIN history index', async () => {
  const sc=await school(14);
  await db`INSERT INTO persons (school_id,first_name,display_name,gender_id)
    SELECT ${sc.id},'Load', 'Load '||i,1 FROM generate_series(1,1000) i`;
  await db`INSERT INTO students (school_id,person_id,admission_no,admission_date,status_id)
    SELECT ${sc.id},id,substring(id::text,1,25),'2026-04-01',1 FROM persons WHERE school_id=${sc.id}`;
  await db`INSERT INTO student_fees (school_id,student_id,fee_structure_id,amount_due,due_date)
    SELECT ${sc.id},id,${sc.structure},1000,${feeToday()}::date-7 FROM students WHERE school_id=${sc.id}`;
  // Bulk test data bypasses normal autovacuum timing. Refresh planner statistics
  // so this measures the recovery query rather than an intentionally stale plan.
  if (process.env.FEE_RECOVERY_FULL_SCHEMA === 'true') {
    await db.unsafe('ANALYZE student_fees; ANALYZE students; ANALYZE persons; ANALYZE fee_structures');
  }
  const start=performance.now();
  const scan=await scanAndDispatchFeeRemindersForSchool(sc.id,{dryRun:true});
  const list=await getFeeDefaultersList(sc.id,{page:2,limit:50});
  const overview=await getFeeRecoveryOverview(sc.id);
  assert.equal(scan.eligibleCount,1000);assert.equal(list.data.length,50);assert.equal(list.pagination.total,1000);
  assert.equal(overview.summary.total_outstanding,1000000);
  assert.equal(sends.length,0);
  const [plan]=await db`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM automation_execution_logs
    WHERE school_id=14 AND student_id=${randomUUID()} AND rule_key='fee_due_reminder' ORDER BY created_at DESC LIMIT 20`;
  console.log(JSON.stringify({performance_sanity:{students:1000,scan_and_reads_ms:Math.round(performance.now()-start),history_plan:plan['QUERY PLAN'][0].Plan['Node Type'],history_execution_ms:plan['QUERY PLAN'][0]['Execution Time']}}));
});

test('upgrade backfills tenant-owned legacy history, preserves defaults and keeps out-of-range page totals', async () => {
  const row=await student(school1);
  await db`INSERT INTO automation_execution_logs (school_id,rule_key,entity_type,entity_id,idempotency_key,status,payload)
    VALUES (1,'fee_due_reminder','student_fee',${row.studentFeeId},'legacy-test','completed',${db.json({studentId:row.studentId})})`;
  await applyBatch1Migrations(db);
  const [log]=await db`SELECT student_id FROM automation_execution_logs WHERE idempotency_key='legacy-test'`;
  assert.equal(log.student_id,row.studentId);
  const {getSchoolAutomationRule}=await import('../services/automationRuleService.js');
  assert.equal((await getSchoolAutomationRule(999,'fee_due_reminder')).is_enabled,false);
  const list=await getFeeDefaultersList(14,{page:100,limit:50});assert.equal(list.data.length,0);assert.equal(list.pagination.total,1000);
});

test('corrupt NaN fee cannot become a notification or a misleading null financial metric', async () => {
  const sc=await school(15),row=await student(sc,{due:'NaN'});
  await assert.rejects(getFeeRecoveryOverview(sc.id),/invalid amounts/);
  await assert.rejects(getFeeDefaultersList(sc.id),/invalid amounts/);
  await assert.rejects(dispatchFeeReminder(manual(row)),/invalid amounts/);
  const scan=await scanAndDispatchFeeRemindersForSchool(sc.id);assert.equal(scan.errorCount,1);
  assert.equal(sends.length,0);
});
