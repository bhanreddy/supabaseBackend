# Bus tracking repair and operator handoff

Implemented locally on 22 September 2026 across SchoolIMS-Backend and SchoolIMS-Frontend. No school database was migrated, no backend was deployed, no native binary was distributed, and no real parent notification was sent. Existing unrelated frontend edits were preserved.

The repair makes capture belong to the signed-in driver's trip, persists GPS and its effects atomically, makes the server authoritative for stop transitions, and delivers notifications through a durable outbox. It does **not** constitute completed production or physical-device acceptance.

## Repeatable verification

From SchoolIMS-Backend, run:

```sh
npm run test:transport
```

Prerequisites: Node.js 24 (used for the test runner's module mocks and TypeScript tests), PostgreSQL `initdb` and `pg_ctl` on PATH, installed dependencies in both repositories, and SchoolIMS-Frontend checked out alongside SchoolIMS-Backend. Run as a normal local user, not the PostgreSQL-disallowed root user. A CI runner needs this same two-checkout layout; no hosted CI workflow or repository credentials were configured here.

The command creates its own temporary PostgreSQL cluster on loopback, applies the real release schema and migrations to synthetic data, runs the focused suites, checks Expo-generated native configuration, then removes its database. It overrides application database credentials and mocks the external notification boundary. It is also the synthetic journey, fault-injection, concurrency, and backlog replay entry point; it never selects the school's database by default.

**54 tests passed:** 16 backend unit tests, 19 PostgreSQL/HTTP integration tests, 11 frontend Jest tests, and 8 frontend Node tests. Native configuration checks also passed. See [machine-readable results](verification/results.json), [SQL and HTTP evidence](verification/backend-transport-integration.txt), [backend unit evidence](verification/backend-transport-unit.txt), [frontend evidence](verification/frontend-transport.txt), and [native configuration](verification/native-config.txt). The frontend Node suite includes existing math/simulation tests; those do not demonstrate actual adaptive native sampling.

The replay exercises 10 concurrent buses and 1,000 historical fixes. Its local timings are diagnostic only; this is not a production capacity or battery benchmark. HTTP tests use fixture authentication and permission middleware with real resource authorization and SQL; they do not validate deployed JWT infrastructure.

Full frontend type checking still reports errors in accounts, academic planner, events, diary, fine requests, popups, and other non-transport screens. No diagnostics appeared in the changed transport/auth/client files in that run. A pristine baseline was not separately tested. See [typecheck output](verification/frontend-typecheck.txt). The broad backend `npm test` attempt was not green and included other suites requiring a configured database; only the focused transport suite is claimed to pass.

## Defect ledger

Paths below are relative to the backend unless prefixed `Frontend/`. Test names and assertions are in `tests/transportReliability.integration.js`, the `services/transport*.test.js` suites, and `Frontend/src/services/driverLocationTask.test.ts`.

| Audit | Implementation and evidence | Remaining limit |
| --- | --- | --- |
| A01 Native permissions | Frontend/app.json and app.template.json enable background location and Android foreground location service; Expo introspection passed. | A new native build and physical-device acceptance are required. |
| A02 Tracker ownership | Frontend/src/services/driverLocationTask.ts owns one tracker; screens no longer stop it on unmount. Controller tests cover shared ownership and startup/stop races. | OS lifecycle behavior is not proven by mocks. |
| A03 Poison queue points | Strict normalization and per-fix acknowledgements isolate malformed points; mixed-point SQL and frontend tests pass. | Device clocks and long offline journeys still need field testing. |
| A04 Cross-trip replay | Trip/session/device identity, immutable snapshots, and a monotonic automation cursor prevent historical replay driving a different trip. SQL tests cover historical and wrong-session points. | Old unscoped clients must upgrade. |
| A05 Partial GPS commits | transportLocationIngestService.js commits history, live state, and effects together. Injected live-write failure rolls back history and retry succeeds. | Production database outages remain an operational check. |
| A06 GPS authorization | transportAccessService.js and transportTrackingRoutes.js validate school, driver, bus, trip, and device lease. Ended-trip replay is history-only. | Deployed authentication middleware needs staging acceptance. |
| A07 Parent refresh | Frontend/src/hooks/useTransportPolling.ts and app/Screen/busTracker.tsx poll before departure and resume on focus. | Rendered screen and child-switch acceptance remain. |
| A08 Admin freshness | Admin polling retains error visibility and computes age from timestamps as time passes; missing-route loading ends. | Rendered error/focus tests remain. |
| A09 False arrival/ETA | transportEtaService.js rejects stale/missing evidence and terminal boarding stops; UI uses actual arrived state. Focused regression cases pass. | ETA remains an estimate from available geometry and learned travel time. |
| A10 Legacy privacy | Legacy and current location reads share scoped access checks; current student/guardian assignment is revalidated. SQL tests exercise parent reads and cross-school denial. | Full deployed auth matrix remains. |
| A11 SOS/overspeed schema | transportSafetyService.js uses actual route/bus/trip schema, trip-scoped speed samples, transactional incidents, and outbox delivery. SOS SQL tests include zero coordinates and retries. | Real push and school emergency response are unverified. |
| A12 Divergent trip APIs | transportTripService.js centralizes explicit start/end; GET is read-only; active trips take priority. Concurrent starts and real read queries pass. | Route legs use Asia/Kolkata; no new holiday scheduler was introduced. |
| A13 State atomicity | Row locks serialize ordered transitions/end; calibration finalization is claimed once. Concurrent transition and repeated completion tests pass. | Distributed service interruption needs staging exercise. |
| A14 Manual calibration | Coordinates, accuracy, timestamp, mocked status, and per-stop claim are validated. Calibration tests pass against real SQL. | Field calibration quality needs a real route. |
| A15 Conflicting automation | Device-side auto-advance is removed; transportGeofenceService.js uses ordered server transitions, event time, accuracy, speed, and dwell. Replay tests pass. | GPS cannot prove that a child boarded; attendance stays explicit. |
| A16 Notification durability | transportOutboxService.js persists per-recipient events in state transactions; pg-boss drains and retries them. Inbox idempotency, abandoned leases, partial delivery, and retry tests pass. | Provider crash-window duplicates remain possible; exactly-once push is not claimed. |
| A17 Attendance scope | Trip, route, stop, roster, school, date, and status are validated transactionally in transportTrackingRoutes.js. SQL/HTTP rejection tests pass. | Real role/session acceptance remains. |
| A18 Sampling/health | App-owned capture and DriverTrackingHealth.tsx expose mode, queue, upload age, and settings recovery; admin shows queue trouble. Controller tests pass. | Conservative fixed 5-second sampling replaces screen-dependent control. Adaptive battery optimization and battery/data measurements remain. |
| A19 Route revision | Migration triggers invalidate changed route calibration; trip snapshots remain immutable; finalization requires the same revision. SQL mutation/finalization tests pass. | Existing conflicting production trips must be reconciled before unique indexes can install. |
| A20 Shared geometry | effectiveRouteStops in transportTripService.js supplies locked override, complete surveyed coordinates, then learned fallback; trips freeze that geometry. | Active trips intentionally retain their start snapshot after edits. |
| A21 Identity lifecycle | Queue scope includes user, portal context, school, trip, session, device, and bus. AuthProvider stops tracking before logout/account/context changes; apiClient checks identity before transport sends. Race tests pass. | Force-stop/reboot and on-device account switching remain unverified. |

## Versioned tracking contract

The updated driver uses the scoped tracking protocol and local queue schema v2. Routes below are relative to the existing transport API mount; retain the normal authenticated school/context headers and add `X-Device-Id` for lease and GPS calls.

1. `GET /driver/my-trip` is read-only. A virtual scheduled trip is a display placeholder, not permission to upload. Inspect `available_routes` when more than one is assigned.
2. `POST /trips/start` accepts `route_id`, `trip_direction` (`morning` or `evening`), and a stable `request_id`. For a route serving both directions, explicitly choose the leg. Retry the same request ID after a lost response. A driver and bus can each have only one live trip per school.
3. `POST /trips/:tripId/tracking-session` returns `trip_id`, `session_id`, `bus_id`, and `device_id`. Another device receives 409; end the old trip before changing devices.
4. `POST /buses/:id/locations/batch` accepts:

```json
{
  "trip_id": "<trip UUID>",
  "session_id": "<session UUID>",
  "fixes": [{
    "fix_id": "<stable unique fix ID>",
    "latitude": 17.385,
    "longitude": 78.4867,
    "speed": 12,
    "heading": 90,
    "accuracy": 8,
    "recorded_at": "2026-09-22T03:30:00.000Z",
    "is_mocked": false
  }]
}
```

The timestamp is illustrative: send the actual capture time as timezone-qualified ISO. Coordinates are numeric degrees, speed is km/h, heading is [0,360), accuracy is meters. Unknown speed/heading/accuracy is `null`, never a made-up zero. Native speed is converted from m/s by the client. Do not coerce empty strings or booleans into coordinates.

The response's standard data envelope contains `acknowledgements`, each with input `index`, `fix_id`, `status` (`accepted`, `duplicate`, or `rejected`), and a rejection reason when applicable. Delete only specifically acknowledged queued IDs. Preserve unacknowledged points for retry. Rejected invalid/out-of-window points are permanent removals; they do not block healthy points. The client sends chunks of 100; the server allows 1–1,000 per request. The local queue is bounded to 1,000 fixes and six hours, so longer/faster capture can discard oldest history. Server timestamps allow at most five seconds of future skew.

Only newly inserted, non-mocked, active-trip fixes no older than 30 seconds may update live effects. Automation additionally requires reliable accuracy and ordered event times. Historical replay cannot cause approach/arrival/departure notifications. A valid ended-trip fix can be retained only within that original trip's capture window; it never updates the live bus.

5. `POST /trips/:tripId/stops/:stopId/arrive`, `/complete`, and `/skip` share server sequence checks. A manual calibration fix must include a fresh capture timestamp. Clients cannot claim `source=geofence`.
6. `POST /trips/:tripId/end` is idempotent, completes arrived stops, skips remaining pending stops, records close reason, and finalizes eligible calibration once. Reconciliation stops the driver's tracker when the trip is no longer active.

Legacy trip paths delegate to the same service. Legacy GPS without trip/session identity returns 409 with an upgrade instruction; silently accepting it would restore the audited privacy/replay defect. This is a coordinated client/backend release, not full backward compatibility.

## Automatic behavior and delivery limits

Automatic stop progression is armed only for an eligible calibrated route snapshot. Poor, stale, mocked, or fast drive-by observations cannot claim arrival. Two separated reliable observations, bounded gaps, conservative entry/exit geometry, and slow/dwell rules gate progression. Uncalibrated routes keep explicit driver actions; there is no fabricated automatic boarding.

The durable outbox is committed with the underlying transport action. The existing transport worker drains it each minute, with an immediate best-effort wake for lower latency. Five-minute abandoned leases can be reclaimed; transient failures retry with bounded backoff, up to eight attempts. Approach/late notices expire after ten minutes and are suppressed when their stop/trip is no longer relevant. Other events normally expire after a day. Guardian eligibility is rechecked at dispatch.

Outbox states distinguish `pending`, `processing`, `sent`, `inbox_only`, `expired`, and `failed`. `sent` means provider acceptance, not that a parent read the message. `inbox_only` means no successful push destination was available. Successful device-token hashes are remembered during normal partial retries; raw tokens are not stored in that retry metadata. A crash after FCM accepted a send but before the database recorded it can still produce a duplicate on retry. Notifications are not proof of emergency response.

Driver health displays capture mode, queued points, and last upload age. Admin health includes GPS/heartbeat age and pending/failed deliveries. Check worker health and outbox backlog separately from GPS health. Cleanup retains terminal outbox records for 60 days and audit events for 90 days; existing history cleanup policies still apply. These diagnostics are not a deployed external monitoring/alerting service.

## Release and recovery

1. Back up the target database and verify its restore procedure. Use staging first. Inspect existing live trip conflicts before migrating:

```sql
SELECT school_id, driver_id, count(*)
FROM trips WHERE status IN ('active','in_progress')
GROUP BY school_id, driver_id HAVING count(*) > 1;
SELECT school_id, bus_id, count(*)
FROM trips WHERE status IN ('active','in_progress')
GROUP BY school_id, bus_id HAVING count(*) > 1;
```

Resolve each conflict with an operator-approved surviving trip and an audited closure of obsolete trips; do not delete school records. The new uniqueness constraints deliberately fail if conflicts remain. Review migration locks/runtime on a production-sized staging copy; large live backfills and index construction were not benchmarked.

2. Review `migrations/20260921_transport_reliability.sql` and the full release migrator. With the correct direct/session database connection securely configured, the existing command is `npm run migrate:release -- --upgrade`. **It applies all pending release migrations, not only transport.** The repair migration is included for fresh initialization and upgrades. Existing history without reliable trip provenance is not relabeled. Active legacy trips remain manual for auto-stop behavior and need an updated driver's session before fresh tracking.
3. Release the corresponding backend and keep the existing transport jobs enabled. Verify pg-boss starts and its outbox drain executes. Check tenant-scoped reads, one synthetic trip, location freshness, and pending/failed notification counts before expanding rollout.
4. Build and distribute an updated native driver app using the school's existing build profile. Keep both `app.json` and `app.template.json` settings: school configuration generation must preserve them. Native permissions require a new binary; a JavaScript-only OTA update is insufficient. The local `android/` directory is ignored by Git, so regenerate/verify the native manifest through the normal build workflow. Do not rely on that ignored local manifest as a committed deliverable.
5. Coordinate driver upgrades before service resumes: old unscoped GPS is rejected. Perform the physical acceptance checks below, then pilot one bus with a driver/operator and test parent accounts. Observe capture, queue drainage, live freshness, stop order, inbox/push outcomes, and operator recovery before a fleet rollout.

For recovery, stop affected trips through the authorized application and direct operators to manual transport coordination. If disabling transport jobs, recognize that pending notifications will stop draining. Prefer a forward correction while retaining the additive schema. Do not drop the outbox, snapshots, or history during an incident. Rolling back only the backend or only the driver binary can break this scoped protocol; rehearse a paired rollback in staging, stop new tracking first, and account for post-release records before any database restore. No automatic destructive down migration is supplied.

## School operator guide

- Start: sign into the assigned driver account, select the route and leg, grant requested location permissions, and start the trip. Check tracking health before driving. Screen navigation does not end tracking.
- Recover: if health reports foreground-only or unavailable tracking, use the settings action to review permissions/location services and reopen the app. When network returns, queued fixes retry automatically. Old history does not pretend to be a current position.
- End: end the trip explicitly. Remaining pending stops are skipped, not marked as visited. A remotely ended trip is detected by app reconciliation; it cannot instantly stop a completely offline device, but the server prevents further live publication for that ended trip.
- Change driver/device: end the existing trip, update the authorized bus assignment, then start a new trip under the replacement driver's own account/device. Do not share accounts or attempt to reuse another device's lease.
- Correct a stop: an authorized manager edits the stop/override. That invalidates affected future calibration; the active trip retains its original snapshot. Start a new trip when the corrected route must apply immediately.
- Attendance: explicitly record present/absent against the child's actual trip stop. Unconfirmed attendance stays unconfirmed; arrival or GPS proximity never proves boarding.
- Stale map: use the displayed age and connection status. An old dot is the last known position, not proof that the bus is still there. ETA may be unavailable.
- SOS: a confirmed incident means the server recorded it. If recording is unconfirmed, use the school's established phone escalation immediately. Push delivery and emergency-service contact are not guaranteed by pressing the button.

## Outstanding acceptance — not verified

The original 36-case checklist is broader than the automated suite. Do not mark it fully complete from the test count. Remaining work includes release-like Android/iOS builds; denied/approximate/permanent permission and GPS-off scenarios; 30-minute locked-screen journeys; 20-minute offline recovery; force-stop/reboot behavior; battery/data volume; real route calibration; real FCM successes, invalid tokens, timeouts, and crash windows; rendered parent/admin focus, child-switch, accessibility, Telugu, map/offline-tile and demo behavior; deployed auth and tenant override handling; holiday/timezone policy confirmation; production-sized migration/query-plan/load checks; worker/database failure drills; and staged rollout/rollback evidence.

No mobile app can promise continued collection after every OS force-stop or permission revocation. Measure supported-device behavior and make recovery instructions part of deployment. External monitoring, hosted CI wiring, adaptive battery tuning, real-device testing, and production deployment remain separate unfinished release work.
