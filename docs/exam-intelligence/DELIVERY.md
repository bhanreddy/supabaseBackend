# Delivery and verification

**Enablement update — 16 November 2026:** At the user’s request, the feature migration was applied and all 10 existing schools were enabled and verified. No application deployment or grading-policy change was performed. See `verification/all-schools-enablement-20261116.json`.

## Working increments

**Foundation:** Existing `/admin/exam-analytics` route extended with a per-school opt-in, Command Centre, dated class/section analysis and comparison studio. Central backend eligibility, statistics and matching contract; original range chart uses the same model for enabled schools. School/year/type/exam/class/subject/baseline selectors are database-derived. Filters and workspace context survive drilldowns/back navigation. Published marks, entry, participation and actual zero remain distinct.

**Deep analysis:** Paginated/searchable/sortable learner records; all tied performers; Student 360 with actual subject marks, cohort benchmarks, class-mean deviation, compatible changes, three-assessment direction/persistent-failure evidence and observed score dispersion; bounded history/timeline; class/subject and student/subject matrices with numerical labels and a table alternative; exam/subject history cells; distributions, quartiles, pass/grade bands, matched growth and band migration. Different papers/cohorts carry explicit comparison warnings. Roster changes are separated from continuing learners gaining/losing valid results; same-date or reverse comparisons retain descriptive differences without temporal growth labels. Recorded historical enrollment is used instead of today's active roster.

**Action/reporting:** Deterministic evidence-backed attention rules; student or class support-cohort assignment, real owners, target date/objective, immutable evidence, private note history, later compatible follow-up and retained outcomes. Existing intervention storage/lifecycle is reused with leadership-only access and no notification dispatch. Owner/school saved views, unified academic search across exams/classes/subjects/assessment-time learners, scope pickers and server-side learner search. Formula-safe CSV, text-preserving Excel workbooks and branded school/class/comparison/student/support-plan PDF/print output through existing exporters. These are real API-backed flows; no fake chart values or TODO actions are included.

**Release refinement:** Additive idempotent SQL, schema readiness check, tenant/RBAC guards, minimal access auditing, audit-body redaction, private support RLS and legacy-reader protection; no-store responses; bounded matrices/details/exports; stale-request ignoring; per-instance rate/concurrency controls; isolated fixture and frontend tests; repository typecheck and web build; rollout/recovery instructions. Supported native device performance/accessibility still requires hardware QA.

## Reused code and changed files

Backend additions: `services/examIntelligenceModel.js`, `services/examIntelligenceService.js`, `routes/examIntelligenceRoutes.js`, `migrations/20261115_exam_intelligence.sql`, `tests/examIntelligence*.test.js`, `utils/testDatabaseGuard.js`, `utils/analyticsPrivacy.js`, and this documentation/verification directory.

Backend integration: `routes/resultsRoutes.js`, `middleware/schoolId.js`, `middleware/audit.js`, scoped URL-log redaction in `middleware/auth.js`/`server.js`, `scripts/migrate_release.js`, `db.js`, and private-row filters in `services/intelligence/{interventionService,insightEngine,schoolIntelligenceService}.js` and `services/anecdote/anecdoteService.js`. Existing unrelated attendance/calendar edits were retained.

Frontend: `app/admin/exam-analytics.tsx`, `src/features/exam-intelligence/{ExamIntelligenceScreen,WorkspacePanels,IntelligencePrimitives,LegacyExamAnalyticsScreen}.tsx`, `DeeperAnalysis.tsx`, semantic `palette.ts`, `src/services/examIntelligenceService.ts`, `src/utils/examIntelligenceExport.ts`, `src/__tests__/examIntelligence.test.tsx`. Existing AdminHeader/theme/API client/Expo Router/tour targets, marks-total/ranking helpers, SheetJS and print/share libraries are reused. No package/dependency changes were made for this work.

## Data-dependent capabilities

- Historical teacher assignment periods/reassignment evidence are missing; current teachers are never attributed to past marks. Teacher outcome matrices, matched teacher-assignment review and assignment scatter plots are unavailable until this source exists.
- OMR already links question responses to exam papers through `omr_exams.exam_subject_id`, and the existing OMR workspace retains item analysis under its own permissions. Its question keys lack validated chapter/competency mappings, so no mastery or competency radar is fabricated. A new contextual OMR drilldown is not included in this increment.
- Independent verification records, reliable entry deadlines and historical policy snapshots are absent. Verified completion, overdue-by-deadline claims, paper-difficulty assertions and historical-policy equivalence are not calculated. Distinction requires administrator configuration.
- General elective eligibility must be confirmed from source registers. Unknown eligibility suppresses overall results/ranks; it does not silently infer a full required subject set.

## Explicit remaining scope

The pilot requires staging/hardware validation and source confirmation before a full release. Unified academic search, same-year class subject trends, individual comparisons, student/support PDF sections, support timeline, min–max-whisker box plots, configured next-grade borderline evidence and recorded-publication/identical-mark review rules are implemented. Grade-boundary and pass-margin calculations stay in the backend. History/trend explorers are bounded to eight assessments; initial summaries do not mount every chart.

Still unavailable: teacher/assignment comparisons and sparse teacher matrices without historical assignments; chapter/competency mastery without mappings; overdue-by-deadline rules without reliable deadlines; independently verified completion; historical policy equivalence; and representative device/3G/keyboard/screen-reader QA. Direct contextual integration into the existing OMR workspace is not included; its item analysis remains available under its own permissions. Large matrices are bounded/paginated rather than exposing an unbounded fully virtualized spreadsheet. Reports use readable numerical heatmap tables; bitmap heatmap export is not added. These are explicit limitations, not implemented features.

Core analysis → learner investigation → support assignment → later outcome review is implemented. Do not silently enable the pilot as a fully verified production release.

## Verification record

See `verification/README.md` for final commands, pass counts, measured payloads and the remaining release checks. The final focused run passed 90 backend tests and 15 frontend tests, TypeScript, feature lint and the web build. Local fixtures include two schools, three examinations with 25/100/50 maxima, saved zero, absence, exemption, pending, withheld, tied maxima, unpublished results, entrants/leavers, inactive historical enrollment, grading boundaries, weights and publication revision. A larger disposable workload includes 1,213 learners and 9,613 scheduled results. No production benchmark or mobile-frame-rate claim is made.

### Test-run incident — requires operator review

The first broad `npm test` run invoked existing unsafe integration suites against the configured database, using hardcoded school IDs and an arbitrary existing student. This was an execution mistake, not part of the exam implementation. The run was stopped after detection. Do not describe this task as having used local fixtures exclusively.

Confirmed generated artifacts were checked against exact IDs, payloads and the test time window, then removed transactionally:

- School 13: generated admission student/parent/two people, enrollment, fee assignment, link and two contacts; no fee payments or user accounts were attached. The suite had deleted the application itself. Admission number `ADM/26/0038` remains a counter gap; the counter was not decremented.
- School 20: generated anecdote, intervention, its outcome, three new intelligence metric caches and one new signal. A generated in-app notification/event were soft-deleted and expired; no notification-delivery rows were found. A notification already seen cannot be recalled.
- School 17: two generated, archived document templates.
- School 13: a generated paid-status general expense of ₹14,200 left behind by an event test. Its title, amount and creation/update timestamps matched the test payload; it was removed.

One **pre-existing School 20 student-intelligence profile** was refreshed by the legacy test. Its active-intervention count was corrected from actual remaining records after cleanup. Other refreshed cached values were retained because no pre-run before-image is available; an exact restoration of that cache cannot be claimed.

The School 1 feature-access tests also perform upsert/delete and pre-test deletion on these keys, without saving prior state: school override `fees`; user override `analytics`; access request `advanced_reports`; notification subscription `ai_predictive_enrollment`, for the hardcoded user in `tests/featureAccessService.test.js`. Those rows were absent after the tests' cleanup. Whether any pre-existing values were overwritten/deleted **cannot be established from this run**. Do not restore guessed values. Review a suitable pre-run backup/audit history with the operator; the affected keys are listed in `verification/incident-remediation.json`.

Content/event/backup fixtures had their own cleanup; a bounded time-window audit found no remaining created content, content audit, event vendor/audit or backup-job rows and no pre-existing content updates in that window. This is not a guarantee that unknown prior feature overrides were restored.

The new `db.js` guard now refuses remote/non-isolated databases from Node test workers; a direct guard check confirms rejection before database-client construction. Further feature tests use a dedicated localhost database and independently enforce its URL. The broad suite reported 868 passes, 20 failures, 6 cancellations and 4 skips; it is **not passing**. Full frontend lint reports 59 errors and 611 warnings outside the exam feature files; those unrelated workspace issues were not silently repaired.
