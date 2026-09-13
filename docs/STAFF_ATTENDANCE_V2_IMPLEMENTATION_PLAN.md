# SchoolIMS 4.1.8 — Staff Attendance V2 Implementation Plan

**Pilot handoff:** See [STAFF_ATTENDANCE_V2_PILOT.md](./STAFF_ATTENDANCE_V2_PILOT.md) for the implemented behavior, verified checks, exact rollout configuration, and remaining physical-device/iOS build gates. This document describes the design intent, not proof that every proposed capability has shipped.

**Target Release:** SchoolIMS 4.1.8  
**Scope:** Production-Ready Server-Verifiable Biometric Mobile Staff Attendance & Administrative Control  
**Security Level:** High (Biometric Hardware Keystore + Single-Use Challenge + Server-Calculated Geofence + Attributable Admin Override)

---

## 1. Executive Summary & Product Boundary

Staff Attendance V2 replaces local, non-verifiable device authentication with a hardware-backed, cryptographically bound mobile attendance system. Attendance is signed by an approved, non-exportable hardware key on an administrator-approved mobile phone, verified against a single-use server challenge, evaluated against server-side geofencing policies, and reconciled atomically into the authoritative `staff_attendance` daily summary.

### Scope Inclusions (4.1.8)
- Native biometric-protected signing on Android (`BIOMETRIC_STRONG` + `AndroidKeyStore`) and iOS (Touch ID / Face ID + Secure Enclave).
- Hardware key invalidation on biometric enrollment changes (`setInvalidatedByBiometricEnrollment(true)` / `kSecAccessControlBiometryCurrentSet`).
- 1-to-1 Device Ownership: One approved mobile device per canonical staff person; one canonical staff owner per approved mobile device.
- Cross-staff login, account-restore, and account-switch blocking on registered mobile app installations.
- Immediate revocation enforcement taking effect even with active, unexpired JWT sessions.
- Server-side geofencing using fresh foreground GPS with accuracy and boundary uncertainty validation.
- Single-use challenge-response protocol with RFC 8785 deterministic canonical payload serialization and ECDSA P-256 signature verification.
- Idempotent submission and concurrent race handling.
- Daily summary reconciliation into `staff_attendance` preserving 100% compatibility with existing payroll calculation triggers and reporting queries.
- Legacy endpoint audit and lockdown: restricting `POST /attendance/staff` from ordinary `attendance.mark` holders to `staff_attendance.manage` or `admin`.
- Prominent Staff Dashboard Quick Action Card + Upgraded Staff Attendance Page (`app/staff/attendance.tsx`).
- Administrator Portal workflows: Device Approvals, Revocation, Atomic Replacement, Campus Geofence Policy, Exception Review, Attributable Corrections with Before → After confirmation, and Audit History.
- School-by-school rollout feature flag (`disabled` → `pilot` → `optional` → `enforced`).

### Scope Exclusions (Reserved for 5.1.8 or Non-Goals)
- No external biometric attendance hardware (fingerprint machines, optical scanners, wall-mounted facial recognition terminals).
- No custom selfie verification, facial recognition models, or photo comparisons.
- No biometric template storage, fingerprint image uploads, or private key extraction.
- No version bump beyond 4.1.8.

---

## 2. Phase 1 — Security Model, Threat Analysis & Native Feasibility

### 2.1 Threat Model Matrix

| Threat | Attack Vector | Mitigation in Staff Attendance V2 | Platform Limitation / Residual Risk |
| :--- | :--- | :--- | :--- |
| **Credential Sharing** | Teacher gives email/password or JWT to colleague. | Attendance signing requires the private key residing inside the physical phone's secure hardware. Only the registered phone can sign. | Colleague cannot mark attendance without physical possession of the registered phone. |
| **Device Sharing / Multi-Staff Login** | Teacher A lets Teacher B log in on Teacher A's phone to mark attendance. | Mobile client and backend enforce: One active device registration per mobile install. Another staff identity cannot log in, restore, or switch on that phone. | Multiple non-staff family roles belonging to the *same* person remain permitted. |
| **Replay Attacks** | Attacker intercepts a valid attendance payload and signature, then re-submits later. | Every submission requires a single-use crypto-random challenge (TTL: 60s). Challenges are consumed atomically in the database upon acceptance. | Replayed challenges are rejected immediately with 401/409. |
| **Payload Tampering** | Attacker alters GPS coordinates or action after biometric prompt. | Biometric prompt authorizes signing over the *exact* canonical payload (including coordinates, timestamp, action, challenge, and registration ID). | Any altered byte causes ECDSA signature verification failure. |
| **GPS Coordinate Spoofing** | Attacker uses mock location apps or developer options to fake campus location. | Server validates: mock location provider flags, location age (≤ 30s), accuracy (≤ 50m), coordinate sanity. | Signatures protect payload integrity, not absolute physical truth. Play Integrity / App Attest layered where supported. |
| **Location Uncertainty at Boundary** | GPS reading is imprecise (e.g. ±80m) near the edge of the school campus. | Server calculates: `distance + accuracy <= campus_radius`. If uncertainty extends outside campus, reject with `LOCATION_UNCERTAIN_AT_BOUNDARY`. | Never silently widens the campus geofence. |
| **Revoked Device with Active JWT** | Admin revokes stolen phone, but Supabase access token is valid for 60 more minutes. | Auth middleware and attendance verification check `staff_device_registrations.status = 'approved'` and bust middleware token cache upon revocation. | Supabase token validity alone never authorizes a revoked device. |
| **Unapproved Device Replacement** | Staff buys a new phone and attempts to mark attendance immediately. | All new or replacement registrations require administrator approval. Replacement atomically revokes the prior device. | No auto-binding during login or migration. |
| **Biometric Enrollment Tampering** | Phone owner allows another person to add their fingerprint in Android/iOS Settings. | Key generation specifies `setInvalidatedByBiometricEnrollment(true)` (Android) and `kSecAccessControlBiometryCurrentSet` (iOS). The OS permanently destroys the key. | Attempted attendance fails with `KEY_PERMANENTLY_INVALIDATED`. Requires admin-approved re-enrollment. |
| **Legacy Endpoint Bypass** | Staff with `attendance.mark` calls `POST /attendance/staff` directly to mark self present. | Legacy bulk endpoint audited and locked down: requires `staff_attendance.manage` (admin/management), rejecting ordinary staff. | Direct database writes on `staff_attendance` revoked from client roles. |

### 2.2 Native Cryptographic Module Architecture
- **Curve & Algorithm:** NIST P-256 (`secp256r1`) ECDSA with SHA-256 digest.
- **Dual-Key Model:**
  1. `Attendance Key`: Biometric-bound key generated in `AndroidKeyStore` / iOS Secure Enclave. Requires fresh biometric confirmation for every signature operation. Timeouts set to 0. Invalidated on biometric changes.
  2. `Device Session Key`: Hardware-backed keystore key without per-operation biometric prompt. Used to authenticate routine session renewal and prove device ownership to API endpoints.
- **Platform Implementations:**
  - Android: `StaffBiometricsModule.kt` using `androidx.biometric.BiometricPrompt` with `CryptoObject` and `BiometricManager.Authenticators.BIOMETRIC_STRONG`. Weak face unlock and device credentials (passcode/PIN/pattern) are explicitly forbidden.
  - iOS: `StaffBiometricsModule.swift` using `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` and `SecAccessControlCreateWithFlags(.biometryCurrentSet | .privateKeyUsage)`. `NSFaceIDUsageDescription` added to Info.plist.
  - Web / Desktop: Stubbed to return `unsupported_platform`, routing staff to clear messaging and exception request flows.

---

## 3. Phase 2 — Canonical Identity & Device Ownership Model

### 3.1 Identity Resolution
SchoolIMS supports multi-school networks, guardians who are also staff, and multiple user accounts.
- **Canonical Person:** `persons.id` (UUID). The physical human being.
- **Staff Record:** `staff.id` (UUID). Scoped to a specific school (`school_id`).
- **User Account:** `users.id` (UUID). Authentication identity linked to `person_id`.
- **Invariants:**
  1. An approved device registration is bound to `canonical_person_id`.
  2. `staff_device_registrations` enforces `UNIQUE(canonical_person_id) WHERE status = 'approved'`. Exactly 1 approved phone per person across all schools.
  3. `staff_device_registrations` enforces `UNIQUE(device_session_public_key) WHERE status = 'approved'`. Exactly 1 person per phone.

### 3.2 Registration & Approval Lifecycle
1. **Authenticated Setup:** Staff member logs into mobile app with their credentials.
2. **Capability Probe:** App verifies strong biometrics are enrolled and operational.
3. **Key Generation & Proof of Possession:** App creates hardware keys and signs a registration challenge.
4. **Pending Registration:** Server stores public keys with status `'pending'`.
5. **Administrator Verification:** Admin inspects staff name, device model, and timestamp in the admin dashboard and explicitly approves or rejects.
6. **Active Registration:** Status changes to `'approved'`. Attendance signing is unlocked.
7. **Replacement:** When staff registers a replacement phone, admin approval atomically marks the previous registration `'replaced'`, revokes active sessions, and cancels pending challenges.

---

## 4. Phase 3 — Geofencing, Single-Use Challenge & Attendance Protocol

### 4.1 Campus Configuration & Pilot Defaults
- Configurable per school/campus in `campus_attendance_policies`:
  - `center_latitude`, `center_longitude`, `radius_meters` (default 100m)
  - `max_location_age_seconds` (default 30s)
  - `max_accuracy_meters` (default 50m)
  - `challenge_expiry_seconds` (default 60s)
  - `school_timezone` (e.g. `Asia/Kolkata`)
  - `check_in_start_time`, `check_in_end_time`, `check_out_start_time`, `check_out_end_time`, `grace_period_minutes`
  - `enforcement_mode` (`disabled`, `pilot`, `optional`, `enforced`)

### 4.2 Protocol Sequence
```
Client (Staff Phone)                     Server (SchoolIMS API)
        │                                           │
  1.    │ ─── POST /attendance/v2/challenge ───────>│ (Verify user & active approved device)
        │                                           │ (Generate single-use challenge in DB)
  2.    │ <── { challenge, challenge_id, policy } ──│
        │                                           │
  3.    │ [Capture fresh foreground GPS]            │
  4.    │ [Construct RFC 8785 canonical payload]    │
  5.    │ [Prompt Biometric: fingerprint / face]    │
  6.    │ [Sign canonical payload via CryptoObject] │
        │                                           │
  7.    │ ─── POST /attendance/v2/verify ──────────>│ (Begin DB Transaction)
        │     { challenge_id, signature, ... }      │ (Check idempotency key)
        │                                           │ (Consume challenge: consumed_at = NOW)
        │                                           │ (Verify ECDSA P-256 signature)
        │                                           │ (Calculate Haversine geofence & accuracy)
        │                                           │ (Verify action ordering & state transitions)
        │                                           │ (Append staff_attendance_events record)
        │                                           │ (Reconcile & update staff_attendance row)
        │                                           │ (Append audit record, Commit Transaction)
  8.    │ <── { success: true, server_time, ... } ──│
        │                                           │
  9.    │ [Update UI: Checked In / Checked Out]     │
```

### 4.3 Canonical Payload Specification
To eliminate ambiguity across platforms, payload fields are sorted lexicographically before signing:
```json
{
  "action": "check_in",
  "campus_id": "uuid",
  "challenge_id": "uuid",
  "idempotency_key": "uuid",
  "location": {
    "accuracy": 12.4,
    "latitude": 17.385044,
    "longitude": 78.486671,
    "mocked": false,
    "timestamp": 1757317620000
  },
  "policy_version": "1.0",
  "registration_id": "uuid",
  "school_id": 1,
  "staff_id": "uuid"
}
```

---

## 5. Phase 4 — Data Model, Daily Summaries & Payroll Integration

### 5.1 Tables Introduced
1. `campus_attendance_policies`: Campus geofence, accuracy, windows, and timezone.
2. `staff_device_registrations`: Public keys, ownership metadata, status, approval/revocation attribution.
3. `staff_device_sessions`: Active device-bound mobile sessions.
4. `attendance_challenges`: Single-use challenges with cryptographic nonces and short TTLs.
5. `staff_attendance_events`: Immutable append-only log of every accepted mobile event or admin action.
6. `staff_attendance_exceptions`: Formal requests from staff for missing/failed mobile attendance.
7. `staff_attendance_audit_logs`: Attributable history for administrative overrides and device actions.

### 5.2 Preservation of `staff_attendance` & Payroll Compatibility
- `staff_attendance` remains the authoritative daily summary table.
- Extended with non-breaking columns:
  - `check_in_time TIMESTAMPTZ`
  - `check_out_time TIMESTAMPTZ`
  - `check_in_event_id UUID REFERENCES staff_attendance_events(id)`
  - `check_out_event_id UUID REFERENCES staff_attendance_events(id)`
  - `verification_source VARCHAR(30) DEFAULT 'manual'`
  - `is_verified BOOLEAN DEFAULT false`
- `status` remains type `attendance_status_enum` (`present`, `absent`, `half_day`, `late`).
- Check constraint `chk_staff_attendance_date_past` reviewed to ensure school-local dates are accepted when server runs in UTC.
- Monthly payroll calculations (`process_payroll`) continue querying `staff_attendance` for absent days without code alterations.

---

## 6. Phase 5 — Staff & Administrator Experience

### 6.1 Staff Experience
- **Dashboard Quick Action Card:**
  - Placed prominently on Staff Dashboard.
  - Dynamically displays: Not Checked In, Checked In (with server timestamp), Checked Out, Device Pending Approval, or Unregistered.
  - One-tap action routes directly to the attendance action or details screen.
- **Attendance Page (`app/staff/attendance.tsx`):**
  - Live status card with interactive Check In / Check Out button.
  - Step-by-step feedback during the cryptographic check-in flow.
  - Approved device badge showing device model and verification status.
  - Specific error banners: "Outside Campus Boundary (240m away)", "Location Accuracy Warning", "Biometric Configuration Changed", "Device Registered to Another Staff".
  - Exception Request modal for immediate submission to school administration.

### 6.2 Administrator Experience
- **Device Management:**
  - Pending Approvals queue with staff identity, device model, and public key fingerprint.
  - Active device inventory with Revoke and Replace actions.
- **Campus Geofence Configuration:**
  - Manage campus coordinates, radius, accuracy limits, and operating hours.
  - Toggle rollout modes: `disabled`, `pilot`, `enforced`.
- **Attendance Monitoring & Corrections:**
  - Real-time attendance list with badges distinguishing "Biometric Verified V2" from "Manual Entry" and "Admin Correction".
  - Attributable manual marking & correction modal showing **Before → After** preview and requiring an explicit reason.
  - Admin-finalized corrections deterministically lock the daily record against subsequent mobile overrides unless explicitly reopened by an authorized administrator.

---

## 7. Phase 6 — Verification, Automated Testing & Rollout

### 7.1 Automated Test Suite (`tests/staffAttendanceV2.test.js` & `src/services/staffAttendanceV2.test.ts`)
- Device ownership uniqueness constraints and concurrent registration races.
- Cross-staff login, restore, and switch prevention on registered mobile installations.
- Immediate revocation enforcement and middleware cache eviction.
- Canonical JSON serialization and ECDSA P-256 signature verification.
- Tampered payload rejection (coordinate, action, or challenge modification).
- Challenge single-use consumption and expiry rejection.
- Geofence calculation (Haversine distance, coordinate boundaries, boundary uncertainty).
- Check-in/check-out state transitions and idempotency.
- Impersonation and View As rejection (re-deriving staff_id strictly from authenticated identity).
- Legacy endpoint lockdown (`POST /attendance/staff` rejecting non-management users).
- Daily summary consistency and payroll query compatibility.

### 7.2 Physical Device Verification Matrix
- Android: Fingerprint sensor, Strong 3D Face (Pixel 4 / newer), Weak face rejection, Biometric enrollment changes (key invalidation detection), app data clearing.
- iOS: Face ID, Touch ID, Enrollment changes (key invalidation detection), Keychain persistence.
- Network: Offline handling, intermittent network retry, lost server response idempotency.
- GPS: Indoor GPS degradation, campus perimeter edge cases, location permission denial.

### 7.3 Rollout & Rollback Plan
- **Stage 1 (Internal):** Feature flag `disabled`. Verify migrations and automated tests.
- **Stage 2 (Pilot):** Feature flag `pilot` at one designated school. Selected staff enroll devices; daily summaries run in parallel with manual attendance.
- **Stage 3 (Validation):** Compare payroll draft against prior attendance cycle.
- **Stage 4 (Enforcement):** Feature flag `enforced` school-by-school.
- **Rollback:** If required, set feature flag to `disabled`. All historical events, audit logs, and registrations remain preserved. Attendance fallback switches to administrative manual entry without data loss.

---
