#!/usr/bin/env node
/**
 * Production Disaster Recovery & Restore Validation Utility
 *
 * Usage:
 *   node scripts/restore_test.js --target-db="postgresql://user:pass@host:5432/temp_db" --archive="/path/to/schoolims-db.dump.enc"
 *   node scripts/restore_test.js --validate-only --target-db="postgresql://..."
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runRestoreValidation, validateRestoredDatabase } from '../jobs/backup/src/restoreValidator.js';
import { resolveEncryptionKey } from '../jobs/backup/src/config.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  for (const arg of args) {
    if (arg.startsWith('--target-db=')) params.targetDb = arg.split('=')[1];
    if (arg.startsWith('--archive=')) params.archive = arg.split('=')[1];
    if (arg.startsWith('--key=')) params.key = arg.split('=')[1];
    if (arg === '--validate-only') params.validateOnly = true;
  }
  return params;
}

async function main() {
  const { targetDb, archive, key: rawKey, validateOnly } = parseArgs();

  const targetDatabaseUrl = targetDb || process.env.RESTORE_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!targetDatabaseUrl) {
    console.error('❌ Error: --target-db or RESTORE_TEST_DATABASE_URL is required.');
    console.error('Example: node scripts/restore_test.js --target-db="postgresql://localhost:5432/schoolims_restore_test" --archive="/tmp/schoolims-db.dump.enc"');
    process.exit(1);
  }

  // Safety check: ensure target DB is not production
  if (/simsapi|prod|production/i.test(targetDatabaseUrl) && !process.env.ALLOW_PRODUCTION_RESTORE) {
    console.error('🚨 FATAL SAFETY VIOLATION: Refusing to restore to a database URL containing "prod" or "production".');
    console.error('Restore validation MUST only target dedicated temporary or isolated staging databases.');
    process.exit(1);
  }

  console.log('===========================================================');
  console.log('SchoolIMS Disaster Recovery & Restore Validator');
  console.log('Target Database: ' + targetDatabaseUrl.replace(/:[^:@]+@/, ':****@'));
  console.log('===========================================================');

  if (validateOnly) {
    console.log('--> Running schema & tenant validation against existing database...');
    const report = await validateRestoredDatabase(targetDatabaseUrl);
    console.log('\nValidation Report:');
    console.log(JSON.stringify(report, null, 2));

    if (!report.success) {
      console.error('\n❌ RESTORE VALIDATION FAILED!');
      process.exit(1);
    }
    console.log('\n✅ RESTORE VALIDATION PASSED!');
    process.exit(0);
  }

  if (!archive || !fs.existsSync(archive)) {
    console.error(`❌ Archive file not found: ${archive}`);
    process.exit(1);
  }

  const encryptionKey = resolveEncryptionKey(rawKey || process.env.BACKUP_ENCRYPTION_KEY);

  console.log(`--> Decrypting and restoring archive ${archive}...`);
  try {
    const report = await runRestoreValidation({
      sourceArchiveFilePath: archive,
      targetTestDatabaseUrl: targetDatabaseUrl,
      encryptionKey,
    });

    console.log('\nValidation Report:');
    console.log(JSON.stringify(report, null, 2));

    if (!report.success) {
      console.error('\n❌ RESTORE VALIDATION FAILED!');
      process.exit(1);
    }

    console.log('\n✅ RESTORE TEST & VALIDATION COMPLETED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Restore operation failed: ${err.message}`);
    process.exit(1);
  }
}

main();
