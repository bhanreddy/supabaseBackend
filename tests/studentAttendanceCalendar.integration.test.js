import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import postgres from 'postgres';
import express from 'express';

const url = process.env.ATTENDANCE_TEST_DATABASE_URL;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Explicitly opt-in, dedicated scratch database only. Never use DATABASE_URL.
test('attendance calendar SQL migration, reports, finalization, authorization and invalidation', { skip: !url }, async t => {
  const parsed = new URL(url);
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname.endsWith('_attendance_test'), 'Use a dedicated local *_attendance_test database.');
  const db = postgres(url, { ssl: false, max: 3, prepare: false, onnotice: () => {} });
  try {
    await db.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE schools(id integer PRIMARY KEY, name text, timetable_mode text DEFAULT 'uniform');
      CREATE TABLE persons(id uuid PRIMARY KEY, display_name text);
      CREATE TABLE users(id uuid PRIMARY KEY, school_id integer, person_id uuid, deleted_at timestamptz);
      CREATE TABLE students(id uuid PRIMARY KEY, school_id integer, person_id uuid, admission_no text, deleted_at timestamptz, admission_date date DEFAULT '2026-06-01', exit_date date);
      CREATE TABLE parents(id uuid PRIMARY KEY, school_id integer, person_id uuid, deleted_at timestamptz);
      CREATE TABLE student_parents(student_id uuid, parent_id uuid, is_primary_contact boolean DEFAULT true, created_at timestamptz DEFAULT now(), deleted_at timestamptz);
      CREATE TABLE academic_years(id uuid PRIMARY KEY, school_id integer, code text, start_date date, end_date date, deleted_at timestamptz);
      CREATE TABLE classes(id uuid PRIMARY KEY, school_id integer, name text);
      CREATE TABLE sections(id uuid PRIMARY KEY, name text);
      CREATE TABLE class_sections(id uuid PRIMARY KEY, school_id integer, class_id uuid, section_id uuid, deleted_at timestamptz);
      CREATE TABLE student_enrollments(id uuid PRIMARY KEY, school_id integer, student_id uuid, academic_year_id uuid, class_section_id uuid, start_date date, end_date date, status text DEFAULT 'active', deleted_at timestamptz);
      CREATE TYPE attendance_status_enum AS ENUM ('present','absent','late','half_day','holiday');
      CREATE TABLE daily_attendance(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, student_enrollment_id uuid, attendance_date date,
        status attendance_status_enum, morning_status attendance_status_enum, afternoon_status attendance_status_enum, marked_by uuid, marked_at timestamptz DEFAULT now(), remarks text, updated_at timestamptz DEFAULT now(), deleted_at timestamptz);
      CREATE TABLE school_settings(school_id integer, key text, value text, updated_at timestamptz DEFAULT now(), PRIMARY KEY(school_id,key));
      CREATE TABLE academic_terms(id uuid PRIMARY KEY,school_id integer,name text);
      CREATE TABLE calendar_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, academic_year_id uuid, academic_term_id uuid, approved_by uuid, reminder_schedules jsonb, title text, title_te text, description text, description_te text,
        source_module text DEFAULT 'MANUAL', source_entity_id text, event_type text, start_date date, end_date date, start_datetime timestamptz, end_datetime timestamptz, is_all_day boolean DEFAULT true, location text, status text DEFAULT 'PUBLISHED', priority text DEFAULT 'NORMAL',
        attendance_enabled boolean, timetable_enabled boolean, copy_timetable_from_day text, holiday_type text, recurrence_rule jsonb, recurrence_parent_id uuid, attachments jsonb DEFAULT '[]', created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), published_at timestamptz, deleted_at timestamptz);
      CREATE TABLE calendar_event_targets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, event_id uuid, target_type text, target_id text,UNIQUE(event_id,target_type,target_id));
      CREATE TABLE calendar_event_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id integer,event_id uuid,changed_by uuid,change_type text,old_value jsonb,new_value jsonb,change_summary text,created_at timestamptz DEFAULT now());
      CREATE TABLE calendar_event_reminders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id integer,event_id uuid,remind_at timestamptz,status text DEFAULT 'PENDING',UNIQUE(event_id,remind_at));
      CREATE TABLE audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, user_id uuid, action text, entity text, entity_id text, details jsonb, created_at timestamptz DEFAULT now());
      CREATE TABLE notification_preferences(school_id integer, user_id uuid, event_type text, channel text, is_enabled boolean, deleted_at timestamptz);
      CREATE TABLE subjects(id uuid PRIMARY KEY, school_id integer, name text, name_te text);
      CREATE TABLE exams(id uuid PRIMARY KEY, school_id integer, academic_year_id uuid, name text, name_te text, timetable_published boolean DEFAULT false, status text DEFAULT 'scheduled', deleted_at timestamptz);
      CREATE TABLE exam_subjects(id uuid PRIMARY KEY, school_id integer, exam_id uuid, subject_id uuid, class_id uuid, class_section_id uuid, exam_date date, start_time time, end_time time, deleted_at timestamptz);
      CREATE TABLE events(id uuid PRIMARY KEY, school_id integer, title text, title_te text, description text, description_te text, start_date date, end_date date, start_time time, end_time time, is_all_day boolean DEFAULT true, is_public boolean DEFAULT true, location text, status text DEFAULT 'DRAFT', deleted_at timestamptz);
      CREATE TABLE event_audience_targets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, event_id uuid, target_type text, target_id text);
      INSERT INTO schools(id,name) VALUES(1,'School One'),(2,'School Two');
      INSERT INTO persons VALUES('${id(1)}','Student One'),('${id(2)}','Student Two'),('${id(3)}','Parent One'),('${id(4)}','Parent Two'),('${id(5)}','School Operator');
      INSERT INTO users VALUES('${id(41)}',1,'${id(3)}',NULL),('${id(42)}',1,'${id(4)}',NULL),('${id(43)}',1,'${id(5)}',NULL);
      INSERT INTO students(id,school_id,person_id,admission_no,deleted_at) VALUES('${id(21)}',1,'${id(1)}','A001',NULL),('${id(22)}',1,'${id(2)}','A002',NULL);
      INSERT INTO parents VALUES('${id(51)}',1,'${id(3)}',NULL),('${id(52)}',1,'${id(4)}',NULL);
      INSERT INTO student_parents(student_id,parent_id) VALUES('${id(21)}','${id(51)}'),('${id(22)}','${id(52)}');
      INSERT INTO academic_years VALUES('${id(61)}',1,'2026–27','2026-06-01','2027-04-30',NULL);
      INSERT INTO classes VALUES('${id(71)}',1,'Class 5'),('${id(72)}',1,'Class 6');
      INSERT INTO sections VALUES('${id(81)}','A');
      INSERT INTO class_sections VALUES('${id(11)}',1,'${id(71)}','${id(81)}',NULL),('${id(12)}',1,'${id(72)}','${id(81)}',NULL);
      INSERT INTO student_enrollments(id,school_id,student_id,academic_year_id,class_section_id,start_date) VALUES('${id(31)}',1,'${id(21)}','${id(61)}','${id(11)}','2026-06-01'),('${id(32)}',1,'${id(22)}','${id(61)}','${id(12)}','2026-06-01');
      INSERT INTO school_settings VALUES(1,'attendance_calendar_v2_enabled','true',now()),(1,'school_timezone','Asia/Kolkata',now());`);
    mock.module('../db.js', { defaultExport: db });
    mock.module('../services/notificationService.js', { namedExports: { sendNotificationToUsers: async () => ({ successCount: 1 }) } });
    mock.module('../utils/logger.js', { defaultExport: { info() {}, warn() {}, error() {} } });
    const service = await import('../services/studentAttendanceCalendarService.js');
    const access = await import('../utils/studentPortal.js');
    const { resolveSchoolDay } = await import('../services/workingDayResolver.js');
    const { assertAttendanceCalendarPublication } = await import('../services/attendanceCalendarPublication.js');
    const { expandRecurrenceOccurrences, CalendarService } = await import('../services/calendarService.js');
    const alerts = await import('../services/attendanceCalendarAlerts.js');
    const input = { schoolId: 1, studentId: id(21), userId: id(41), academicYearId: id(61), from: '2026-10-05', to: '2026-10-09', report: true };

    await t.test('unmigrated database: dashboard calendar and legacy writes work without new tables or columns',async()=>{
      for(const enabled of ['false','true']){
        await db`UPDATE school_settings SET value=${enabled} WHERE school_id=1 AND key='attendance_calendar_v2_enabled'`;
        const caps=await service.calendarCapabilities(1,db);
        assert.equal(caps.schema_ready,false); assert.equal(caps.enabled,false,'a stale feature flag cannot enable missing storage');
        assert.deepEqual(await service.loadAttendancePolicies(1,db),[]);
        await assert.rejects(service.saveAttendancePolicy(1,id(43),{},db),{status:409,code:'ATTENDANCE_CALENDAR_MIGRATION_REQUIRED'});
        const event=await CalendarService.createEvent({schoolId:1,userId:id(43),data:{title:'Legacy school holiday',event_type:'HOLIDAY',start_date:'2026-11-16',end_date:'2026-11-16',is_all_day:true,attendance_enabled:false,notify:false,reminder_schedules:[]}});
        const events=await CalendarService.getEventsForUser({schoolId:1,user:{roles:['admin']},startDate:'2026-11-01',endDate:'2026-11-30'});
        const visible=events.find(e=>e.id===event.id); assert.ok(visible); assert.deepEqual(visible.override_event_ids,[]); assert.equal(visible.override_reason,null);
        assert.ok(Array.isArray(await CalendarService.getUpcomingEvents({schoolId:1,user:{roles:['admin']},limit:5})));
        const updated=await CalendarService.updateEvent({schoolId:1,userId:id(43),eventId:event.id,data:{title:'Legacy holiday edited'}});
        assert.equal(updated.title,'Legacy holiday edited');
        assert.equal((await resolveSchoolDay(1,'2026-11-16',db)).isHoliday,true);
        assert.equal(await alerts.enqueueAttendanceCalendarAlert(db,1,updated,'PUBLISHED'),false);
        assert.equal(await alerts.processAttendanceCalendarAlerts({db,notify:()=>{throw new Error('Do not send');},resolveTargets:async()=>[]}),0);
        await assert.rejects(CalendarService.updateEvent({schoolId:1,userId:id(43),eventId:event.id,data:{override_event_ids:[id(999)],override_reason:'New feature'}}),{status:409,code:'ATTENDANCE_CALENDAR_MIGRATION_REQUIRED'});
        await db`DELETE FROM calendar_event_targets WHERE event_id=${event.id}`;
        await db`DELETE FROM calendar_event_history WHERE event_id=${event.id}`;
        await db`DELETE FROM calendar_events WHERE id=${event.id}`;
      }
    });
    const migration = await fs.readFile(new URL('../migrations/20261115_student_attendance_calendar.sql', import.meta.url), 'utf8');
    for (let i = 0; i < 2; i++) await db.begin(tx => tx.unsafe(migration.replace(/^BEGIN;|^COMMIT;/gm, '')));

    await t.test('migration is idempotent and RLS hides tables from direct parent access', async () => {
      const [row] = await db`SELECT relrowsecurity FROM pg_class WHERE relname = 'attendance_report_finalizations'`;
      assert.equal(row.relrowsecurity, true);
      const [grant] = await db`SELECT has_table_privilege('authenticated','attendance_report_finalizations','SELECT') AS allowed`;
      assert.equal(grant.allowed, false);
    });
    await t.test('QA-18: parent can read only a linked child, including cross-school requests', async () => {
      const req = { schoolId: 1, user: { id: id(41), roles: ['parent'], schoolId: 1 } };
      assert.equal(await access.canAccessStudentData(req, id(21)), true);
      assert.equal(await access.canAccessStudentData(req, id(22)), false);
      assert.equal(await access.canAccessStudentData({ ...req, schoolId: 2, user: { ...req.user, schoolId: 2 } }, id(21)), false);
    });
    await t.test('range validation and rollout enforce server-side limits', async () => {
      await assert.rejects(service.loadStudentAttendanceCalendar({ ...input, from: '2026-05-01' }, db), /academic year/);
      await assert.rejects(service.loadStudentAttendanceCalendar({ ...input, to: '2027-04-30' }, db), /today/);
      const disabled = await service.calendarCapabilities(2, db); assert.equal(disabled.enabled, false);
    });
    await t.test('actual SQL reads calculate weighted summaries and privacy metadata', async () => {
      for (const [day, status] of [['05','present'],['06','absent'],['07','half_day'],['08','late'],['09','present']]) await db`
        INSERT INTO daily_attendance(school_id,student_enrollment_id,attendance_date,status,marked_by,remarks)
        VALUES(1,${id(31)},${`2026-10-${day}`},${status},${id(43)},'private remark')`;
      const result = await service.loadStudentAttendanceCalendar(input, db);
      assert.equal(result.summary.attendance_percentage, 70); assert.equal(result.summary.marked_days, 5);
      assert.equal(result.days[0].attendance.teacher_name, undefined); assert.equal(JSON.stringify(result).includes('private remark'), false);
    });
    await t.test('source synchronization: published timetable overrides, events lifecycle, academic holidays and stale-copy deduplication', async () => {
      await db`INSERT INTO subjects VALUES(${id(901)},1,'Mathematics','గణితం')`;
      await db`INSERT INTO exams(id,school_id,academic_year_id,name,timetable_published) VALUES(${id(902)},1,${id(61)},'Term exam',true)`;
      await db`INSERT INTO exam_subjects(id,school_id,exam_id,subject_id,class_id,exam_date,start_time,end_time) VALUES(${id(903)},1,${id(902)},${id(901)},${id(71)},'2026-10-05','09:00','10:00')`;
      await db`INSERT INTO exam_subjects(id,school_id,exam_id,subject_id,class_id,class_section_id,exam_date,start_time,end_time) VALUES(${id(904)},1,${id(902)},${id(901)},${id(71)},${id(11)},'2026-10-06','10:00','11:00')`;
      await db`INSERT INTO calendar_events(id,school_id,title,event_type,start_date,end_date,source_module,source_entity_id) VALUES(${id(905)},1,'Stale exam copy','EXAM','2026-10-05','2026-10-05','EXAM',${id(903)})`;
      await db`INSERT INTO events(id,school_id,title,start_date,end_date,status,location) VALUES(${id(906)},1,'Sports day','2026-10-07','2026-10-07','PUBLISHED','Ground')`;
      await db`INSERT INTO event_audience_targets(school_id,event_id,target_type,target_id) VALUES(1,${id(906)},'SECTION',${id(11)})`;
      await db`INSERT INTO events(id,school_id,title,start_date,status) VALUES(${id(907)},1,'Unpublished surprise','2026-10-07','DRAFT')`;
      let result = await service.loadStudentAttendanceCalendar(input, db);
      const activities = result.days.flatMap(d => d.events);
      assert.equal(activities.filter(e => e.source_module === 'EXAM').length,1);
      const paper = activities.find(e => e.source_module === 'EXAM');
      assert.equal(paper.start_date,'2026-10-06'); assert.equal(paper.start_datetime,'2026-10-06T04:30:00.000Z');
      assert.equal(activities.some(e => e.title === 'Stale exam copy' || e.title === 'Unpublished surprise'),false);
      assert.equal(activities.find(e => e.source_module === 'EVENTS').location,'Ground');
      assert.equal((await service.loadStudentAttendanceCalendar({...input,studentId:id(22)},db)).days.flatMap(d => d.events).length,0);
      await service.finalizeAttendanceReport(input,id(43),'Source calendars reviewed',result.snapshot_hash,db);
      await db`UPDATE events SET start_date='2026-10-08',end_date='2026-10-08',location='Hall' WHERE id=${id(906)}`;
      await db`UPDATE exam_subjects SET exam_date='2026-10-09' WHERE id=${id(904)}`;
      result = await service.loadStudentAttendanceCalendar(input,db);
      assert.equal(result.summary.report_status,'PROVISIONAL','source calendar edits reopen finalized snapshots');
      assert.equal(result.days.find(d => d.date==='2026-10-08').events[0].location,'Hall');
      assert.equal(result.days.find(d => d.date==='2026-10-09').events[0].source_entity_id,id(904));
      await service.finalizeAttendanceReport(input,id(43),'Changed sources reviewed',result.snapshot_hash,db);
      await db`UPDATE exams SET timetable_published=false WHERE id=${id(902)}`;
      await db`UPDATE events SET status='CANCELLED' WHERE id=${id(906)}`;
      const unpublished = await service.loadStudentAttendanceCalendar(input,db);
      assert.equal(unpublished.days.flatMap(d => d.events).length,0);
      assert.equal(unpublished.summary.report_status,'PROVISIONAL');
    });
    await t.test('finalization rejects stale snapshots, persists coverage, and corrections reopen it with audit', async () => {
      const result = await service.loadStudentAttendanceCalendar(input, db);
      await assert.rejects(service.finalizeAttendanceReport(input, id(43), 'Reviewed', 'stale', db), /changed/);
      await service.finalizeAttendanceReport(input, id(43), 'Reviewed with class teacher', result.snapshot_hash, db);
      assert.equal((await service.loadStudentAttendanceCalendar(input, db)).summary.report_status, 'FINALIZED');
      await db`UPDATE daily_attendance SET status = 'present', correction_reason = 'Register verified', marked_by = ${id(43)} WHERE student_enrollment_id = ${id(31)} AND attendance_date = '2026-10-06'`;
      assert.equal((await service.loadStudentAttendanceCalendar(input, db)).summary.report_status, 'PROVISIONAL');
      const rows = await db`SELECT * FROM audit_logs WHERE entity = 'daily_attendance' AND action = 'UPDATE'`;
      assert.equal(rows[0].details.reason, 'Register verified'); assert.equal(rows[0].details.old.status, 'absent'); assert.equal(rows[0].details.new.status, 'present');
    });
    await t.test('scoped holidays agree in parent reports and teacher/timetable resolver', async () => {
      await db`INSERT INTO calendar_events(id,school_id,title,event_type,start_date,end_date,holiday_type) VALUES(${id(91)},1,'Class 6 closure','HOLIDAY','2026-10-05','2026-10-05','LOCAL_HOLIDAY')`;
      await db`INSERT INTO calendar_event_targets(school_id,event_id,target_type,target_id) VALUES(1,${id(91)},'CLASS',${id(72)})`;
      assert.equal((await service.loadStudentAttendanceCalendar(input, db)).days[0].is_attendance_expected, true);
      assert.equal((await resolveSchoolDay(1, '2026-10-05', db, { classSectionId: id(11) })).attendanceAllowed, true);
      assert.equal((await resolveSchoolDay(1, '2026-10-05', db, { classSectionId: id(12) })).attendanceAllowed, false);
      assert.equal((await resolveSchoolDay(1, '2026-10-05', db)).attendanceAllowed, true);
    });
    await t.test('publication blocks conflicting working days until explicit audited override', async () => {
      const [special] = await db`INSERT INTO calendar_events(school_id,title,event_type,start_date,end_date)
        VALUES(1,'Compensatory day','SPECIAL_WORKING_DAY','2026-10-05','2026-10-05') RETURNING *`;
      await db`INSERT INTO calendar_event_targets(school_id,event_id,target_type,target_id) VALUES(1,${special.id},'CLASS',${id(72)})`;
      await assert.rejects(db.begin(tx => assertAttendanceCalendarPublication(tx, 1, special, expandRecurrenceOccurrences)), /conflict/);
      const [updated] = await db`UPDATE calendar_events SET override_event_ids = ARRAY[${id(91)}::uuid], override_reason = 'Approved replacement day' WHERE id = ${special.id} RETURNING *`;
      await db.begin(tx => assertAttendanceCalendarPublication(tx, 1, updated, expandRecurrenceOccurrences));
    });
    await t.test('effective policy changes reopen finalized reports and are auditable', async () => {
      const result = await service.loadStudentAttendanceCalendar(input, db);
      await service.finalizeAttendanceReport(input, id(43), 'Rechecked', result.snapshot_hash, db);
      await service.saveAttendancePolicy(1, id(43), { ...service.DEFAULT_ATTENDANCE_POLICY, effective_from: '2026-10-01', half_day_weight: 0.25, reason: 'Approved term policy' }, db);
      const changed = await service.loadStudentAttendanceCalendar(input, db);
      assert.equal(changed.summary.report_status, 'PROVISIONAL'); assert.equal(changed.summary.attendance_percentage, 85);
    });
    await t.test('concurrent teacher writes cannot finalize a stale snapshot', async () => {
      const result = await service.loadStudentAttendanceCalendar(input, db);
      let started, release;
      const entered = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const writer = db.begin(async tx => {
        await tx`UPDATE daily_attendance SET status = 'absent', correction_reason = 'Concurrent correction' WHERE student_enrollment_id = ${id(31)} AND attendance_date = '2026-10-05'`;
        started(); await gate;
      });
      await entered;
      const finalizer = service.finalizeAttendanceReport(input, id(43), 'Review', result.snapshot_hash, db);
      release(); await writer;
      await assert.rejects(finalizer, /changed/);
    });
    await t.test('alerts are durable, deduplicated, and honor parent opt-outs', async () => {
      const [exam] = await db`INSERT INTO calendar_events(school_id,title,event_type,start_date,end_date)
        VALUES(1,'Math exam','EXAM','2026-11-18','2026-11-18') RETURNING *`;
      await db`INSERT INTO calendar_event_targets(school_id,event_id,target_type,target_id) VALUES(1,${exam.id},'ENTIRE_SCHOOL','ALL')`;
      await db.begin(async tx => { await alerts.enqueueAttendanceCalendarAlert(tx, 1, exam, 'PUBLISHED'); await alerts.enqueueAttendanceCalendarAlert(tx, 1, exam, 'PUBLISHED'); });
      assert.equal(Number((await db`SELECT count(*) AS count FROM attendance_calendar_alerts WHERE event_id = ${exam.id}`)[0].count), 1);
      await db`INSERT INTO notification_preferences(school_id,user_id,event_type,channel,is_enabled) VALUES(1,${id(42)},'CALENDAR_EVENT_PUBLISHED','PUSH',false)`;
      const delivered = [];
      const options = { db, resolveTargets: async () => [id(41), id(42)], notify: async (...args) => delivered.push(args) };
      await alerts.processAttendanceCalendarAlerts(options); await alerts.processAttendanceCalendarAlerts(options);
      assert.equal(delivered.length, 1); assert.deepEqual(delivered[0][0], [id(41)]);
      assert.match(delivered[0][3].idempotencyKey, /^calendar:/);
      const [old] = await db`SELECT * FROM calendar_events WHERE id = ${exam.id}`;
      const [moved] = await db`UPDATE calendar_events SET start_date='2026-11-19',end_date='2026-11-19',updated_at=now() WHERE id=${exam.id} RETURNING *`;
      await alerts.enqueueAttendanceCalendarAlert(db,1,moved,'UPDATED',old);
      const [latest] = await db`UPDATE calendar_events SET start_date='2026-11-20',end_date='2026-11-20',updated_at=now() WHERE id=${exam.id} RETURNING *`;
      await alerts.enqueueAttendanceCalendarAlert(db,1,latest,'UPDATED',moved);
      await alerts.processAttendanceCalendarAlerts(options);
      assert.equal(delivered.length,2); assert.match(delivered[1][2].message,/2026-11-20/);
      const [cancelled] = await db`UPDATE calendar_events SET status='CANCELLED',updated_at=now() WHERE id=${exam.id} RETURNING *`;
      await alerts.enqueueAttendanceCalendarAlert(db,1,cancelled,'CANCELLED',latest);
      await db`UPDATE calendar_events SET status='PUBLISHED' WHERE id=${exam.id}`;
      await alerts.processAttendanceCalendarAlerts(options);
      assert.equal(delivered.length,2,'republishing suppresses a queued obsolete cancellation');
    });
    await t.test('HTTP APIs enforce student scope, finalization permissions and validation', async t => {
      const authenticate = (req, _res, next) => {
        req.schoolId = Number(req.headers['x-test-school'] || 1);
        const admin = req.headers['x-test-role'] === 'admin';
        req.user = { id: id(admin ? 43 : 41), internal_id: id(admin ? 43 : 41), person_id: id(admin ? 5 : 3),
          roles: [admin ? 'admin' : 'parent'], permissions: admin ? ['attendance.edit','attendance.view','events.manage'] : [], schoolId: req.schoolId };
        next();
      };
      mock.module('../middleware/auth.js', { namedExports: {
        requireAuth: authenticate,
        requirePermission: () => [authenticate, (req,res,next) => req.user.roles.includes('admin') ? next() : res.status(403).json({error:'Forbidden'})],
      } });
      mock.module('../services/staffAttendanceV2Service.js', { namedExports: { recordAdminAttendanceBatch: async () => {} } });
      mock.module('../services/attendanceRiskService.js', { namedExports: { getAttendanceRiskInsights: async () => [], updateStudentIntervention: async () => {} } });
      mock.module('../services/attendanceStreakService.js', { namedExports: { enrichStudentsWithStreaks: async (_schoolId,students) => students } });
      mock.module('../services/automationEventService.js', { namedExports: { emitSchoolEvent() {}, AUTOMATION_EVENTS: { STUDENT_ATTENDANCE_RISK_CHANGED: 'attendance.changed' } } });
      mock.module('../services/attendanceNotificationService.js', { namedExports: { shouldSendAttendanceNotification: async () => false } });
      const { default: router } = await import('../routes/studentAttendanceCalendarRoutes.js');
      const { default: legacy } = await import('../routes/studentAttendanceLegacyRoutes.js');
      const { default: marking } = await import('../routes/attendanceRoutes.js');
      const { default: calendar } = await import('../routes/calendarRoutes.js');
      const app = express(); app.use(express.json()); app.use('/students/:id/attendance', router);
      app.use('/students/:id/attendance', legacy); app.use('/attendance', marking); app.use('/calendar',calendar);
      app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
      const server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
      try {
        const base = `http://127.0.0.1:${server.address().port}/students`;
        const suffix = `attendance/report?academic_year_id=${id(61)}&from_date=2026-10-05&to_date=2026-10-09`;
        const allowed = await fetch(`${base}/${id(21)}/${suffix}`); assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('cache-control'),'private, no-store'); assert.equal((await allowed.json()).school_id, 1);
        assert.equal((await fetch(`${base}/${id(22)}/${suffix}`)).status, 403);
        assert.equal((await fetch(`${base}/${id(21)}/${suffix}`, { headers: { 'x-test-school': '2' } })).status, 403);
        assert.equal((await fetch(`${base}/${id(21)}/attendance/finalize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
        assert.equal((await fetch(`${base}/${id(21)}/attendance/calendar?month=not-a-month`)).status, 400);
        assert.equal((await fetch(`${base}/${id(21)}/attendance/report?from_date=2026-10-09&to_date=2026-10-05`)).status, 400);
        const root = base.replace(/\/students$/,'');
        const headers = { 'Content-Type':'application/json', 'x-test-role':'admin' };
        await t.test('previous frontend keeps history, pagination, empty months and cross-year ranges with rollout off/on', async () => {
          for (const flag of ['false','true']) {
            await db`UPDATE school_settings SET value=${flag} WHERE school_id=1 AND key='attendance_calendar_v2_enabled'`;
            for (const range of ['', '?from_date=2026-10-01&to_date=2026-10-31', '?from_date=2020-01-01&to_date=2028-12-31']) {
              const response = await fetch(`${base}/me/attendance${range}`);
              assert.equal(response.status,200); const result = await response.json();
              assert.equal(result.success,true); assert.equal(result.school_id,1);
              assert.deepEqual(Object.keys(result.data).sort(),['records','summary']);
              assert.ok(Array.isArray(result.data.records));
              assert.deepEqual(Object.keys(result.data.summary).sort(),['absent','attendance_percentage','effective_absent','effective_present','half_day','late','present','total']);
              assert.ok(result.data.records.every(r => ['present','absent','late','half_day','holiday'].includes(r.status)));
            }
            const paging = await (await fetch(`${base}/${id(21)}/attendance?from_date=2026-10-01&to_date=2026-10-31&page=2&limit=2`)).json();
            assert.equal(paging.data.records.length,2); assert.equal(paging.data.meta.page,2); assert.equal(paging.data.meta.limit,2);
            assert.equal(paging.data.meta.total,5); assert.equal(paging.data.summary.total,5);
            const empty = await fetch(`${base}/${id(21)}/attendance?from_date=2020-01-01&to_date=2020-01-31`);
            assert.equal(empty.status,200); const noData=(await empty.json()).data;
            assert.deepEqual(noData.records,[]); assert.equal(noData.summary.total,0); assert.equal(noData.summary.attendance_percentage,null);
            assert.equal((await fetch(`${base}/${id(22)}/attendance`)).status,403);
          }
        });
        await t.test('previous frontend correction body needs no new fields; audit and new strict correction API coexist', async () => {
          const sqlBody = await fs.readFile(new URL('../migrations/20260719_morning_only_attendance_present.sql',import.meta.url),'utf8');
          await db.unsafe(sqlBody.slice(0,sqlBody.indexOf('-- Correct rows')));
          await db.unsafe('CREATE TRIGGER attendance_session_rollup BEFORE INSERT OR UPDATE ON daily_attendance FOR EACH ROW EXECUTE FUNCTION compute_attendance_day_status()');
          const [record] = await db`SELECT id FROM daily_attendance WHERE student_enrollment_id=${id(31)} AND attendance_date='2026-10-05'`;
          const path = `${root}/attendance/${record.id}`;
          for (const flag of ['false','true']) {
            await db`UPDATE school_settings SET value=${flag} WHERE school_id=1 AND key='attendance_calendar_v2_enabled'`;
            const response=await fetch(path,{method:'PUT',headers,body:JSON.stringify({status:'half_day'})});
            assert.equal(response.status,200); const result=await response.json();
            assert.equal(result.data.message,'Attendance updated'); assert.equal(result.data.attendance.status,'half_day');
            assert.equal(result.data.attendance.morning_status,'present'); assert.equal(result.data.attendance.afternoon_status,'absent');
            assert.match(result.data.attendance.correction_reason,/Legacy client/);
          }
          assert.equal((await fetch(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"status":"present"}'})).status,403);
          assert.equal((await fetch(path,{method:'PUT',headers:{...headers,'x-test-school':'2'},body:'{"status":"present"}'})).status,404);
          assert.equal((await fetch(`${path}/correction`,{method:'PUT',headers,body:'{"status":"present"}'})).status,400);
          const corrected=await fetch(`${path}/correction`,{method:'PUT',headers,body:'{"status":"present","reason":"Register verified"}'});
          assert.equal(corrected.status,200); assert.equal((await corrected.json()).data.attendance.correction_reason,'Register verified');
          const [audit] = await db`SELECT user_id,details FROM audit_logs WHERE entity='daily_attendance' AND entity_id=${String(record.id)} AND details->>'reason'='Legacy client correction; no reason supplied' LIMIT 1`;
          assert.equal(audit.user_id,id(43)); assert.equal(audit.details.reason,'Legacy client correction; no reason supplied');
        });
        await t.test('previous teacher records payload preserves sessions, retries and clear-day behavior',async()=>{
          await db.unsafe('ALTER TABLE students ADD COLUMN status_id integer DEFAULT 1; CREATE UNIQUE INDEX attendance_session_unique ON daily_attendance(student_enrollment_id,attendance_date) WHERE deleted_at IS NULL');
          const path=`${root}/attendance`;
          const payload={class_section_id:id(11),date:'2026-09-21',session:'morning',records:[{student_id:id(21),status:'present'}]};
          let response=await fetch(path,{method:'POST',headers,body:JSON.stringify(payload)});
          assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
          assert.equal((await response.json()).data.count,1);
          response=await fetch(path,{method:'POST',headers,body:JSON.stringify({...payload,session:'afternoon',records:[{student_id:id(21),status:'absent'}]})});
          assert.equal(response.status,201); assert.equal((await response.json()).data.records[0].status,'half_day');
          response=await fetch(path,{method:'POST',headers,body:JSON.stringify(payload)});
          assert.equal(response.status,201); assert.equal((await response.json()).data.count,1);
          response=await fetch(path,{method:'POST',headers,body:JSON.stringify({...payload,records:undefined,attendance:payload.records})});
          assert.equal(response.status,201); assert.equal((await response.json()).data.count,1);
          const [record]=await db`SELECT morning_status,afternoon_status,status FROM daily_attendance WHERE attendance_date='2026-09-21' AND student_enrollment_id=${id(31)} AND deleted_at IS NULL`;
          assert.deepEqual(record,{morning_status:'present',afternoon_status:'absent',status:'half_day'});
          const cleared=await fetch(`${path}/day?class_section_id=${id(11)}&date=2026-09-21`,{method:'DELETE',headers});
          assert.equal(cleared.status,200); assert.equal((await cleared.json()).data.count,1);
        });
        await t.test('previous calendar requests retain arrays, month/date aliases and legacy display fields',async()=>{
          await db`INSERT INTO calendar_events(id,school_id,title,event_type,start_date,end_date,start_datetime,end_datetime,is_all_day,attendance_enabled,timetable_enabled,source_entity_id)
            VALUES(${id(970)},1,'Legacy calendar event','SCHOOL_EVENT','2026-08-12','2026-08-12','2026-08-12T04:00:00Z','2026-08-12T05:00:00Z',false,true,true,'legacy-source')`;
          for(const query of ['month=2026-08','year=2026&month=8','startDate=2026-08-01&endDate=2026-08-31','start_date=2026-08-01&end_date=2026-08-31']){
            const response=await fetch(`${root}/calendar?${query}`,{headers});
            assert.equal(response.status,200); const data=(await response.json()).data;
            assert.ok(Array.isArray(data)); const event=data.find(e=>e.id===id(970)); assert.ok(event);
            assert.equal(event.start_time,'09:30'); assert.equal(event.end_time,'10:30'); assert.equal(event.all_day,false);
            assert.equal(event.affects_attendance,false); assert.equal(event.affects_timetable,false); assert.equal(event.source_id,'legacy-source');
          }
          const status=await fetch(`${root}/calendar/day-status?date=2026-08-12`,{headers});
          assert.equal(status.status,200); const day=(await status.json()).data;
          for(const key of ['date','isWorkingDay','isHoliday','isSpecialWorkingDay','holidayName','holidayType','specialWorkingDayName','timetableOverride','timetableDay','attendanceAllowed']) assert.ok(key in day,key);
        });
        await t.test('previous calendar forms can create and patch serialized recurrence and legacy aliases',async()=>{
          const rule={frequency:'MONTHLY',interval:1,until:'2026-12-31'};
          const created=await fetch(`${root}/calendar`,{method:'POST',headers,body:JSON.stringify({title:'Old client recurring meeting',event_type:'MEETING',start_date:'2026-08-15',end_date:'2026-08-15',start_time:'09:00',end_time:'10:00',all_day:false,
            affects_attendance:false,affects_timetable:false,target_type:'SECTION',target_ids:[id(11)],recurrence_rule:JSON.stringify(rule),reminder_schedules:'[]',attachments:'[]',notify:false})});
          assert.equal(created.status,201,JSON.stringify(await created.clone().json())); const event=(await created.json()).data;
          assert.equal(event.event_type,'PTM'); assert.equal(event.start_time,'09:00'); assert.equal(event.all_day,false);
          assert.deepEqual(event.recurrence_rule,rule); assert.equal(event.affects_attendance,false);
          const patched=await fetch(`${root}/calendar/${event.id}`,{method:'PUT',headers,body:'{"title":"Meeting revised","start_time":"09:30"}'});
          assert.equal(patched.status,200,JSON.stringify(await patched.clone().json())); const updated=(await patched.json()).data;
          assert.equal(updated.start_time,'09:30'); assert.equal(updated.end_time,'10:00'); assert.deepEqual(updated.recurrence_rule,rule);
          const [stored]=await db`SELECT recurrence_rule,jsonb_typeof(recurrence_rule) AS type FROM calendar_events WHERE id=${event.id}`;
          assert.equal(stored.type,'object'); assert.deepEqual(stored.recurrence_rule,rule);
          const targets=await db`SELECT target_type,target_id FROM calendar_event_targets WHERE event_id=${event.id}`;
          assert.deepEqual(Array.from(targets),[{target_type:'SECTION',target_id:id(11)}]);
        });
        await t.test('unmigrated HTTP database: dashboard, policy discovery and legacy correction stay usable',async()=>{
          // Recreate the exact deployment order from the reported dashboard
          // failure. This guarded scratch database has no feature storage.
          for(const table of ['daily_attendance','calendar_events','calendar_event_targets','attendance_calendar_policies','attendance_report_finalizations','student_enrollments','students','exams','exam_subjects','events','event_audience_targets']) {
            await db.unsafe(`DROP TRIGGER IF EXISTS attendance_calendar_audit ON ${table}; DROP TRIGGER IF EXISTS attendance_calendar_write_lock ON ${table}`);
          }
          await db.unsafe(`DROP TABLE attendance_calendar_alerts,attendance_report_finalizations,attendance_calendar_policies;
            ALTER TABLE calendar_events DROP COLUMN override_event_ids,DROP COLUMN override_reason;
            ALTER TABLE daily_attendance DROP COLUMN correction_reason;`);
          for(const query of ['month=2026-08','start_date=2026-08-01&end_date=2026-08-31']) {
            const response=await fetch(`${root}/calendar?${query}`,{headers});
            assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
            assert.ok(Array.isArray((await response.json()).data));
          }
          const upcoming=await fetch(`${root}/calendar/upcoming?limit=5`,{headers});
          assert.equal(upcoming.status,200); assert.ok(Array.isArray((await upcoming.json()).data));
          const policy=await fetch(`${root}/calendar/attendance-policy`,{headers});
          assert.equal(policy.status,200); const settings=(await policy.json()).data;
          assert.equal(settings.schema_ready,false); assert.equal(settings.enabled,false); assert.deepEqual(settings.policies,[]);
          const denied=await fetch(`${root}/calendar/attendance-policy`,{method:'PUT',headers,body:'{"enabled":true}'});
          assert.equal(denied.status,409); assert.match((await denied.json()).error,/migration/);
          const [record]=await db`SELECT id FROM daily_attendance WHERE student_enrollment_id=${id(31)} AND attendance_date='2026-10-05'`;
          const corrected=await fetch(`${root}/attendance/${record.id}`,{method:'PUT',headers,body:'{"status":"absent"}'});
          assert.equal(corrected.status,200,JSON.stringify(await corrected.clone().json()));
          assert.equal((await corrected.json()).data.attendance.status,'absent');
          const [audit]=await db`SELECT details FROM audit_logs WHERE entity='daily_attendance' AND entity_id=${String(record.id)} ORDER BY created_at DESC LIMIT 1`;
          assert.equal(audit.details.reason,'Legacy client correction; no reason supplied');
          const created=await fetch(`${root}/calendar`,{method:'POST',headers,body:'{"title":"Before migration","event_type":"SCHOOL_EVENT","start_date":"2026-08-17","notify":false,"reminder_schedules":[]}'});
          assert.equal(created.status,201,JSON.stringify(await created.clone().json()));
        });
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  } finally { await db.end({ timeout: 2 }); mock.restoreAll(); }
});
