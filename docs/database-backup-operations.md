# SchoolIMS Database Backup Operations

## 1. Founder Console

`Founder Console → Infrastructure → Database Backups` (`/console/backups`)

Displayed values come from `public.backup_jobs` / `public.backup_events` / `public.backup_settings`. Empty state is shown as "None" / "—", never fabricated success rates.

Metrics:

- Last successful backup age
- Current job status
- Next scheduled run (daily 02:00 Asia/Kolkata)
- Backup size and duration
- Verification status
- 30-day storage usage of recorded successful archives
- 30-day success/failure timeline
- Stale-backup alert when last success is older than 26 hours
- Recent failures with persisted error messages

## 2. Triggering a Manual Backup

Manual backup does not accept SQL or credentials from the operator. It starts the same Cloud Run Job with `BACKUP_TYPE=manual`.

### Founder Console

1. Open Database Backups.
2. Click **Run Manual Backup**.
3. Confirm. The SuperAdmin API calls the Cloud Run Jobs `:run` API using `schoolims-backup-console`.
4. Refresh until the new `backup_jobs` row appears.

Requires Founder Console env:

- `GCP_PROJECT_ID`
- `GCP_REGION` (default `asia-south1`)
- `BACKUP_CLOUD_RUN_JOB` (default `schoolims-db-backup`)
- `BACKUP_TRIGGER_SA_JSON` (JSON key for `schoolims-backup-console`, Secret Manager / host secret)

Local development only: `BACKUP_TRIGGER_MODE=local`.

### Cloud CLI

```bash
export GCP_PROJECT_ID=YOUR_PROJECT_ID
export GCP_REGION=asia-south1

gcloud run jobs execute schoolims-db-backup \
  --region="${GCP_REGION}" \
  --project="${GCP_PROJECT_ID}" \
  --update-env-vars="BACKUP_TYPE=manual"
```

### Local staging worker

```bash
cd SchoolIMS-Backend
export DATABASE_URL_DIRECT="postgresql://USER:PASSWORD@HOST:5432/postgres"
export BACKUP_ENCRYPTION_KEY="$(openssl rand -hex 32)"
export GCS_BACKUP_BUCKET=""
export BACKUP_DRY_RUN=true
node jobs/backup/src/index.js --type=manual --dry-run
```

Dry-run writes encrypted artifacts under `LOCAL_BACKUP_DIR` (default `/tmp/schoolims-backups`) and still records metadata if the database is reachable.

## 3. Scheduler

| Job | Cron | Timezone | Type |
|---|---|---|---|
| `schoolims-daily-db-backup` | `0 2 * * *` | Asia/Kolkata | daily |
| `schoolims-weekly-db-backup` | `0 3 * * 0` | Asia/Kolkata | weekly |
| `schoolims-monthly-db-backup` | `0 4 1 * *` | Asia/Kolkata | monthly |

Invocation is OAuth as `schoolims-backup-scheduler` with scope `https://www.googleapis.com/auth/cloud-platform`. The Cloud Run Job is not publicly callable.

## 4. GCS Lifecycle

Configured by `jobs/backup/deploy/gcs_lifecycle.json`:

| Prefix | Retention |
|---|---|
| `database/daily/` and `manifests/daily/` | 30 days |
| `database/weekly/` and `manifests/weekly/` | 84 days (12 weeks) |
| `database/monthly/` and `manifests/monthly/` | 365 days |
| `database/manual/` and `manifests/manual/` | 365 days |
| Incomplete multipart uploads | abort after 1 day |

Bucket also uses uniform bucket-level access, public access prevention, and 30-day soft delete.

## 5. Failure Investigation

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="schoolims-db-backup"' \
  --project="${GCP_PROJECT_ID}" \
  --limit=50 \
  --format="json"
```

Every log line for a run includes `backup_id`. Secrets are redacted by the pino logger.

| Stage | Typical cause |
|---|---|
| `DUMP_FAILED` | Wrong URL (transaction pooler :6543), expired DB password, network |
| `ENCRYPTION_FAILED` | Missing/invalid `BACKUP_ENCRYPTION_KEY` |
| `UPLOAD_FAILED` | Worker SA missing bucket `objectAdmin`, bucket name mismatch |
| `VERIFICATION_FAILED` | Size/MD5 mismatch; treat archive as unusable |
| `BACKUP_FAILED` | Metadata DB unreachable after dump, or unexpected exception |

A failed job stays `failed`. Retries create a new `backup_id` and a new object name.

## 6. Alerts

Conditions:

1. Backup failed
2. Verification failed
3. No successful backup for >26 hours
4. Size changed beyond `ANOMALY_THRESHOLD_PERCENT` (warning, not a failure)
5. GCS upload failure
6. Encryption failure

Channels:

- Structured Cloud Logging (`event: ALERT_TRIGGERED`)
- Founder Console banners and `backup_events`
- Optional `ALERT_WEBHOOK_URL` JSON POST

Size anomalies never mark the backup invalid.

## 7. Deploy

```bash
export GCP_PROJECT_ID=YOUR_PROJECT_ID
export GCP_REGION=asia-south1
export GCS_BACKUP_BUCKET="schoolims-db-backups-${GCP_PROJECT_ID}"

# Secret DATABASE_URL_DIRECT must already exist (same secret used by Cloud Build).
cd SchoolIMS-Backend/jobs/backup/deploy
chmod +x deploy.sh
./deploy.sh
```

The public API Cloud Build (`cloudbuild.yaml`) is intentionally unchanged. Backup image builds from `jobs/backup`.

## 8. Exact Commands: Real Backup

```bash
gcloud run jobs execute schoolims-db-backup \
  --region=asia-south1 \
  --project="${GCP_PROJECT_ID}" \
  --update-env-vars="BACKUP_TYPE=manual"

gcloud run jobs executions list \
  --job=schoolims-db-backup \
  --region=asia-south1 \
  --project="${GCP_PROJECT_ID}"
```

## 9. Exact Commands: Verify a Backup

```bash
# 1. Confirm job row
psql "$DATABASE_URL_DIRECT" -c \
  "SELECT backup_id, status, verification_status, file_size_bytes, checksum_sha256, storage_path
   FROM public.backup_jobs ORDER BY started_at DESC LIMIT 5;"

# 2. Confirm object is private
curl -I "https://storage.googleapis.com/${GCS_BACKUP_BUCKET}/database/daily/2026/09/example.dump.enc"
# Expect 401 or 403

# 3. Download with ADC (authorized) and hash
gcloud storage cp "$STORAGE_PATH" /tmp/check.dump.enc
shasum -a 256 /tmp/check.dump.enc
# Must match backup_jobs.checksum_sha256
```
