# SchoolIMS Database Backup & Disaster Recovery Architecture

## 1. System Overview

SchoolIMS stores all tenant data in one shared Supabase PostgreSQL database, partitioned by integer `school_id`. The backup subsystem is a **Layer 2** independent logical dump pipeline. It is not part of `simsapi.nexsyrus.com` and must never run inside the public Express API.

Isolation invariants:

1. No public `/backup` HTTP endpoint.
2. Execution is a private Cloud Run Job (`schoolims-db-backup`) that starts, runs one backup, writes metadata, and exits.
3. Restoration is never automatic. Production restore requires documented human approval.

This repository does not use Terraform. Infrastructure is provisioned with `jobs/backup/deploy/deploy.sh`.

---

## 2. End-to-End Flow

```
Cloud Scheduler (OIDC/OAuth via schoolims-backup-scheduler)
        ↓
Private Cloud Run Job (schoolims-db-backup, SA: schoolims-backup-worker)
        ↓
Backup Worker
        ↓
PostgreSQL / Supabase (DATABASE_URL_DIRECT, session/direct only)
        ↓
pg_dump -Fc --no-owner --no-privileges
        ↓
AES-256-GCM encryption (key from Secret Manager)
        ↓
SHA-256 + MD5 checksums
        ↓
GCS two-phase upload (.tmp → final object)
        ↓
Remote size + MD5 + SHA-256 verification
        ↓
JSON manifest
        ↓
public.backup_jobs / public.backup_events
        ↓
Founder Console (Nexsyrus SuperAdmin)
```

A backup is marked `success` only after remote verification and manifest write. `pg_dump` completing is not sufficient.

---

## 3. Layered Recovery Model

| Layer | Responsibility | Mechanism |
|---|---|---|
| **Layer 1** | Supabase managed backups / PITR | Native Supabase backups. This subsystem does not replace them. |
| **Layer 2** | NexSyrus independent GCS logical backups | Encrypted `pg_dump` archives in a private GCS bucket |
| **Layer 3** | Supabase Storage / files (future) | Student photos, documents, certificates. **Not included today.** |

> PostgreSQL backup is not a complete SchoolIMS backup. Storage objects are a separate future subsystem.

---

## 4. Components

| Path | Role |
|---|---|
| `jobs/backup/src/index.js` | Cloud Run Job entrypoint. One run, then exit. |
| `jobs/backup/src/backupRunner.js` | Stage machine and failure recording |
| `jobs/backup/src/pgDumpService.js` | `pg_dump -Fc` with password in `PGPASSWORD`, never argv |
| `jobs/backup/src/encryptionService.js` | AES-256-GCM file format `SCHLBACKUP` |
| `jobs/backup/src/gcsStorageService.js` | Private bucket upload, no overwrite |
| `jobs/backup/src/metadataService.js` | `backup_jobs` / `backup_events` |
| `jobs/backup/src/alertService.js` | Structured logs + optional webhook |
| `jobs/backup/src/restoreValidator.js` | Temporary-DB restore validation |
| `NexsyrusSuperAdmin/.../backups.js` | Founder Console metadata API (authenticated SuperAdmin only) |

---

## 5. Object Naming

Never overwrite a successful object. Collision-safe retry appends `_r{token}`.

```
gs://{GCS_BACKUP_BUCKET}/
  database/{daily|weekly|monthly|manual}/YYYY/MM/schoolims-db-YYYY-MM-DD-HHmmss.dump.enc
  manifests/{daily|weekly|monthly|manual}/YYYY/MM/YYYY-MM-DD-HHmmss.json
```

Backup IDs: `bkp_YYYYMMDD_HHMMSS` (UTC).

Type prefixes exist so GCS lifecycle can retain daily/weekly/monthly archives independently.

---

## 6. Multi-Tenant Recovery Boundary

Recovery is **not** per-database. All schools share one database. Future school-level recovery:

```
backup → temporary DB → select school_id → review → recovery package → human approval → controlled restore
```

Founder Console must not execute arbitrary production SQL.

---

## 7. Future: SchoolIMS Storage Backup

```
Supabase Storage → backup worker → encrypted GCS archive
```

Until that exists, disaster recovery of photos/documents requires a separate process.
