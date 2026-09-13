# SCHOOLIMS v4.1.8 — BATCH 1 PRODUCTION READINESS

Verification date: 5 September 2026. This document supersedes the release verdict in `BATCH1_AUDIT_REPORT.md` for the Phase 0–3 Batch 1 changes only.

## Release verdict

**Batch 1 is ready for a controlled deployment after its reviewed database upgrade is applied.** The application code, migration path, clean-install path, financial recovery behavior, regression suites, web build, dependency installation and deployment guard have passed. The configured production database has not been changed and currently fails the new read-only schema check because the Batch 1 migration is not installed.

The complete dirty working tree is not a single certified release artifact. It also contains concurrent Attendance Risk, Leave/Substitution, Transport Safety, UDISE and Help Desk work outside the requested Phase 0–3 audit. Prepare the Batch 1 release from reviewed Batch 1 paths or independently certify those later-phase changes before shipping the whole tree.

## Closed release blockers

- **Reproducible database initialization:** `migrations/baselines/20260905_public_schema.sql` is a schema-only PostgreSQL 17 baseline captured from the configured deployment schema. It contains no table rows or customer records. A checksum manifest prevents silent edits, and a small explicit seed restores required reference values.
- **Fail-closed release migration:** `scripts/migrate_release.js --init` initializes only an empty application schema with the required Supabase auth platform. `--upgrade` applies the reviewed forward migration. `--check` verifies the required column, three valid recovery indexes, internal-table access restrictions and reference data. Transaction-pooler connections are rejected.
- **Unsafe historical bootstrap removed:** `scripts/run_all_migrations.js --bootstrap-live` now refuses to run, and Batch 1 migrations must use the dedicated runner. A failed migration is no longer recorded as applied.
- **Deployment ordering enforced:** Cloud Build runs the release schema check before image push and Cloud Run deployment. `/api/v1/readyz` returns HTTP 503 with `database_schema: migration_required` when the running code's schema prerequisites are missing.
- **Frontend validation repaired:** the normal test command runs the Jest and Node test groups correctly, Expo SDK 54 dependencies are aligned, repository lint has no errors, type checking passes and the production web export succeeds.
- **Dependency exposure reduced:** production audits report zero high and zero critical advisories in both repositories. Remaining advisories are moderate transitive toolchain findings.

## Verification evidence

| Check | Result |
|---|---|
| Fresh release initialization, then upgrade and check on an empty local PostgreSQL database | PASS |
| Required reference seed and new-school trigger defaults | PASS |
| Initialization refusal on a non-empty untracked application schema | PASS |
| Disabled historical `--bootstrap-live` path | PASS |
| Production-shaped fee recovery integration against the full schema | 26/26 PASS |
| Backend test command | 136/136 PASS |
| Frontend Jest suites | 21 suites, 230 tests PASS |
| Frontend Node test suites | 8/8 PASS |
| Frontend TypeScript | PASS |
| Frontend ESLint | PASS with warnings; zero errors |
| Expo dependency compatibility check | PASS |
| Expo production web export | PASS |
| Clean production dependency install in both repositories | PASS |
| Production dependency audit | Backend: 0 high/critical; frontend: 0 high/critical |
| Docker image build | Not executed: the local Docker daemon was unavailable |
| Configured production schema check | Expected FAIL: Batch 1 migration is not deployed |

The integration suite exercises paid, partial, concession, refund/reversal, adjustment, waived and corrupt-value cases; tenant and role boundaries; cooldown/idempotency races; provider outcomes; pg-boss startup/retry/stop behavior; and a 1,000-row recovery scan. The full-schema scan completed in about 61 ms in the local verification environment. This timing is evidence against a query-plan regression, not a production latency guarantee.

## Notification verification

For `school_id=1`, the supplied login resolved to one active user, one recently active device and one linked student. Exactly one narrowly targeted production-verification notification was sent through the existing tracked sender. The provider result was one success, zero failures, and the database contains one matching `DELIVERED` record. This verifies the server-to-provider path and recipient isolation. Handset display still requires confirmation from the recipient.

## Payment verification boundary

No real payment or refund was initiated. Doing so would create an external financial transaction, and no sandbox gateway/environment was identified. Payment, reversal, concession and adjustment effects were verified against the real ledger schema and triggers in isolated PostgreSQL. A gateway round trip remains an environment acceptance check rather than a code blocker for this Batch 1 recovery release.

## Controlled deployment procedure

1. Freeze a reviewed Batch 1 release revision and take the normal production backup.
2. Run `DATABASE_URL_DIRECT=... npm run migrate:release -- --upgrade` from the backend release image or matching revision, using a direct/session PostgreSQL connection.
3. Run `DATABASE_URL_DIRECT=... npm run migrate:release -- --check`; do not continue unless it returns `ready: true`.
4. Build and deploy the backend. Confirm `/api/v1/readyz` returns HTTP 200 with `database_schema: ready`.
5. Deploy the matching frontend and perform the Accounts recovery smoke test with fee automation still disabled.
6. Enable fee recovery scheduling for the intended schools only after the smoke test, then monitor execution outcomes and provider delivery reports.

Rollback of the application should use the preceding application revision. The additive database migration can remain in place; removing its column or indexes during an incident would add risk and is not required to run the preceding code.

## Release boundary

This certification covers the Batch 1 migration/baseline tooling, fee recovery API and services, financial event integration, queue integration, permissions, tracked notifications, Accounts recovery UI, and the release checks described above. It does not certify the concurrent Phase 4+ features, a native Android/iOS binary, physical handset presentation, a real payment-gateway transaction, or a deployed Cloud Run revision.
