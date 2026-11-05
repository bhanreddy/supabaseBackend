# GPS precision update — 3 November 2026

This update changes GPS capture and the authoritative location pipeline. It supersedes the earlier map update’s statement that no migration is required.

## Capture and delivery

The driver requests Expo `BestForNavigation` accuracy, a 2,000 ms Android minimum interval, zero distance filtering, no deferred background batches, and iOS automotive navigation activity. OS scheduling and available satellite/sensor signals still determine actual update cadence and accuracy; a two-second delivery guarantee is not claimed. Existing active subscriptions update to capture profile v3 once without creating a second tracker. Foreground fallback uses the same accuracy profile.

Queued observations are sorted by capture time, preserve their original IDs when a timestamp repeats, reject invalid/out-of-window dates, and upload the newest 100 first. Historical recovery therefore cannot make the live dot wait behind the full offline backlog. Acknowledgement-based deletion and trip/device/account isolation are retained. The existing queue limit remains 1,000 fixes or six hours; at two-second capture its count limit represents roughly 33 minutes of offline history.

The driver sees device accuracy, approximate-permission guidance, and whether the server is confirming or rejecting position evidence. Parent live locations poll every three seconds independently of slower assignment/attendance reads. Admin polls every three seconds. Both locally mark observations delayed after 30 seconds, and show the received accuracy radius on the map. Radius includes the filter’s displacement from the sensor coordinate; smoothing does not advertise an improvement in sensor accuracy.

Capture options were checked against the installed Expo Location v19 types/native implementation, with the [Expo Location documentation](https://docs.expo.dev/versions/latest/sdk/location/) as reference. iOS does not expose the same interval setting as Android.

## Server filtering

`transportGpsFilter.js` accepts only finite coordinates, ordered independent timestamps, non-mocked observations, and known horizontal accuracy no worse than 50 m. An uncertainty-aware motion envelope checks displacement against elapsed capture time, reported movement, and an absolute 45 m/s plausibility ceiling. This ceiling is a rejection bound, not a permitted bus speed.

An accuracy-weighted position filter reduces stationary jitter, gradually corrects an initially biased position, responds quickly during movement, and limits smoothing displacement to 15 m (and at most 75% of the sensor accuracy radius). It does not snap to the straight lines connecting stops, since those lines do not identify real roads. Heading is omitted while stationary; measurable movement can supply speed/course when the phone does not. Implausible jumps and coarse/unknown accuracy cannot replace the trusted live position.

After a gap of at least 30 seconds from the last trusted observation, three coherent fixes spanning at least four seconds confirm reacquisition. The first reacquired coordinate is published without triggering stop/safety automation. A bad intervening fix breaks confirmation. Rejected fixes reset pending geofence debounce. Arrival also requires at least four seconds of independent evidence; faster sampling cannot manufacture an instantaneous arrival.

Geofences and approach signals use qualified raw coordinates, never a smoothed coordinate. All raw points remain in history; `gps_quality` records qualification separately from upload acceptance. Only accepted observations are eligible for sustained overspeed history. Historical offline points do not retroactively trigger live effects.

Filter state is stored in `trips.gps_filter_state` under the existing trip row lock, in the same transaction as history, live publication, and automated effects. It survives API restarts, serializes concurrent uploads, and is isolated by trip and school. Older/repeated packets cannot wind state backward. A failure rolls back the state and effects together.

## Verification and rollout

`npm run test:transport` passes **106 tests**: 37 backend unit, 23 SQL/HTTP integration, 38 frontend Jest, and 8 frontend Node tests. It also checks native location configuration and repeated migration application. The synthetic PostgreSQL cluster is created and removed locally; production credentials are not used by this verifier. Frontend `tsc --noEmit`, focused ESLint, and Expo web export pass.

Tests cover stationary jitter and biased-start recovery, turns, departure, teleport rejection, missing/coarse accuracy, mocked fixes, signal reacquisition, out-of-order/repeated timestamps, filter serialization, concurrent same-trip uploads, tenant/trip isolation, rollback, raw-coordinate stop decisions, capture-profile upgrades, newest-first uploads, and map uncertainty geometry.

An additional run of `tests/transportSafety.test.js` passes 7 of 9 tests. Its two legacy mock failures (missing trip/accuracy context in the zero-speed test, and an outdated SOS database mock without `json`) reproduce using the unchanged HEAD version of the safety service. They were not changed as part of this GPS work. The scoped SQL/HTTP transport suite above passes.

Apply `migrations/20261103_transport_gps_precision.sql` before releasing the backend: it adds nullable per-trip JSON filter state and a server-owned history qualification column. It is included in both fresh initialization and forward upgrade paths of `scripts/migrate_release.js`; that release command applies other pending migrations too. No migration was applied to a school database in this task.

Release the corresponding driver/parent/admin JavaScript through the project’s normal app release process. Existing native location permissions are reused. Capture accuracy and cadence changes can increase battery/data usage; measure supported phones on actual routes, including locked-screen operation, approximate permissions, urban multipath, loss/recovery, and offline backlog. No production deployment, physical-device run, battery measurement, or metre-level field-accuracy claim is included in this work.
