/** Explicit fresh-install baseline and forward Batch 1 upgrades.
 * Existing databases are never baselined or marked historically migrated.
 */
import dns from 'node:dns';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import 'dotenv/config';

dns.setDefaultResultOrder('ipv4first');
import { applyBatch1Migrations } from './run_batch1_migrations.js';
import { applyBatch2Migrations, verifyBatch2Database } from './run_batch2_migrations.js';
import { applyBatch3Migrations, verifyBatch3Database } from './run_batch3_migrations.js';

const staffAttendanceV2MigrationName = '20260908_v418_staff_attendance_v2.sql';
const studentLoginQrMigrationName = '20260910_v419_student_login_qr.sql';
const smartPopupManagerMigrationName = '20260911_v421_smart_popup_manager.sql';
const finePenaltyMigrationName = '20260912_v422_fine_penalty_adjustments.sql';
const fineHardeningMigrationName = '20260912_v423_fine_module_hardening.sql';
const celebrationSettingsMigrationName = '20260912_v424_celebration_settings.sql';
const visitorManagementMigrationName = '20260912_v425_premium_visitor_management_system.sql';
const visitorHardeningMigrationName = '20260912_v426_visitor_management_hardening.sql';
const academicCalendarEngineMigrationName = '20260912_v427_academic_calendar_engine.sql';
const academicCalendarHardeningMigrationName = '20260912_v428_academic_calendar_hardening.sql';
const academicCalendarProductionMigrationName = '20260912_v429_academic_calendar_production.sql';
const academicPlannerSchemaMigrationName = '20260912_v429_premium_academic_planner.sql';
const academicPlannerProductionMigrationName = '20260912_v430_academic_planner_production.sql';
const eventManagementMigrationName = '20260913_v431_premium_event_management_system.sql';
const eventMediaMigrationName = '20260913_v432_event_media_docs_volunteers.sql';
const admissionWorkflowMigrationName = '20260913_v433_premium_admission_workflow_system.sql';
const admissionHardeningMigrationName = '20260913_v434_admission_workflow_hardening.sql';
const anecdoteIntelligenceMigrationName = '20260913_v435_anecdote_intelligence_engine.sql';
const anecdoteIntelligenceHardeningMigrationName = '20260913_v436_anecdote_intelligence_hardening.sql';
const omrEngineMigrationName = '20260913_v436_premium_omr_engine.sql';
const omrEngineHardeningMigrationName = '20260913_v437_omr_engine_hardening.sql';
const contentEngineMigrationName = '20260914_v438_content_engine.sql';
const contentEngineHardeningMigrationName = '20260914_v439_content_engine_hardening.sql';
const databaseBackupMigrationName = '20260914_v445_database_backup_subsystem.sql';
const transportReliabilityMigrationName = '20260921_transport_reliability.sql';
const examPerSectionTimetableMigrationName = '20260923_exam_per_section_timetable.sql';
const parentProfilePhotoPermissionMigrationName = '20260925_parent_profile_photo_permission.sql';
const examHallTicketBatchesMigrationName = '20260925_exam_hall_ticket_batches.sql';
const teacherSalaryPayrollMigrationName = '20260925_teacher_salary_payroll.sql';
const leaveSalaryApprovalMigrationName = '20260925_leave_salary_approval.sql';
const databaseBackupHardeningMigrationName = '20260914_v446_backup_subsystem_hardening.sql';

async function applyNamedSqlMigration(db, filename, lockKey) {
  const body = fs.readFileSync(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(${lockKey})`;
    await connection`SET lock_timeout = '5s'`;
    await connection`SET statement_timeout = '5min'`;
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    await connection.unsafe(body.replace(/^BEGIN;|^COMMIT;/gm, '').trim());
    await connection`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await connection`REVOKE ALL ON schema_migrations FROM PUBLIC, anon, authenticated`;
    await connection`INSERT INTO schema_migrations (filename)
      VALUES (${filename}) ON CONFLICT (filename) DO NOTHING`;
    await connection.unsafe('COMMIT');
    transactionOpen = false;
  } finally {
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
      await connection`SELECT pg_advisory_unlock(${lockKey})`;
    } finally { connection.release(); }
  }
}

async function applyStudentLoginQrMigration(db) {
  const body = fs.readFileSync(new URL(`../migrations/${studentLoginQrMigrationName}`, import.meta.url), 'utf8');
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(4190910)`;
    await connection`SET lock_timeout = '5s'`;
    await connection`SET statement_timeout = '5min'`;
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    await connection.unsafe(body.replace(/^BEGIN;|^COMMIT;/gm, '').trim());
    await connection`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await connection`REVOKE ALL ON schema_migrations FROM PUBLIC, anon, authenticated`;
    await connection`INSERT INTO schema_migrations (filename)
      VALUES (${studentLoginQrMigrationName}) ON CONFLICT (filename) DO NOTHING`;
    await connection.unsafe('COMMIT');
    transactionOpen = false;
  } finally {
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
      await connection`SELECT pg_advisory_unlock(4190910)`;
    } finally { connection.release(); }
  }
}

async function applySmartPopupManagerMigration(db) {
  const body = fs.readFileSync(new URL(`../migrations/${smartPopupManagerMigrationName}`, import.meta.url), 'utf8');
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(4210911)`;
    await connection`SET lock_timeout = '5s'`;
    await connection`SET statement_timeout = '5min'`;
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    await connection.unsafe(body.replace(/^BEGIN;|^COMMIT;/gm, '').trim());
    await connection`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await connection`REVOKE ALL ON schema_migrations FROM PUBLIC, anon, authenticated`;
    await connection`INSERT INTO schema_migrations (filename)
      VALUES (${smartPopupManagerMigrationName}) ON CONFLICT (filename) DO NOTHING`;
    await connection.unsafe('COMMIT');
    transactionOpen = false;
  } finally {
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
      await connection`SELECT pg_advisory_unlock(4210911)`;
    } finally { connection.release(); }
  }
}

async function applyStaffAttendanceV2Migration(db) {
  const body = fs.readFileSync(
    new URL(`../migrations/${staffAttendanceV2MigrationName}`, import.meta.url),
    'utf8'
  );
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(4180906)`;
    await connection`SET lock_timeout = '5s'`;
    await connection`SET statement_timeout = '5min'`;
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    await connection.unsafe(body.replace(/^BEGIN;|^COMMIT;/gm, '').trim());
    await connection`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await connection`REVOKE ALL ON schema_migrations FROM PUBLIC, anon, authenticated`;
    await connection`INSERT INTO schema_migrations (filename)
      VALUES (${staffAttendanceV2MigrationName}) ON CONFLICT (filename) DO NOTHING`;
    await connection.unsafe('COMMIT');
    transactionOpen = false;
  } finally {
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
      await connection`SELECT pg_advisory_unlock(4180906)`;
    } finally {
      connection.release();
    }
  }
}

const manifestUrl = new URL('../migrations/baselines/20260905_manifest.json', import.meta.url);
export function readReleaseBaseline() {
  const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
  const body = fs.readFileSync(new URL(manifest.file, manifestUrl), 'utf8');
  const seed = fs.readFileSync(new URL(manifest.seed_file, manifestUrl), 'utf8');
  if (createHash('sha256').update(body).digest('hex') !== manifest.sha256) {
    throw new Error('Release baseline checksum mismatch; do not modify an established baseline');
  }
  if (createHash('sha256').update(seed).digest('hex') !== manifest.seed_sha256) {
    throw new Error('Release reference seed checksum mismatch; do not modify an established seed');
  }
  return { manifest, body, seed };
}

export async function initializeReleaseDatabase(db) {
  const { manifest, body, seed } = readReleaseBaseline();
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(4180906)`;
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    const [tracking] = await connection`SELECT to_regclass('public.schema_baselines') AS name`;
    if (tracking.name) {
      const [existing] = await connection`SELECT sha256, seed_sha256 FROM public.schema_baselines WHERE id = ${manifest.id}`;
      if (!existing || existing.sha256 !== manifest.sha256 || existing.seed_sha256 !== manifest.seed_sha256) {
        throw new Error('Database baseline does not match this release');
      }
    } else {
      const objects = await connection`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype='e')`;
      if (objects.length) throw new Error('Fresh initialization requires an empty public application schema; use --upgrade for existing databases');
      const [platform] = await connection`SELECT to_regclass('auth.users') AS users,
        to_regprocedure('auth.uid()') AS uid, to_regprocedure('auth.role()') AS role, to_regprocedure('auth.jwt()') AS jwt`;
      if (!platform.users || !platform.uid || !platform.role || !platform.jwt) throw new Error('Supabase auth platform is required; local tests must use the isolated platform fixture');
      await connection.unsafe(body);
      await connection`SET search_path TO public, extensions`;
      await connection.unsafe(seed);
      // Remove portal access to internal automation before committing any new schema.
      const safety = fs.readFileSync(new URL('../migrations/20260905_v418_recovery_safety.sql', import.meta.url), 'utf8').replace(/^BEGIN;|^COMMIT;/gm, '');
      await connection.unsafe(safety);
      await connection`CREATE TABLE public.schema_baselines (id text PRIMARY KEY, sha256 text NOT NULL,
        seed_sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
      await connection`REVOKE ALL ON public.schema_baselines FROM PUBLIC, anon, authenticated`;
      await connection`INSERT INTO public.schema_baselines (id,sha256,seed_sha256)
        VALUES (${manifest.id},${manifest.sha256},${manifest.seed_sha256})`;
    }
    await connection.unsafe('COMMIT');
    transactionOpen = false;
  } finally {
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
      await connection`SELECT pg_advisory_unlock(4180906)`;
    }
    finally { connection.release(); }
  }
  await applyBatch1Migrations(db);
  await applyBatch2Migrations(db);
  await applyBatch3Migrations(db);
  await applyStaffAttendanceV2Migration(db);
  await applyStudentLoginQrMigration(db);
  await applySmartPopupManagerMigration(db);
  await applyNamedSqlMigration(db, finePenaltyMigrationName, 4220912);
  await applyNamedSqlMigration(db, fineHardeningMigrationName, 4230912);
  await applyNamedSqlMigration(db, celebrationSettingsMigrationName, 4240912);
  await applyNamedSqlMigration(db, databaseBackupMigrationName, 4450914);
  await applyNamedSqlMigration(db, databaseBackupHardeningMigrationName, 4460914);
  await applyNamedSqlMigration(db, transportReliabilityMigrationName, 4470921);
  await applyNamedSqlMigration(db, examPerSectionTimetableMigrationName, 4480923);
  await applyNamedSqlMigration(db, parentProfilePhotoPermissionMigrationName, 4490925);
  await applyNamedSqlMigration(db, examHallTicketBatchesMigrationName, 4500925);
  await applyNamedSqlMigration(db, teacherSalaryPayrollMigrationName, 4510925);
  await applyNamedSqlMigration(db, leaveSalaryApprovalMigrationName, 4520925);
}

export async function verifyReleaseDatabase(db) {
  const required = ['school_automation_rules','automation_execution_logs','student_fees','fee_transactions','receipts','fines','fine_categories','fine_policies'];
  for (const name of required) {
    const [row] = await db`SELECT to_regclass(${`public.${name}`}) AS name`;
    if (!row.name) throw new Error(`Missing release table ${name}`);
  }
  const [column] = await db`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='automation_execution_logs' AND column_name='student_id'`;
  if (!column) throw new Error('Fee recovery forward migration is missing');
  for (const name of ['idx_auto_exec_student_created','idx_auto_exec_completed_date','idx_student_fees_recovery_due']) {
    const [index] = await db`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}`;
    if (!index?.indisvalid) throw new Error(`Missing or invalid release index ${name}`);
  }
  const [examSectionColumn] = await db`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='exam_subjects' AND column_name='class_section_id'`;
  if (!examSectionColumn) throw new Error('Exam per-section timetable migration is missing');
  const [examSectionMigration] = await db`SELECT 1 FROM schema_migrations
    WHERE filename = ${examPerSectionTimetableMigrationName}`;
  if (!examSectionMigration) throw new Error('Exam per-section timetable migration is not recorded');
  const [parentPhotoMigration] = await db`SELECT 1 FROM schema_migrations
    WHERE filename = ${parentProfilePhotoPermissionMigrationName}`;
  if (!parentPhotoMigration) throw new Error('Parent profile photo permission migration is not recorded');
  const [hallTicketMigration] = await db`SELECT 1 FROM schema_migrations
    WHERE filename = ${examHallTicketBatchesMigrationName}`;
  if (!hallTicketMigration) throw new Error('Exam hall-ticket batch migration is not recorded');
  const [teacherSalaryMigration] = await db`SELECT 1 FROM schema_migrations
    WHERE filename = ${teacherSalaryPayrollMigrationName}`;
  if (!teacherSalaryMigration) throw new Error('Teacher salary payroll migration is not recorded');
  const [teacherSalaryTable] = await db`SELECT to_regclass('public.teacher_payroll_snapshots') AS name`;
  if (!teacherSalaryTable?.name) throw new Error('Teacher salary payroll snapshot table is missing');
  const [leaveSalaryMigration] = await db`SELECT 1 FROM schema_migrations
    WHERE filename = ${leaveSalaryApprovalMigrationName}`;
  if (!leaveSalaryMigration) throw new Error('Leave salary approval migration is not recorded');
  const [leaveSalaryColumn] = await db`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='leave_applications' AND column_name='payroll_treatment'`;
  if (!leaveSalaryColumn) throw new Error('Leave payroll treatment column is missing');
  for (const name of ['exam_hall_ticket_batches', 'exam_hall_ticket_batch_students']) {
    const [table] = await db`SELECT to_regclass(${`public.${name}`}) AS name`;
    if (!table?.name) throw new Error(`Exam hall-ticket tracking table is missing: ${name}`);
  }
  for (const name of ['idx_exam_subjects_active_class','idx_exam_subjects_active_section']) {
    const [index] = await db`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}`;
    if (!index?.indisvalid) throw new Error(`Missing or invalid release index ${name}`);
  }
  for (const name of ['school_automation_rules','automation_execution_logs']) {
    const [access] = await db`SELECT c.relrowsecurity AS rls,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS portal,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anonymous
      FROM pg_class c WHERE c.oid=${`public.${name}`}::regclass`;
    if (!access.rls || access.portal || access.anonymous) throw new Error(`Internal table access is unsafe: ${name}`);
  }
  const [loginQrAccess] = await db`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
    has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS portal,
    has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anonymous
    FROM pg_class c WHERE c.oid='public.student_login_qr_credentials'::regclass`;
  if (!loginQrAccess?.rls || !loginQrAccess?.force_rls || loginQrAccess.portal || loginQrAccess.anonymous) {
    throw new Error('Student login QR credential storage is missing or unsafe');
  }
  const referenceCounts = await db`SELECT
    (SELECT count(*)::int FROM genders) AS genders,
    (SELECT count(*)::int FROM student_statuses) AS student_statuses,
    (SELECT count(*)::int FROM staff_statuses) AS staff_statuses,
    (SELECT count(*)::int FROM relationship_types) AS relationship_types`;
  const references = referenceCounts[0];
  if (references.genders < 3 || references.student_statuses < 5 || references.staff_statuses < 4 || references.relationship_types < 5) {
    throw new Error('Required release reference data is incomplete');
  }
  await verifyBatch2Database(db);
  await verifyBatch3Database(db);
  const v2Tables = [
    'campus_attendance_policies',
    'staff_device_registrations',
    'staff_device_sessions',
    'staff_device_request_nonces',
    'attendance_challenges',
    'staff_attendance_events',
    'staff_attendance_exceptions',
    'staff_attendance_audit_logs',
  ];
  for (const name of v2Tables) {
    const [access] = await db`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS portal,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anonymous
      FROM pg_class c WHERE c.oid=${`public.${name}`}::regclass`;
    if (!access || !access.rls || !access.force_rls || access.portal || access.anonymous) {
      throw new Error(`Missing or unsafe Staff Attendance V2 table: ${name}`);
    }
  }
  for (const columnName of ['check_in_time', 'check_out_time', 'verification_source', 'is_verified', 'is_finalized']) {
    const [column] = await db`SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='staff_attendance' AND column_name=${columnName}`;
    if (!column) throw new Error(`Missing Staff Attendance V2 column staff_attendance.${columnName}`);
  }
  const [installationColumn] = await db`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='staff_device_registrations' AND column_name='installation_id'`;
  if (!installationColumn) throw new Error('Missing Staff Attendance V2 installation binding');
  for (const name of [
    'uq_active_registration_per_person',
    'uq_active_registration_per_device',
    'uq_active_registration_per_installation',
    'uq_active_staff_device_session',
    'uq_pending_staff_att_exception',
  ]) {
    const [index] = await db`SELECT i.indisvalid, i.indisunique
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=${name}`;
    if (!index?.indisvalid || !index?.indisunique) throw new Error(`Missing Staff Attendance V2 invariant: ${name}`);
  }
  const [missingPermissions] = await db`
    SELECT count(*)::int AS count
    FROM schools s
    CROSS JOIN (VALUES
      ('staff_attendance.self'),
      ('staff_attendance.manage'),
      ('staff_attendance.correct')
    ) expected(code)
    LEFT JOIN permissions p ON p.school_id=s.id AND p.code=expected.code AND p.deleted_at IS NULL
    WHERE p.id IS NULL
  `;
  if (missingPermissions.count) throw new Error('Staff Attendance V2 school permissions are incomplete');
  const [missingMappings] = await db`
    WITH required(role_code, permission_code) AS (VALUES
      ('staff', 'staff_attendance.self'),
      ('teacher', 'staff_attendance.self'),
      ('principal', 'staff_attendance.self'),
      ('principal', 'staff_attendance.manage'),
      ('principal', 'staff_attendance.correct'),
      ('admin', 'staff_attendance.manage'),
      ('admin', 'staff_attendance.correct')
    )
    SELECT count(*)::int AS count
    FROM roles r
    JOIN required expected ON expected.role_code=r.code
    JOIN permissions p ON p.school_id=r.school_id AND p.code=expected.permission_code AND p.deleted_at IS NULL
    LEFT JOIN role_permissions rp ON rp.school_id=r.school_id AND rp.role_id=r.id
      AND rp.permission_id=p.id AND rp.deleted_at IS NULL
    WHERE r.deleted_at IS NULL AND rp.role_id IS NULL
  `;
  if (missingMappings.count) throw new Error('Staff Attendance V2 role mappings are incomplete');
  const [popupTable] = await db`SELECT to_regclass('public.popups') AS name`;
  if (!popupTable?.name) throw new Error('Smart Popup Manager tables are missing');
  const [celebrationSettings] = await db`SELECT to_regclass('public.school_celebration_settings') AS name`;
  if (!celebrationSettings?.name) throw new Error('Celebration settings table is missing');
  const [visitorTables] = await db`SELECT to_regclass('public.visitor_requests') AS name`;
  if (!visitorTables?.name) throw new Error('Visitor management tables are missing');
  const [missingPopupPermissions] = await db`
    SELECT count(*)::int AS count
    FROM schools s
    CROSS JOIN (VALUES
      ('popups.view'),
      ('popups.create'),
      ('popups.update'),
      ('popups.delete'),
      ('popups.publish'),
      ('popups.analytics')
    ) expected(code)
    LEFT JOIN permissions p ON p.school_id=s.id AND p.code=expected.code AND p.deleted_at IS NULL
    WHERE p.id IS NULL
  `;
  if (missingPopupPermissions.count) throw new Error('Smart Popup Manager school permissions are incomplete');
  const [calendarTable] = await db`SELECT to_regclass('public.calendar_events') AS name`;
  if (!calendarTable?.name) throw new Error('Academic calendar tables are missing');
  const [plannerTable] = await db`SELECT to_regclass('public.academic_plans') AS name`;
  if (!plannerTable?.name) throw new Error('Academic planner tables are missing');
  const [contentTable] = await db`SELECT to_regclass('public.content_items') AS name`;
  if (!contentTable?.name) throw new Error('Content engine tables are missing');
  const [contentSchedules] = await db`SELECT to_regclass('public.content_schedules') AS name`;
  if (!contentSchedules?.name) throw new Error('Content engine schedules table is missing');
  const [contentPerms] = await db`
    SELECT count(*)::int AS count
    FROM schools s
    CROSS JOIN (VALUES
      ('content.view'),
      ('content.create'),
      ('content.submit'),
      ('content.approve'),
      ('content.publish'),
      ('content.manage')
    ) expected(code)
    LEFT JOIN permissions p ON p.school_id=s.id AND p.code=expected.code AND p.deleted_at IS NULL
    WHERE p.id IS NULL
  `;
  if (contentPerms.count) throw new Error('Content engine school permissions are incomplete');
  const [backupJobsTable] = await db`SELECT to_regclass('public.backup_jobs') AS name`;
  if (!backupJobsTable?.name) throw new Error('Database backup subsystem tables are missing');
  const [backupEventsTable] = await db`SELECT to_regclass('public.backup_events') AS name`;
  if (!backupEventsTable?.name) throw new Error('Database backup events table is missing');
  const [backupSettingsTable] = await db`SELECT to_regclass('public.backup_settings') AS name`;
  if (!backupSettingsTable?.name) throw new Error('Database backup settings table is missing');
  return { ready: true, migrationScope: 'Batches 1-3 + Staff Attendance V2 + Smart Popup Manager + Academic Calendar + Academic Planner + Content Engine + Database Backups', freshBaseline: readReleaseBaseline().manifest.id };
}

function sessionConnectionUrl(source) {
  return String(source)
    .replace(/pooler\.supabase\.com:6543/i, 'pooler.supabase.com:5432')
    .replace(/[?&]pgbouncer=true/i, '');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--init','--upgrade','--check','--student-login-qr'].includes(mode)) {
    throw new Error('Usage: node scripts/migrate_release.js --init | --upgrade | --check | --student-login-qr');
  }
  const source = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!source) throw new Error('Set DATABASE_URL_DIRECT to a direct/session connection');
  const connectionUrl = sessionConnectionUrl(source);
  if (/pooler\.supabase\.com:6543/i.test(connectionUrl)) {
    throw new Error('Use a direct/session connection, not the transaction pooler');
  }
  const local = /localhost|127\.0\.0\.1/.test(connectionUrl);
  const db = postgres(connectionUrl, { max: 2, prepare: false, ssl: local ? false : 'require' });
  try {
    if (mode==='--init') await initializeReleaseDatabase(db);
    if (mode==='--upgrade') {
      await applyBatch1Migrations(db);
      await applyBatch2Migrations(db);
      await applyBatch3Migrations(db);
      await applyStaffAttendanceV2Migration(db);
      await applyStudentLoginQrMigration(db);
      await applySmartPopupManagerMigration(db);
      await applyNamedSqlMigration(db, finePenaltyMigrationName, 4220912);
      await applyNamedSqlMigration(db, fineHardeningMigrationName, 4230912);
      await applyNamedSqlMigration(db, celebrationSettingsMigrationName, 4240912);
      await applyNamedSqlMigration(db, visitorManagementMigrationName, 4250912);
      await applyNamedSqlMigration(db, visitorHardeningMigrationName, 4260912);
      await applyNamedSqlMigration(db, academicCalendarEngineMigrationName, 4270912);
      await applyNamedSqlMigration(db, academicCalendarHardeningMigrationName, 4280912);
      await applyNamedSqlMigration(db, academicCalendarProductionMigrationName, 4290912);
      await applyNamedSqlMigration(db, academicPlannerSchemaMigrationName, 4300912);
      await applyNamedSqlMigration(db, academicPlannerProductionMigrationName, 4301912);
      await applyNamedSqlMigration(db, eventManagementMigrationName, 4310913);
      await applyNamedSqlMigration(db, eventMediaMigrationName, 4320913);
      await applyNamedSqlMigration(db, admissionWorkflowMigrationName, 4330913);
      await applyNamedSqlMigration(db, admissionHardeningMigrationName, 4340913);
      await applyNamedSqlMigration(db, anecdoteIntelligenceMigrationName, 4350913);
      await applyNamedSqlMigration(db, anecdoteIntelligenceHardeningMigrationName, 4360913);
      await applyNamedSqlMigration(db, omrEngineMigrationName, 4361913);
      await applyNamedSqlMigration(db, omrEngineHardeningMigrationName, 4370913);
      await applyNamedSqlMigration(db, contentEngineMigrationName, 4380914);
      await applyNamedSqlMigration(db, contentEngineHardeningMigrationName, 4390914);
      await applyNamedSqlMigration(db, databaseBackupMigrationName, 4450914);
      await applyNamedSqlMigration(db, databaseBackupHardeningMigrationName, 4460914);
      await applyNamedSqlMigration(db, transportReliabilityMigrationName, 4470921);
      await applyNamedSqlMigration(db, examPerSectionTimetableMigrationName, 4480923);
      await applyNamedSqlMigration(db, parentProfilePhotoPermissionMigrationName, 4490925);
      await applyNamedSqlMigration(db, examHallTicketBatchesMigrationName, 4500925);
      await applyNamedSqlMigration(db, teacherSalaryPayrollMigrationName, 4510925);
      await applyNamedSqlMigration(db, leaveSalaryApprovalMigrationName, 4520925);
    }
    if (mode==='--student-login-qr') {
      await applyStudentLoginQrMigration(db);
      const [row] = await db`SELECT to_regclass('public.student_login_qr_credentials') AS name`;
      if (!row?.name) throw new Error('student_login_qr_credentials was not created');
      console.log('student_login_qr_credentials is installed');
    } else {
      console.log(await verifyReleaseDatabase(db));
    }
  } finally { await db.end({ timeout: 5 }); }
}
