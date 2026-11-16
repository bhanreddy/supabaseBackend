# Install, pilot and recovery

Initial implementation delivery did not enable schools, deploy applications or apply the feature migration. On 16 November 2026, at the user’s explicit request, the dedicated Exam Intelligence migration was applied to the configured database and the feature flag was enabled and verified for all 10 existing schools (including inactive schools). Existing grading/eligibility policies were preserved. See `verification/all-schools-enablement-20261116.json` for the prior values and committed verification. No application deployment was performed as part of that flag change. New schools still use the absent-flag disabled default. The new API rejects enablement until its schema is ready. The existing analytics screen remains accessible from the upgraded route.

## Prerequisites

Use the existing application backend and frontend, not the unversioned ManaSchool copy. Existing dated-enrollment, component-maximum, per-section paper, result-publication, grading-scale, school-settings, audit and student-intervention migrations must already be installed. The new SQL references these established tables; it does not reconstruct them or reinterpret marks.

Review the normal backup and release process in the repository. Apply the additive migration using the existing runner on a staging clone first:

```sh
node scripts/migrate_release.js --exam-intelligence
```

The runner uses its existing configured direct/session connection, transaction, advisory lock and migration ledger. This command is an operator deployment action, not a test command. It adds:

- Nullable `marks.analytics_result_state`, with a state constraint and no backfill.
- Academic context, objective and progress history on existing student interventions.
- Private owner/school-scoped saved views; authenticated/anonymous direct access revoked.
- Restrictive RLS for academic intervention rows, plus backward-compatible filtering in older intervention/anecdote/intelligence APIs so leadership notes do not leak to those surfaces. Backend owner/service-role access is required, as in the existing application. Existing direct REST intervention clients should be checked on staging: tables without a permissive policy now deny direct access; API workflows remain the supported path.
- Active paper, dated enrollment, year/exam and academic-action indexes. They are ordinary transactional indexes, not concurrent indexes; assess lock time on a representative staging clone and use the existing release maintenance window. Migration lock timeout is 5 seconds. Rollback on contention, do not force blocking production index creation.

`--init` and `--upgrade` also include the migration after their prerequisites. No flag is seeded/enabled automatically. Existing rows, marks-entry endpoints, final reports and result publication remain unchanged.

## Pilot steps

1. Deploy the compatible backend with the flag absent/false. Verify original marks entry, publication and exports on staging. Deploy the frontend using the normal Expo/native/desktop release workflow; no new dependency or infrastructure is required.
2. Use the existing `admin.manage` authorization. Principals/academic managers require the same explicit permission as the old analytics screen; do not widen roles automatically.
3. Open `/admin/exam-analytics`. Enable the school pilot only after schema readiness. This invokes `PUT /results/exam-intelligence/configuration` with `{ "enabled": true }`, scoped to verified active context/user school. Request school_id cannot select another school.
4. Inspect dated enrollment and subject offerings against real assessment registers. Default overall eligibility is **not confirmed**. Configure validated policy under Reports & views; see `METRICS.md`. Confirm required subjects separately by grade where appropriate. Do not use confirmation to hide missing source data.
5. Compare independently calculated sample classes, zero/absence cases, 25/100 papers, partial publication, transfers and ties. Review grade gaps, low-sample notices and exports. Verify teachers without leadership permission cannot open these endpoints or academic support notes through legacy APIs.
6. Enable additional schools individually only after leadership review. Record response times, 429/422/503/500 rates, data-quality counts and payloads using existing HTTP/audit logs; logs do not need marks or private notes.

## Recovery

Disable the school pilot in Reports & views or `PUT .../configuration` with `{ "enabled": false }`. Disabled enhanced endpoints deny reads/writes; the existing analytics screen remains available. Revert the frontend/backend release if necessary **after disabling pilots**, retaining additive columns/tables and evidence. Do not drop support history or rewrite source marks as a rollback step. Before reverting an older backend, preserve the added privacy guards on legacy intervention readers so new leadership plans remain private.

## Operational limits

- Each fresh workspace reads a repeatable-read, read-only transaction with an 8-second per-statement timeout. Mutations use the existing transactional database path; evidence and batch support plans are written atomically. No persistent analytics cache/job/report storage is added.
- Maximum 50,000 scheduled result cells per snapshot; return an explicit 422 and request a narrower class scope above this limit. Student detail is <=50 rows/page (UI 25), history <=8 exams, subject table <=25 cohorts/page, distribution panels <=6 cohorts/page, class matrix <=10×8 mounted cells/page, student matrix one page, saved views <=50/account, actions <=50/list, group assignment <=50 students, student export <=1,000 learners.
- 60 requests/minute per user/school and four in-flight requests per school per Node instance, in addition to existing application rate limits. These local concurrency limits are not a distributed global limiter. Monitor actual multi-instance load before increasing scope.
- CSV is UTF-8 with BOM and formula neutralization. Import identifier columns as text in spreadsheet applications; Excel workbook export preserves admission-number strings directly. PDF uses the existing platform print/share pipeline with tenant school name/address. Native temporary CSV/XLSX/PDF files are removed after sharing. No automatic external notifications are sent by the analytics/support workflow.
- Overview metrics always retain the full selected exam/class scope; subject filters apply detail panels. Applicable filter values and workspace names live in safe URL parameters for drilldown/back navigation. Views store only validated filters and are reauthorized on opening.
- Source changes appear on the next request. Open screens display their as-of time and refresh explicitly. There is no push-driven live update or sensitive offline cache.

## Safe tests

Never point tests at the configured school database. `db.js` now rejects non-local or non-`_test` database names from Node test workers. The new integration suite independently requires `EXAM_INTELLIGENCE_TEST_DATABASE_URL` to be localhost/127.0.0.1 and end in `_exam_test`; it recreates its scratch schema. Do not set it to a database you want to keep.

Use a disposable local PostgreSQL database and run:

```sh
DATABASE_URL=postgres://localhost/schoolims_exam_test \
EXAM_INTELLIGENCE_TEST_DATABASE_URL=postgres://localhost/schoolims_exam_test \
node --experimental-test-module-mocks --test tests/examIntelligence.test.js tests/examIntelligence.integration.test.js
```

The application test script historically includes unrelated remote-database tests with hardcoded school IDs. Do not bypass the guard to run them against school systems. Focused existing marks/rank/publication tests can run with the same isolated DATABASE_URL.
