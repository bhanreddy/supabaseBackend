# Staff Attendance V2: first-school pilot

Prepared 2026-09-10. Enforcement remains **disabled by default**. No school database, deployment, or rollout flag was changed during this work.

## Readiness and verification

The application changes and local protocol checks are complete. **Do not start the school pilot until the physical-device checks below pass.**

- Android: Expo autolinking resolves `com.schoolims.biometrics.StaffBiometricsModule`; `:staff-biometrics:compileDebugKotlin` passes with the installed Android SDK and Android Studio JBR. Both generated P-256 keys now require secure hardware; attendance signing uses a biometric `CryptoObject`, strong biometrics only, and enrollment invalidation. This was a module compilation, not a signed application build or physical sensor test.
- iOS: Expo Apple autolinking resolves the local `StaffBiometrics` pod and `StaffBiometricsModule`; the podspec parses and Swift syntax parsing passes. The implementation uses Secure Enclave P-256 keys, `.biometryCurrentSet`, per-operation biometric signing, SPKI public-key export, and DER ECDSA/SHA-256 signatures. Cancellation and lockout use native error codes, including nested errors, instead of localized text. **An iOS SDK build and physical Face ID/Touch ID checks remain unverified: full Xcode is not installed on this machine.**
- Frontend: 150 tests pass across attendance client, HTTP transport, native wrapper, canonical payload, existing biometric login, and auth security suites. Of these, 69 are newly added attendance client/transport/native-wrapper cases. TypeScript passes. Focused lint passes.
- Backend: 22 existing attendance unit tests pass. Five new integration scenarios pass against a temporary localhost PostgreSQL database using real table DDL, foreign keys, the actual V2 migration (applied twice), real service transactions, and real Express routes. Route authentication/permission injection is stubbed; live JWT issuance and deployed proxy behavior are not exercised.
- Database coverage: default-disabled/control-school isolation, invalid key registration, pending approval, self/cross-school approval rejection, check-in/out ordering, session-proof replay, attendance idempotency, replacement, revocation before verification, geofence/accuracy/freshness/mock-location failure, signature tampering, challenge expiry, policy version changes, policy rollback, device rejection, and exception review/finalization protection.

The integration fixture omits unrelated application triggers. It does not certify the production migration state or payroll behavior. Pilot events update the real `staff_attendance` summary used by reporting/payroll; `pilot` is **not** a separate shadow ledger. Compare daily records and the payroll draft with the school's manual register.

## Defects fixed

- Multiline PEM keys in HTTP headers prevented real native requests. Keys now use literal `\n` transport escaping, decoded consistently by attendance and auth routes/middleware.
- Attendance 401 failures were swallowed by session recovery; protocol errors now retain their codes without refreshing/replaying login. Generic errors also preserve codes such as `POLICY_CHANGED` and `CHECK_IN_REQUIRED`.
- Check-out could miss an existing check-in because a PostgreSQL DATE was rebound as a timestamp. Attendance and exception-review dates now remain date text; this also protects finalized records during exception approval.
- The admin device and exception lists referenced nonexistent `users.email`; email attribution now reads school-scoped person contacts.
- Partial policy updates could pass undefined SQL parameters, including a rollback request containing only the mode. Updates now work with omitted fields, use the same active-policy selection as attendance, and support timezone and challenge TTL. New policies require explicit coordinates.
- A status refresh could restore local `approved` state after native key invalidation. Invalidation now survives refresh, missing keys require replacement, and a stale/mismatched local registration cannot proceed to GPS/signing. The card refreshes status after failures.
- Partial key generation and proof failures now clean up newly generated keys. New registration metadata is saved in one protected write, preserving old registration data on storage failure; legacy records remain readable. Key aliases and proof nonces use UUIDs.
- Android now rejects software-backed keys. Backend enrollment validates that both public keys are P-256.
- The iOS location permission explanation now includes staff campus verification. Local native build outputs are excluded from source control.

## Exact configuration

Choose **one** school and its surveyed campus center. School ID, campus coordinates, and operating hours cannot be inferred safely from the checkout. Current local `.env` targets school **1 / SSNAWABPET** and a localhost API, while `app.json` is branded/package-named for Geetanjali High School Maddur and an existing EAS profile targets school 17. Do not ship that mixed local configuration.

### Backend and database

Deploy the backend changes before distributing the new mobile builds (the new header encoding needs the matching server decoder). The migration is `migrations/20260908_v418_staff_attendance_v2.sql`, included in the existing release runner. For an existing database, the release procedure is:

```sh
# Set DATABASE_URL_DIRECT through the deployment's existing secret mechanism.
# --upgrade includes Batches 1–3 as well as V2; review that release scope first.
node scripts/migrate_release.js --upgrade
node scripts/migrate_release.js --check
```

Use a direct/session connection, not a transaction pooler. Never use `--init` on an existing school database. These commands were not run against a school database during this task.

The rollout setting is the school's active `campus_attendance_policies.enforcement_mode` column, **not an environment flag**. An absent policy, migration defaults, and omitted mode all remain disabled. The current implementation selects the oldest active campus policy; use one active policy for the pilot school. `pilot` allows approved devices to submit verified events without imposing a new app-wide login requirement. There is no separate staff allowlist: administrator approval selects participating devices.

Using an administrator token for the selected school, first configure the policy via `PUT /api/v1/attendance/v2/admin/policy`. Replace every `<...>` value; the three numeric placeholders must be JSON numbers, not strings. Use surveyed coordinates, not coordinates copied from example code.

```json
{
  "school_id": <PILOT_SCHOOL_ID>,
  "campus_name": "Main Campus",
  "center_latitude": <SURVEYED_LATITUDE>,
  "center_longitude": <SURVEYED_LONGITUDE>,
  "radius_meters": 100,
  "max_location_age_seconds": 30,
  "max_accuracy_meters": 50,
  "challenge_expiry_seconds": 60,
  "school_timezone": "Asia/Kolkata",
  "check_in_start_time": "07:30",
  "check_in_end_time": "10:00",
  "check_out_start_time": "15:30",
  "check_out_end_time": "19:00",
  "grace_period_minutes": 15,
  "enforcement_mode": "disabled"
}
```

The radius must fit the surveyed campus. The values above are the proposed first-pilot settings; confirm the school's actual hours before use. Acceptance requires `distance_from_center + reported_accuracy <= radius`; accuracy never enlarges the fence. Location must be no older than 30 seconds at server verification, with at most 5 seconds of future clock skew. Grace extends the end of both windows by 15 minutes.

After native build/device validation, enable **only that school** with:

```json
{"school_id": <PILOT_SCHOOL_ID>, "enforcement_mode": "pilot"}
```

Send this to the same PUT endpoint. Read `GET /api/v1/attendance/v2/admin/policy?school_id=<PILOT_SCHOOL_ID>` and confirm the returned school ID, mode, coordinates, limits, timezone and windows. The server generates `policy_version`; clients must use the version returned with each challenge. Recheck that every other school is disabled.

Permission mappings are seeded by the migration: staff/teacher/principal receive `staff_attendance.self`; admin/principal receive `staff_attendance.manage` and `staff_attendance.correct`. The approving administrator must be a different person from the registering staff member.

### Native application builds

Set the following consistently in the chosen build profile, using the school's existing public Supabase settings:

```dotenv
EXPO_PUBLIC_SCHOOL_ID=<PILOT_SCHOOL_ID>
EXPO_PUBLIC_SCHOOL_CODE=<PILOT_SCHOOL_CODE>
EXPO_PUBLIC_SCHOOL_NAME=<PILOT_SCHOOL_NAME>
EXPO_PUBLIC_API_URL=https://<DEPLOYED_API_HOST>/api/v1
EXPO_PUBLIC_SUPABASE_URL=<EXISTING_PROJECT_URL>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<EXISTING_PUBLIC_ANON_KEY>
```

Align `app.json` name, Android package, iOS bundle identifier, Firebase files and signing credentials with that school. Generate fresh native builds using the project's Expo prebuild/EAS process; the local `staff-biometrics` dependency autolinks without an extra config plugin. Keep release version 4.1.8, allocating appropriate unique Android/iOS build numbers. Distribute through a pilot/internal channel. An OTA JavaScript update or Expo Go cannot install this native module; do not deliver V2-only code to an older binary sharing a runtime/channel.

Do not point physical phones to localhost. Use the deployed HTTPS API. Foreground location permission is sufficient for attendance; the separate bus-tracking background permission is not an attendance requirement.

## Physical-device gate and first-day procedure

Record the device model, OS, app build, school ID, registration ID, administrator identity, and resulting event IDs for each exercise. Never record private keys or biometric data.

1. Install the new school build on a physical Android phone with strong biometrics and a physical iPhone. Confirm the module loads; an older build must clearly report that it lacks the module. Confirm Face ID usage text and the foreground location prompt.
2. Register from each participating staff account. Confirm pending status blocks attendance. A different administrator checks the staff/device identity in person and approves. Reject a separate pending enrollment and confirm the phone shows rejection.
3. During configured windows and well inside campus, perform check-in and then check-out. Require a fresh biometric prompt for each; no PIN/passcode or weak-biometric substitute. Compare returned timestamps/date with the authoritative daily summary and event/audit rows.
4. Cancel the prompt and exercise lockout; neither may record attendance or invalidate an otherwise usable key. Enroll/remove a biometric in device settings; the old attendance key must fail, the app must offer replacement, and a status refresh must not reactivate it. Approve replacement and confirm the old phone is blocked.
5. Deny location permission, disable GPS, stand outside campus, test a boundary reading whose uncertainty overlaps the fence, and allow a reading/challenge to become stale. Confirm the specific failure and no event/summary mutation. Test Android mock-provider evidence. Use the exception request/review flow where needed; exceptions must remain marked as administrative, not biometric verified.
6. Revoke an approved registration, including while a challenge is outstanding and its JWT is still valid. Confirm challenge/verification fails and sessions/challenges are revoked. Exercise a second staff login/switch on the enrolled installation.
7. Interrupt connectivity during verification. Never infer success from a biometric prompt; refresh today's authoritative state before retrying. A previously accepted identical submission must resolve to its existing event, not duplicate it. After an enrollment failure, administrators should reject any abandoned pending request before approving a fresh one.
8. Compare the pilot's daily records and payroll draft with the manual register. Keep nonparticipants on administrative attendance. Never enable `enforced` as part of this first pilot.

Hardware key checks and signed coordinates do not constitute remote hardware attestation or proof that reported GPS is physically true. Play Integrity/App Attest and biometric-person identity matching are not implemented. In-person enrollment and the restricted pilot cohort remain necessary.

## Rollback

PUT the following to the same school's policy endpoint:

```json
{"school_id": <PILOT_SCHOOL_ID>, "enforcement_mode": "disabled"}
```

Confirm today's status offers neither check-in nor check-out. Mode updates change the policy version; pending challenges are rejected on verification. Existing events, registrations and audits remain intact. Continue administrative attendance and reconcile any already-recorded pilot events; disabling does not undo payroll-visible summaries or delete registrations.

## Reproduce local checks

From `SchoolIMS-Frontend`:

```sh
npx jest src/services/staffAttendanceV2Client.test.ts src/services/apiClient.staffAttendance.test.ts src/services/canonicalPayload.test.ts src/services/authService.security.test.ts src/services/biometricService.test.ts modules/staff-biometrics/index.test.ts --runInBand --watchman=false
npx tsc --noEmit
# With an installed Java runtime and Android SDK:
cd android
./gradlew :staff-biometrics:compileDebugKotlin --offline --no-daemon
```

From `SchoolIMS-Backend`:

```sh
node --experimental-test-module-mocks --test tests/staffAttendanceV2.test.js
# Explicit isolated local PostgreSQL admin URL; never use the school's DB URL.
STAFF_ATTENDANCE_TEST_DATABASE_URL=postgres://<LOCAL_USER>@127.0.0.1:<LOCAL_TEST_PORT>/postgres \
  node --experimental-test-module-mocks --test tests/staffAttendanceV2.integration.js
```

The integration suite rejects remote hosts and creates/drops its own uniquely named database. It may create the `anon` and `authenticated` fixture roles if absent, so use an isolated test cluster. It requires a Node version supporting experimental module mocks (verified with Node 24.14.1).

Platform references: [Android KeyInfo hardware checks](https://developer.android.com/reference/android/security/keystore/KeyInfo.html), [Apple biometryCurrentSet](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset), [Apple Security result codes](https://developer.apple.com/documentation/security/security-framework-result-codes).
