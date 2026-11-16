# Student attendance and synchronized calendars

Implemented in SchoolIMS and ManaSchool with the shared authorized backend. Existing school branding and the card layout are retained. Schools opt in individually; the migration does not enable any school.

## Authoritative sources

- **Examinations:** published `exams` / `exam_subjects` from the Exam Timetable. Section-specific papers override class-wide papers for the same subject using the timetable's existing selection rule. Draft, unpublished, cancelled and deleted papers are excluded.
- **Academic activities, holidays, closures and special working days:** published `calendar_events` and `calendar_event_targets` from the Academic Calendar. Recurrence, school timezone and historical class membership apply.
- **School events:** published or subsequent public lifecycle states in `events` and `event_audience_targets` from the Events Calendar. Draft, approval-only, cancelled and deleted events are excluded. Staff-only and unrelated class audiences are excluded.

These sources are read in one repeatable-read database snapshot for monthly calendars, range reports, annual totals and paginated activity browsing. Existing EXAM/EVENT calendar copies are excluded to prevent duplicates or stale copies reappearing after unpublishing. Source event identifiers are namespaced and returned as metadata. Event attendance never substitutes for daily student attendance.

Edits and cancellations appear on the next authorized fetch. Both apps refresh on focus, reconnect, foreground activation and pull-to-refresh, and every 30 seconds while the attendance screen remains visible. This is bounded polling, not a websocket delivery guarantee. Offline cached data shows its generation time. Account, school, portal context, student, academic year and date query scope isolate the caches.

Exam publication keeps existing synchronization for other calendar consumers. Enhanced schools use the durable calendar notification queue for paper publication/change/cancellation, honoring school exam settings, quiet hours and user preferences, instead of sending an additional legacy publication push. Existing absence alerts are unchanged.

## Previously released frontend compatibility

The backend supports existing installed SchoolIMS/ManaSchool clients alongside the new release. New UI features need the new app bundle; existing screens do not require an app upgrade to continue operating.

Code may be deployed before this feature's database migration. Existing calendar reads use safe defaults when override columns are absent; legacy event writes omit those columns, and legacy corrections write an audit transaction without requiring the new correction column. The enhanced alert worker waits for its storage. Capabilities report `schema_ready: false` and `enabled: false` until the complete feature schema exists, even if a rollout setting was enabled prematurely. Policy writes and explicit holiday overrides return an actionable migration-required response instead of a database error. No migration runs implicitly during a normal request.

- `GET /students/:id/attendance` (including `me`) retains the original `{summary, records, meta?}` payload inside the existing success/school envelope, descending history, paging/default limits, raw status vocabulary, summary fields and legacy calculation semantics. It accepts empty historical months and cross-academic-year ranges. The new report's one-year/370-day restrictions do not apply to this existing route. New classification, effective-policy summaries and report metadata are available on the additive `/calendar` and `/report` routes.
- `POST /attendance` still accepts both `records` and `attendance`, the same session fields and retry behavior. Session rollup and `DELETE /attendance/day` remain compatible.
- `PUT /attendance/:id` accepts the previously released `{status}` payload. Missing explanations are explicitly audited as `Legacy client correction; no reason supplied`, with the authorized actor and previous/new values. A supplied reason is validated and retained. New strict clients can use `PUT /attendance/:id/correction`, which requires a nonempty reason. Existing permissions and school isolation apply to both paths.
- Existing `/calendar` calls retain array responses, date aliases, `month=YYYY-MM`, separate `year`/`month`, and legacy display aliases such as `all_day`, `affects_attendance`, `affects_timetable`, `source_id`, and timetable/day-status names. Older serialized JSON recurrence/attachment/reminder fields and modern object/array inputs are normalized to the same stored JSON. Partial edits preserve applicability and new override fields that an older form does not send.
- School working-day protections, publication conflict checks and authorization apply consistently to every app version. Compatibility does not let a client override an emergency closure or access another student's data.

SQL/HTTP compatibility tests exercise previous frontend request formats with school rollout both disabled and enabled, including parent access, multi-year history, empty months, corrections, teacher morning/afternoon submissions and retries, clearing a day, month queries, serialized recurrence and time-only calendar edits. Production installation checks with actual previous-release devices remain part of the pilot.

The regression suite also starts with the old database schema before applying the feature migration, then tests the dashboard's calendar/upcoming queries, legacy event creation/updates, policy discovery, audit-backed corrections and alert worker behavior without the new tables or columns. It checks readiness again after migration in the same process.

## Release

1. Back up the database and verify the existing academic-calendar, section-exam timetable and premium-events migrations are installed. Use the existing release migration runner with a direct/session database connection.
2. Apply **only** this feature's migration with `node scripts/migrate_release.js --attendance-calendar`, or include it in the regular `--upgrade`. Enable schools after the migrated backend and new administration UI are available; parents on previous app versions can continue using their existing screens.
3. Deploy the backend and both frontend releases through the normal release process. The migration and production deployment have not been executed as part of local development.
4. Open Admin → Academic Calendar → Attendance settings (`/admin/attendance-calendar-settings`). Set the school timezone through existing school settings, effective working week, half-day weight, teacher visibility, optional submission cutoff, exam/holiday alerts and quiet hours. Explain the change and enable the enhanced calendar for the pilot school.
5. Pilot at Geethanjali High School. Compare the same student's calendar, monthly/yearly/range summary and exported PDF against the register, published timetable, Academic Calendar and Events Calendar. Complete the manual checks below before enabling other schools.

To roll back the UI, disable the school setting through the policy screen. Retain the schema and audit records. Attendance corrections and calendar/source changes reopen finalized reports; a school must review and finalize again.

## Rules and boundaries

Missing attendance on an elapsed instructional day is **Not Marked**, never synthetic absence. Future days are upcoming, never pending. Default half-day weight is 0.5 and Late retains full-day credit. Percentages use the backend's combined weighted numerator and marked-day denominator, rounded consistently for display; no-data is null/“—”. Historical enrollment, admission/exit boundaries and effective policies apply to every date.

Emergency closures win; explicitly authorized special-working overrides follow, then applicable holidays and the weekly schedule. Conflicting legacy closures stay non-working and provisional. Retrospective holidays preserve raw marks and audit evidence while excluding those dates from attendance totals. Publication blocks unresolved working-day conflicts. Finalization is explicit, requires a fully resolved past period and checks a snapshot hash under the same school lock held by source writes.

Reports are limited to one academic year, end at school-local today and contain at most 370 dates. PDF/print consumes the same complete report snapshot as the screen. Main labels, semantic status colours and dark-theme colours are shared by both apps. Controls pair visible symbols with labels and screen-reader descriptions.

## Reproducible local verification

Backend unit tests: `node --test tests/studentAttendanceCalendar.test.js`.

The SQL integration suite requires an explicit, disposable local database whose name ends in `_attendance_test`. It **drops that scratch database's public schema**. It never reads `DATABASE_URL` and refuses non-local URLs. Run with `ATTENDANCE_TEST_DATABASE_URL=postgres://USER@127.0.0.1:PORT/schoolims_attendance_test node --experimental-test-module-mocks --test tests/studentAttendanceCalendar.test.js tests/studentAttendanceCalendar.integration.test.js`.

The integration suite checks migration idempotence/RLS, student authorization, cross-school access, weighted SQL reports, metadata privacy, source synchronization and deduplication, class holidays, audited policy changes, publication conflicts, finalization/correction races, durable alerts and HTTP validation. Notification transport is mocked; no real messages are sent.

In **each** frontend, run `./node_modules/.bin/jest --runInBand src/features/attendance-calendar src/__tests__/parentAttendance.test.tsx src/components/attendance/AttendanceHistoryList.test.tsx src/hooks/useAttendanceHistory.test.tsx`, `./node_modules/.bin/tsc --noEmit`, and `./node_modules/.bin/expo export --platform web --output-dir /tmp/APP-attendance-web --max-workers 2`.

The named QA tests cover PDF scenarios 01–19, 21 and 22 in the rule/SQL suites. Scenario 20 (export consistency/retry) is covered by frontend snapshot/export interaction tests and requires native device verification as well. Additional cases cover school-local midnight/DST, transfers, section timetable overrides, future events, effective policies, contrast, offline recovery and locale key parity.

## Manual release signoff

- Android/iOS native PDF share/print and web download/print; retry an interrupted export and compare totals/page counts, including Telugu and long activity titles.
- Screen readers, web keyboard navigation, large text, reduced motion, grayscale, light/dark themes and narrow devices. Automated contrast checks do not substitute for assistive-technology testing.
- Cross-account/student switching and airplane-mode recovery with real portal accounts; simultaneous admin edits and parent refresh.
- Publish, move, unpublish, republish and cancel a section exam; edit/cancel a targeted Events Calendar entry; publish overlapping academic holidays and special working days. Both apps must agree after refresh.
- Five-parent usability check: at least four distinguish pending from absent and locate the next exam within ten seconds. This human check and the school pilot are release gates, not completed automated tests.
