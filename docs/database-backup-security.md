# SchoolIMS Database Backup Security

## 1. Secrets

Backup secrets live in Google Secret Manager, not Git, Dockerfiles, frontend bundles, or Founder Console tables.

| Secret | Purpose |
|---|---|
| `DATABASE_URL_DIRECT` | Session/direct Postgres URL for `pg_dump` (not port 6543 pooler) |
| `BACKUP_ENCRYPTION_KEY` | 32-byte AES-256 key (64-char hex recommended) |
| `BACKUP_TRIGGER_SA_JSON` | Founder Console host secret for `schoolims-backup-console` |

`pg_dump` receives the password via `PGPASSWORD`. It is never placed on the process argv. Manifests and pino logs strip password/token/secret/key/credential/database_url fields.

If a committed credential is ever found in this repo, stop and rotate. Do not copy the insecure pattern.

## 2. Encryption

Current production mode: **AES-256-GCM** with a DEK stored in Secret Manager.

- Random 12-byte IV per backup
- 16-byte authentication tag
- File header `SCHLBACKUP` + version `0x01`

Cloud KMS envelope encryption is optional next hardening (`schoolims-keyring` / `schoolims-backup-key`). It is not required for the first production layer because Secret Manager already holds the DEK and IAM limits who can read it. Format version `0x01` is Secret Manager DEK; a future `0x02` can wrap the DEK with KMS without changing GCS layout.

The DEK is never written to `backup_jobs`, manifests, or Founder Console.

## 3. IAM (Least Privilege)

| Identity | Binding | Why |
|---|---|---|
| `schoolims-backup-worker` | `roles/storage.objectAdmin` **on the backup bucket only** | Write final objects, delete `.tmp` staging objects |
| `schoolims-backup-worker` | `roles/secretmanager.secretAccessor` on `DATABASE_URL_DIRECT` and `BACKUP_ENCRYPTION_KEY` only | Read dump credentials and DEK |
| `schoolims-backup-scheduler` | `roles/run.invoker` on job `schoolims-db-backup` | Cloud Scheduler authenticated execute |
| `schoolims-backup-console` | `roles/run.invoker` on job `schoolims-db-backup` | Founder Console manual trigger |
| Founder / SuperAdmin | SuperAdmin JWT + `super_admins` / `founders` row | Read metadata, trigger job. No SQL, no keys |

Do not use Project Owner / Editor for these identities. Do not grant `roles/storage.admin` at project scope.

The Cloud Run Job has no unauthenticated invoker. Verify:

```bash
gcloud run jobs get-iam-policy schoolims-db-backup --region=asia-south1 --project="${GCP_PROJECT_ID}"
# Must not contain allUsers or allAuthenticatedUsers
```

## 4. GCS Bucket Lockdown

```bash
gcloud storage buckets describe "gs://${GCS_BACKUP_BUCKET}" \
  --format="yaml(iamConfiguration.publicAccessPrevention,iamConfiguration.uniformBucketLevelAccess)"

curl -I "https://storage.googleapis.com/${GCS_BACKUP_BUCKET}/database/daily/2026/09/example.dump.enc"
# Must be 401 or 403
```

Required settings (applied by `deploy.sh`):

- Uniform bucket-level access
- Public access prevention
- 30-day soft delete
- Lifecycle rules (see operations doc)

## 5. Database Metadata Access

`backup_jobs`, `backup_events`, and `backup_settings` have RLS enabled and **no** `anon` / `authenticated` grants. School app JWTs cannot read backup metadata through PostgREST.

Founder Console and the backup worker use direct Postgres connections as privileged roles (RLS is not FORCED on these tables).

Do not store secrets in these tables. `backup_settings` holds schedule/retention/threshold JSON only.

## 6. Founder Console Authorization

All `/api/super-admin/backups*` routes use `verifySuperAdminMiddleware`. There is no unauthenticated backup trigger. Manual trigger only starts the trusted worker; it cannot pass a database URL, SQL, or encryption key.

## 7. Restore Audit

Restore tests are operator-run (`scripts/restore_test.js`). Production restore is documented, multi-person, and not exposed as a UI action.

## 8. Incident Response

1. Treat a failed or unverified backup as missing. Do not restore it.
2. If `BACKUP_ENCRYPTION_KEY` leaks, stop scheduling, rotate the secret, and keep old archives decryptable with the previous version until they expire.
3. If the GCS bucket IAM is opened to `allUsers`, immediately restore public-access prevention and rotate the DEK after assessing exposure.
4. If `DATABASE_URL_DIRECT` leaks, rotate the database password in Supabase and Secret Manager.
