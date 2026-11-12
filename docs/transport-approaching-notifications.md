# Approaching-stop notification verification — 12 November 2026

## Expected behavior

When the bus reaches execution stop 2, parents assigned to execution stop 3 receive `TRANSPORT_BUS_APPROACHING` using `busconfirmation.wav`. Both manual driver confirmation and GPS arrival use the same transactional outbox. Evening trips use their reversed execution order. Arrival, departure, skips, and proximity checks share the same per-trip, per-stop, per-parent deduplication key.

GPS proximity within 800 metres remains an additional early-warning trigger. Stops with surveyed or admin-locked coordinates support automatic arrivals from the first trip. Stops using only inferred coordinates still require route calibration. Reliable driver location uploads and an active trip are necessary for automatic arrivals.

## Fixed

- Both frontends now select the bus sound and Android channel by event type, including payloads missing sound metadata or carrying an older default sound.
- Android channel initialization checks the actual OS registry when the saved channel version is current. Missing channels are recreated without deleting existing channels or overriding user settings. Local notification display initializes channels first, including background data-only messages.
- A failed local display releases its message-ID lock so a retry can display the notification.
- Immediate backend delivery drains multiple batches rather than leaving every notification after the first 30 for another wake or the scheduled worker. Wakes received during delivery are retained.
- Approaching and running-late pushes now carry a maximum ten-minute provider lifetime, shortened to the outbox's original expiry on retries. Previously Android FCM retained them for up to 24 hours and APNs had no explicit expiry.

## Verification

- 37 transport integration tests passed against a new, disposable local PostgreSQL database. Added coverage exercises stop 2 → stop 3 through manual and GPS arrivals in morning and evening directions, concurrent retries, recipient selection, provider failure/retry, expiration after reaching the destination, and draining more than 30 queued events.
- Actual Firebase message construction is tested with a mocked provider: Android channel `bus_confirmation_custom`, Android sound `busconfirmation`, APNs sound `busconfirmation.wav`, foreground data, and original expiry preservation.
- Both apps test foreground and background sound selection, channel repair, duplicate suppression, OS-rendered background messages, and local scheduling failure/retry.
- The sound assets in both source trees and Android raw resources match byte-for-byte: 16-bit mono PCM, 44.1 kHz, approximately 3.55 seconds. ManaSchool's iOS resource also matches.
- No production notifications were sent and no real-phone playback was tested.

## Remaining native configuration blockers

- ManaSchool's effective Expo configuration has no Firebase plugins or Android/iOS Firebase files. Its fallback checked-in Android Firebase file has no `com.nexsyrus.manaschool` client. Its existing `app.config.js` enables native Firebase using `MANA_ANDROID_GOOGLE_SERVICES_FILE` and `MANA_IOS_GOOGLE_SERVICES_FILE`; those must point to real Firebase registrations for that app ID.
- Both checked-in `GoogleService-Info.plist` files identify `com.placeholder.app`, rather than the configured iOS bundle IDs. Supply the correct iOS registrations and configure APNs credentials in Firebase.
- SchoolIMS's checked-in Android Firebase file includes its configured `com.nexsyrussims.geetanjalihighschool` app ID.

After configuration, rebuild/install the native apps, enable notifications and the “Bus One Stop Away” channel, and verify with a driver and parent phone: parent at stop 3, arrival at stop 2, app open/background/closed, then repeat departure and GPS updates to check for duplicates. Check morning and evening trips. The server must also run the transport outbox recovery worker for delivery retries after outages or restarts.

An accepted push is not proof of audible playback. Device notification settings, silent mode, connectivity, and OS delivery policies still apply. An alert already handed to the push provider cannot be retracted when the bus later reaches the stop; the bounded provider lifetime limits that window.

## Compatibility with previously released frontends

The previous SchoolIMS frontend at commit `5795b97` contains `busconfirmation.wav`, creates `bus_confirmation_custom`, and appends `.wav` to the incoming `data.sound`. The backend preserves that contract: `data.sound=busconfirmation`, Android native sound `busconfirmation`, and APNs sound `busconfirmation.wav`, with a visible notification block for background OS delivery. A regression test checks this original receiver contract without changing the frontend.

Additional backend repairs:

- The original `/driver/trip/:tripId/start` alias accepts an empty body for the virtual route ID and resolves the default direction on the server. The modern trip-start endpoint still requires an explicit direction for routes serving both legs.
- The original `/driver/trip/:tripId/stop/:stopId/reach` alias completes a checkpoint atomically. Previously it only set `arrived`, leaving the old UI unable to complete that stop and therefore unable to reach the next stop. Stop 2 now triggers the stop-3 parent alert without requiring a separate Complete action. It does not infer departure or boarding from the Reached action.
- Original `{ fixes }` GPS uploads resolve the active assigned trip and session under the trip lock using the authenticated school, driver, bus, and installation ID. They cannot take over another device. Incomplete modern session payloads remain invalid, and fixes predating the selected trip are rejected. Both original single-location and batch aliases use this adapter.
- Notification message IDs remain stable per recipient and idempotency key across outbox retries, allowing the previous app's existing message-ID deduplication to suppress repeat delivery.

The expanded disposable PostgreSQL suite passes 37 integration tests, including original HTTP requests, device/tenant/driver isolation, replay rejection, concurrent checkpoint retries, and rollback of a checkpoint with its notification.

Old GPS builds that omit sensor accuracy now support automatic arrival through the legacy upload adapter. Their coordinates retain unknown accuracy in storage and live tracking. A stricter match within 30 metres (or the configured radius if smaller), at least three readings spanning eight seconds, and a low measured/reported speed are required. Mocked fixes, replayed timestamps, implausible jumps, and fixes outside the active trip do not advance stops. Modern uploads still require reported sensor accuracy for automatic arrival. The backend does not fabricate accuracy. Backend changes also cannot install a missing sound asset, create an Android channel inside an installed app, enable notification permission, repair absent Firebase native registration, or replace a broken notification renderer. Those cases require a correctly configured native app build or a device-setting change.

## GPS arrival now marks the checkpoint reached

Confirmed GPS arrival writes `completed`, the reached state already understood by the previous and current frontends. It stores the arrival time/source, emits `BUS_STOP_REACHED`, and queues the next stop's approaching alert in the same transaction. No Reached button or separate Complete action is necessary. Departure time and the departure alert are recorded separately when subsequent GPS confirms the bus has pulled away.

For modern GPS fixes, arrival requires two readings spanning at least four seconds, within the stop radius after accounting for reported accuracy, with speed below 10 km/h (or eight seconds of dwell when speed is unavailable). Legacy fixes without accuracy use the stricter match described above. GPS fixes must arrive while still fresh; a single transient match does not complete a stop. Coordinates must be saved for the expected stop, and the stop order is preserved.

Verification includes 37 disposable PostgreSQL integration tests and 15 GPS/filter/transport unit tests. Added GPS-only first-trip journeys cover both frontend payload formats in both directions, arrival before departure, next-stop recipient selection, duplicate suppression, retained unknown accuracy, and refusal to use missing or uncalibrated inferred stop coordinates. No native device test or production deployment was performed.
