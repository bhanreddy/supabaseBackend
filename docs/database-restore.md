# SchoolIMS Database Restore

> Never restore automatically into production. There is no one-click production restore in Founder Console.

## Safety Rules

1. Restore first into a **temporary** PostgreSQL 17 database.
2. Run `scripts/restore_test.js` validation.
3. Production cutover requires explicit human approval and a maintenance window.
4. The target URL must not contain `prod` / `production` / `simsapi` unless `ALLOW_PRODUCTION_RESTORE=1` is set by an operator who understands the risk.
5. Single-school recovery must **not** overwrite the shared production database.

---

## 1. Restore Into a Temporary Database

```bash
export GCP_PROJECT_ID=YOUR_PROJECT_ID
export GCS_BACKUP_BUCKET="schoolims-db-backups-${GCP_PROJECT_ID}"
export STORAGE_PATH="gs://${GCS_BACKUP_BUCKET}/database/daily/2026/09/schoolims-db-2026-09-14-020000.dump.enc"

# Download
gcloud storage cp "${STORAGE_PATH}" /tmp/schoolims-db.dump.enc

# Encryption key from Secret Manager (never commit)
export BACKUP_ENCRYPTION_KEY="$(gcloud secrets versions access latest --secret=BACKUP_ENCRYPTION_KEY --project="${GCP_PROJECT_ID}")"

# Temporary Postgres
docker run --name schoolims-restore-temp \
  -e POSTGRES_PASSWORD=RestoreTempPassword123 \
  -e POSTGRES_DB=schoolims_temp \
  -p 5439:5432 \
  -d postgres:17

export TEMP_DB_URL="postgresql://postgres:RestoreTempPassword123@127.0.0.1:5439/schoolims_temp"

# Decrypt + restore + validate
cd SchoolIMS-Backend
node scripts/restore_test.js \
  --target-db="${TEMP_DB_URL}" \
  --archive="/tmp/schoolims-db.dump.enc"
```

Manual decrypt + `pg_restore` (equivalent):

```bash
node --input-type=module -e "
import { decryptFile } from './jobs/backup/src/encryptionService.js';
const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex');
await decryptFile('/tmp/schoolims-db.dump.enc', '/tmp/schoolims-db.dump', key);
console.log('decrypted');
"

pg_restore \
  --dbname="${TEMP_DB_URL}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --verbose \
  /tmp/schoolims-db.dump

node scripts/restore_test.js --validate-only --target-db="${TEMP_DB_URL}"

rm -f /tmp/schoolims-db.dump
```

Destroy the temporary environment after review:

```bash
docker rm -f schoolims-restore-temp
rm -f /tmp/schoolims-db.dump.enc /tmp/schoolims-db.dump
```

---

## 2. What Validation Checks

`validateRestoredDatabase` confirms:

- Critical tables exist (`schools`, `users`, `persons`, `roles`, `permissions`, `students`, `classes`, `sections`, `academic_years`, fee and attendance tables, …)
- Tenant-scoped tables have `school_id`
- At least one school row can be queried
- `users` is populated
- Public-schema index count is not suspiciously low

It does not start SchoolIMS API automatically. After validation, smoke-test a staging API pointed at `TEMP_DB_URL` (login, one school dashboard). Do not point production `simsapi.nexsyrus.com` at the temp database.

---

## 3. Production Restore (Human Approval)

Required confirmations before touching production:

1. Incident owner names the backup_id to restore.
2. Second operator confirms the backup checksum and restore-test report.
3. Maintenance window is scheduled; writes are stopped.
4. Layer 1 Supabase PITR is considered first if RPO allows it.
5. A pre-restore snapshot/PITR restore point is recorded.
6. Restore is applied only to the intended production database URL.
7. Post-restore smoke tests: auth, one tenant `school_id` query, Founder Console.

There is no Founder Console button for this path.

---

## 4. Single-School Recovery (Future Controlled Path)

Because SchoolIMS is single-database multi-tenant:

```
full backup → temporary DB → filter school_id → review package → approval → targeted restore
```

Example extraction from the temp database:

```sql
COPY (SELECT * FROM students WHERE school_id = 17) TO '/tmp/school_17_students.csv' WITH CSV HEADER;
COPY (SELECT * FROM daily_attendance WHERE school_id = 17) TO '/tmp/school_17_attendance.csv' WITH CSV HEADER;
COPY (SELECT * FROM fee_transactions WHERE school_id = 17) TO '/tmp/school_17_fees.csv' WITH CSV HEADER;
```

Do not `pg_restore --clean` over production to recover one school.

---

## 5. Restore Test Audit

Record the restore test outside production:

- backup_id
- operator
- temp database host
- validation JSON from `restore_test.js`
- destroy confirmation

Do not store the encryption key or database password in that record.
