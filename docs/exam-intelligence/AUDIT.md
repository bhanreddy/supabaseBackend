# Phase 0 — Exam Intelligence audit

Repository evidence, 15 November 2026. Phase 0 used repository evidence only. A later unrelated test-run incident is documented in DELIVERY.md; no exam-feature migration or deployment was applied to the configured school database. This audit describes checked-in schema and code; live data quality is not verified. No applicable AGENTS.md or agent.md was found in the workspace or its ancestor directories. Existing unrelated working-tree edits are preserved.

## Architecture and decisions

- Canonical projects: `SchoolIMS-Backend` (Express 5, postgres.js, Supabase identity, Catalyst deployment) and `SchoolIMS-Frontend` (Expo 54, React Native 0.81, Expo Router; Android/iOS/web and Tauri scripts). `ManaSchool-Frontend` is a separate unversioned copy, not the canonical application.
- Reuse `/admin/exam-analytics`, its existing navigation permission `admin.manage`, shared API client, AdminHeader, theme, app-tour targets and installed chart/export libraries. No dependency or infrastructure addition is needed.
- `middleware/auth.js`, `middleware/schoolId.js`, `server.js` already verify users, resolve an active school, and enforce permissions. `docs/SCHOOL_ID_CONTRACT.md` conflicts with current code and the user's instruction by calling request school_id authoritative. For these endpoints use verified active context/user school exclusively; echo the trusted tenant using `sendSuccess`.
- `schema.sql` defines dated `student_enrollments`, exam/year and paper/class/optional section, mark uniqueness `(school_id, exam_subject_id, student_enrollment_id)`, school-scoped grading scales, and current-only `class_subjects.teacher_id`.
- `services/marksTotalsService.js` resolves active component totals and EVS/Science alternatives; existing progress reports use obtained/maximum totals, preserve saved absences and exclude missing. `services/finalResultCalculationService.js` has separate FA/SA/annual contribution rules. Analytics must label single-exam totals and must not replace final-report calculations.
- `services/resultRankingService.js` supports competition/dense/attendance tiebreak; `school_settings.result_ranking_method` stores choice. Reuse it; suppress rank where attendance tiebreak or completeness evidence is unavailable.
- `migrations/20260807_exam_result_publication.sql` and `services/examResultPublishingService.js` implement explicit publication, readiness and publication locks. `utils/examResultVisibility.js` makes some nongated types visible to families without publication; analytics achievement defaults remain explicitly published results. Completed, locked and timetable-published do not imply results-published.

## Gap matrix

| Requirement | Status | Evidence | Proposed change | Dependency |
|---|---|---|---|---|
| Existing analytics workspace/API | Partial | `app/admin/exam-analytics.tsx`, `src/services/examAnalyticsService.ts`, backend `routes/resultsRoutes.js:1418–1730` | Extend existing route and screen behind a per-school rollout flag; retain legacy screen | None |
| Valid, published-only achievement | Broken | Existing aggregate ignores publication and score range; rounded AVG and percentages | One backend contract with explicit states, ranges, exclusions and provenance | None |
| Zero vs absent/pending | Partial | `marks.is_absent`, nullable scores, component fields; no dedicated exempt/withheld states | Preserve old fields; additive nullable analytics status for explicit exceptional states; never infer from free-text remarks | Safe migration; historical states require authorized correction |
| Median/spread/quartiles/ties/grades/pass | Missing | Current API exposes only min/mean/max | Central tested statistical functions; configured school grades and per-paper pass marks; full ties in paginated detail | Grading gaps/overlaps suppress affected grade claims |
| Year/type/class/subject filters | Partial | Context chooses current year; exams are DB values; no year/type filter | DB-derived year and dynamic exam-type selectors, dependent validation, URL filter context | None |
| Historical student cohort | Broken | Both selector and report filter active students/enrollments | Resolve enrollment on paper date, falling back to exam date with notice; no current-status filter | Dates absent/overlapping: suppress uncertain rows and report exclusions |
| Subject choices | Partial | `marksTotalsService.js`, `scienceSubjectSelection.js`; no general dated student subject-choice model found | Reuse alternative-subject selection; require explicit eligibility confirmation for complete overall/rank claims | General elective eligibility requires source data |
| Weights/overall completeness | Broken | Current student summary averages available subject percentages | Complete single-exam total using existing paper-total rules; optional explicit subject weights; final-term results remain separate | Confirm required subjects; no inferred final-term weighting |
| Matched comparison/growth | Missing | Current endpoint has one exam only | Match student identity across dated enrollments; compatible subject/schema/grade/policy checks, normalized deltas, entrants/leavers and coverage | Syllabus/format/accommodation equivalence generally unrecorded; normalized comparisons carry limitations |
| Student 360 | Partial | One student overlay against class min/mean/max | Subject benchmark/deviation, compatible history, three-point trend evidence, timeline and actions | Actual mapped history only |
| Teacher outcomes | Missing | `class_subjects` has current teacher, no effective assignment period | Show contextual outcomes only for recorded historical assignment evidence; never infer current teacher | Historical teacher assignment source required |
| Chapter/question/competency | Partial, disconnected | OMR service and `omr_exams.exam_subject_id` link item responses to papers; OMR question keys have no validated chapter/competency links | Report unavailable in exam workspace; no synthetic mastery/radar | Validated response-to-paper/curriculum links |
| Attendance | Exists | `daily_attendance`, student-attendance calendar changes already in progress | Bounded assessment-period attendance context, no causal claim | Recorded attendance; do not modify ongoing calendar work |
| Deterministic insights | Partial, separate domain | `services/intelligence/insightEngine.js` supports anecdote signals | Recompute exam rules from fresh scoped snapshot; stable IDs, evidence and filters; no narrative AI | Configurable thresholds |
| Support actions | Exists, needs context | `student_interventions` and `routes/interventionRoutes.js` | Reuse student intervention storage, add academic evidence/objective/follow-up context; dedicated leadership authorization | Existing intervention migration |
| Saved views/search | Missing for exams | Existing selector downloads current-class students | Owner/school-scoped saved filter views and bounded server-side search/detail | Migration |
| Exports | Exists, needs extension | `utils/resultWorkbooks.js`, `utils/assessmentMarksPrint.js`; frontend `pdfGenerator` and substitution exports | Bounded evidence export, UTF-8 CSV formula protection and existing branded print pipeline | Device/export QA |
| Access audit/cache | Partial | Global audit logs mutations/admin paths; exam GET isn't admin path; client caches elsewhere | Explicit minimal access audit; no-store analytics, coherent read transaction; avoid stale materializations | No new cache/job needed |
| Performance/accessibility | Partial | Existing screen scrolls all class selector students, 700ms chart animation, tiny controls | Paginated searchable student detail, bounded heatmaps, accessible number/table alternatives, >=44px controls, immediate values | Device profiling remains to be measured |
| Indexes | Partial | School, enrollment and paper indexes; mark unique index; dated enrollment exclusion | Composite active paper/year/enrollment indexes, evaluate query plans on local fixtures | Representative school workload |
| Feature flag | Exists via settings | `school_settings` and other per-school rollout keys | `exam_intelligence_enabled`, default false; safe fallback | Admin-controlled pilot |

## Data-quality findings and limits

No live school records were inspected. Counts of invalid marks, duplicate/orphan rows, literal `Null` strings, stale maps and revisions cannot be asserted from source. Existing uniqueness/FKs reduce but do not prove absence of anomalies. The upgraded snapshot reports invalid maxima/ranges, invalid status payloads, ambiguous dated enrollments, unknown eligibility and grading gaps. Published-mark locks already exist; revisions without an audit trail cannot be reconstructed. Do not rewrite marks or backfill guessed historical status/assignment data.

Teacher-entry timeliness requires submission deadlines and entry timestamps; timestamps exist but reliable deadlines were not established. Verification completion lacks a distinct verification record. Distinction has no established configurable threshold in the inspected analytics path: display unavailable unless configured. No confidence intervals, predictions, causal teacher scores or disciplinary actions will be produced.

## Sequence and API/schema proposal

1. Foundation: pure tested backend metrics/state/comparison contract; extend existing context; scoped snapshot service and indexes; command/class/core comparison integrated in the existing screen.
2. Deep analysis: backend student history and paginated records, shared accessible heatmap, distributions and matched growth. Expose historical teacher dependency rather than current-teacher attribution.
3. Actions: reuse intervention storage with academic context/objective and note history, owner-scoped saved filters, evidence exports and deterministic attention feed.
4. Verify/rollout: local isolated two-school fixtures, migration idempotence, tenant attacks, lifecycle/revision checks, frontend integration/type/lint/build checks and performance measurement. Record every unexecuted check.

Additive tables/columns only: nullable `marks.analytics_result_state`; `student_interventions.academic_context`, objective and progress history; private saved views. School settings hold opt-in and analytics policy. Existing marks entry/publication/final-report logic is unchanged. New endpoints nest under `/results/exam-intelligence`; existing `/results/exam-analytics` remains compatible while trustworthy calculations are corrected additively.

Use repeatable-read, read-only snapshots with a statement timeout, bounded exam/class scope and separately paginated rows. No persistent metric cache, external storage or new queue means edits, publication, enrollment and policy changes are reflected on the next request without stale-cache races. Freeze evidence snapshots only for actions and label their capture time.

Rollout defaults: disabled per school; minimum group sample 10; achievement published only; publication preview is never silently enabled; raw-paper totals only for confirmed complete subject eligibility; no inferred distinction or teacher attribution. No consequential ambiguity blocks implementing these defaults.

Initial budgets (targets, not measured): summary <=40KB gzip; paginated records <=50 students/request; bounded matrix <=50 rows; <=2.5s cached shell on documented throttled 3G; smooth target-device scrolling. SQL timing, payload size and limits will be measured locally; Android/iOS hardware/3G compliance is not presumed.
