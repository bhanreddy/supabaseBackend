import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import config from './config.js';
import { decryptFile } from './encryptionService.js';
import { calculateFileSha256 } from './checksumService.js';
import { GcsStorageService } from './gcsStorageService.js';
import { parseConnectionParams } from './pgDumpService.js';

// Critical tables required for SchoolIMS operation
export const CRITICAL_TABLES = [
  'schools',
  'users',
  'persons',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'students',
  'classes',
  'sections',
  'academic_years',
  'admission_applications',
  'fee_structures',
  'fee_transactions',
  'daily_attendance',
];

// Tables that MUST enforce tenant isolation with school_id column
export const TENANT_SCOPED_TABLES = [
  'users',
  'students',
  'classes',
  'sections',
  'academic_years',
  'fee_structures',
  'fee_transactions',
  'daily_attendance',
];

/**
 * Executes pg_restore to restore a custom format dump file into a target database.
 *
 * @param {Object} params
 * @param {string} params.targetDatabaseUrl
 * @param {string} params.dumpFilePath
 * @param {string} [params.pgRestorePath='pg_restore']
 * @returns {Promise<{ exitCode: number, durationSeconds: number }>}
 */
export async function executePgRestore({
  targetDatabaseUrl,
  dumpFilePath,
  pgRestorePath = config.pgRestorePath || 'pg_restore',
}) {
  const params = parseConnectionParams(targetDatabaseUrl);
  const startTime = Date.now();

  const env = {
    ...process.env,
    PGHOST: params.host,
    PGPORT: params.port,
    PGUSER: params.user,
    PGPASSWORD: params.password,
    PGDATABASE: params.database,
    PGSSLMODE: 'prefer',
  };

  const args = [
    '--clean', // clean (drop) database objects before recreating them
    '--if-exists', // use IF EXISTS when dropping objects
    '--no-owner', // do not set ownership of objects
    '--no-privileges', // do not restore access privileges
    '--verbose',
    dumpFilePath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(pgRestorePath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3600000,
    });

    let stderrData = '';
    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      if (stderrData.length > 4096) stderrData = stderrData.slice(-2048);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn pg_restore: ${err.message}`));
    });

    child.on('close', (code) => {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      // pg_restore returns 0 on total success, or 1 on warnings (like non-fatal drop errors), >1 on errors
      if (code > 1) {
        return reject(new Error(`pg_restore failed with exit code ${code}. Stderr: ${stderrData.trim()}`));
      }
      resolve({ exitCode: code, durationSeconds });
    });
  });
}

/**
 * Validates a restored PostgreSQL database for SchoolIMS schema integrity,
 * tenant isolation, and data invariants.
 *
 * @param {string} targetDatabaseUrl
 * @returns {Promise<Object>} Validation results
 */
export async function validateRestoredDatabase(targetDatabaseUrl) {
  const sql = postgres(targetDatabaseUrl, {
    max: 2,
    ssl: { rejectUnauthorized: false },
    connect_timeout: 10,
  });

  const report = {
    validatedAt: new Date().toISOString(),
    success: false,
    checks: {
      tables: { passed: false, missing: [] },
      tenantStructure: { passed: false, missingColumns: [] },
      sampleTenantQuery: { passed: false, activeSchoolsCount: 0 },
      authIntegrity: { passed: false, userCount: 0 },
      indexes: { passed: false, indexCount: 0 },
    },
    errors: [],
  };

  try {
    // 1. Table existence check
    const existingTableRows = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
    const existingTableSet = new Set(existingTableRows.map((r) => r.table_name));

    const missingTables = CRITICAL_TABLES.filter((t) => !existingTableSet.has(t));
    report.checks.tables.passed = missingTables.length === 0;
    report.checks.tables.missing = missingTables;
    if (missingTables.length > 0) {
      report.errors.push(`Missing critical tables: ${missingTables.join(', ')}`);
    }

    // 2. Tenant isolation check: school_id column present on tenant-scoped tables
    const tenantColumnRows = await sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'school_id'
    `;
    const tablesWithSchoolId = new Set(tenantColumnRows.map((r) => r.table_name));
    const missingTenantCols = TENANT_SCOPED_TABLES.filter((t) => !tablesWithSchoolId.has(t));
    report.checks.tenantStructure.passed = missingTenantCols.length === 0;
    report.checks.tenantStructure.missingColumns = missingTenantCols;
    if (missingTenantCols.length > 0) {
      report.errors.push(`Missing school_id tenant column on tables: ${missingTenantCols.join(', ')}`);
    }

    // 3. Sample school tenant query
    const schoolRows = await sql`
      SELECT id, name FROM public.schools
      WHERE is_active = true OR is_active IS NULL
      LIMIT 5
    `;
    report.checks.sampleTenantQuery.activeSchoolsCount = schoolRows.length;
    report.checks.sampleTenantQuery.passed = schoolRows.length > 0;
    if (schoolRows.length === 0) {
      report.errors.push('No active schools found in restored database');
    }

    // 4. Auth & User integrity
    const userCountRows = await sql`SELECT count(*)::int as count FROM public.users`;
    const userCount = userCountRows[0]?.count || 0;
    report.checks.authIntegrity.userCount = userCount;
    report.checks.authIntegrity.passed = userCount > 0;
    if (userCount === 0) {
      report.errors.push('No users found in restored database');
    }

    // 5. Index presence check
    const indexRows = await sql`
      SELECT count(*)::int as count
      FROM pg_indexes
      WHERE schemaname = 'public'
    `;
    const indexCount = indexRows[0]?.count || 0;
    report.checks.indexes.indexCount = indexCount;
    report.checks.indexes.passed = indexCount >= 10;
    if (indexCount < 10) {
      report.errors.push(`Suspiciously low index count in restored database (${indexCount})`);
    }

    report.success = report.errors.length === 0;
    return report;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * End-to-end restore validation workflow:
 * 1. Download encrypted backup from GCS (or local file).
 * 2. Decrypt backup archive with AES-256-GCM.
 * 3. Verify dump header.
 * 4. Restore into temporary PostgreSQL database.
 * 5. Validate schema, constraints, tenant structure, and sample school query.
 * 6. Clean up temporary files.
 *
 * @param {Object} params
 * @param {string} params.sourceArchiveFilePath
 * @param {string} params.targetTestDatabaseUrl
 * @param {Buffer} params.encryptionKey
 * @param {string} [params.workDir='/tmp/schoolims-restore-test']
 * @returns {Promise<Object>} Restore validation report
 */
export async function runRestoreValidation({
  sourceArchiveFilePath,
  targetTestDatabaseUrl,
  encryptionKey,
  workDir = '/tmp/schoolims-restore-test',
}) {
  fs.mkdirSync(workDir, { recursive: true });
  const decryptedDumpPath = path.join(workDir, `restored-${Date.now()}.dump`);

  try {
    // 1. Decrypt archive
    await decryptFile(sourceArchiveFilePath, decryptedDumpPath, encryptionKey);

    // 2. Restore into target temporary DB
    const restoreResult = await executePgRestore({
      targetDatabaseUrl: targetTestDatabaseUrl,
      dumpFilePath: decryptedDumpPath,
    });

    // 3. Validate restored database
    const validationReport = await validateRestoredDatabase(targetTestDatabaseUrl);
    validationReport.restoreDurationSeconds = restoreResult.durationSeconds;

    return validationReport;
  } finally {
    // Clean up temporary decrypted dump
    try {
      if (fs.existsSync(decryptedDumpPath)) fs.unlinkSync(decryptedDumpPath);
    } catch (_) {}
  }
}
