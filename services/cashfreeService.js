/**
 * cashfreeService.js — Phase 2: PG credential-save path ONLY.
 *
 * SCOPE: encrypt + persist Cashfree PG credentials per school, and advance the
 * per-school pg_state lifecycle. NO order creation, NO webhook handling, NO payouts.
 *
 * TRUST BOUNDARY: every function here trusts the `schoolId` it is given. It NEVER
 * reads req / never re-derives school_id. The route is responsible for passing the
 * JWT-derived school_id (req.schoolId). Keeping the boundary at the route makes the
 * "school_id is server-derived" guarantee visible where it matters.
 */

import sql from '../db.js';
import { encrypt } from '../utils/encryption.js';

/** Thrown when a credential save would violate the pg_state machine. Maps to HTTP 409. */
export class PgStateTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PgStateTransitionError';
    this.status = 409;
  }
}

/** Thrown when PG is not enabled for the school. Maps to HTTP 403. */
export class PgNotEnabledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PgNotEnabledError';
    this.status = 403;
  }
}

/**
 * Pure transition function for the per-school PG lifecycle (source of truth: schools.pg_state).
 * Saving credentials is the only Phase-2 action that advances this machine.
 *
 *   NOT_CONFIGURED   + sandbox     -> SANDBOX_ACTIVE
 *   NOT_CONFIGURED   + production  -> REJECT (must sandbox-test first)
 *   SANDBOX_ACTIVE   + sandbox     -> SANDBOX_ACTIVE     (idempotent re-save / key rotation)
 *   SANDBOX_ACTIVE   + production  -> PRODUCTION_ACTIVE  (go-live: sandbox-first rule satisfied)
 *   PRODUCTION_ACTIVE+ production  -> PRODUCTION_ACTIVE  (production key rotation)
 *   PRODUCTION_ACTIVE+ sandbox     -> REJECT (no silent downgrade of a live school)
 *   SUSPENDED        + anything    -> REJECT (NexSyrus must restore first)
 *
 * @param {string} current  current schools.pg_state
 * @param {'sandbox'|'production'} environment
 * @returns {string} the next pg_state
 */
export function nextPgState(current, environment) {
  switch (current) {
    case 'NOT_CONFIGURED':
      if (environment === 'sandbox') return 'SANDBOX_ACTIVE';
      throw new PgStateTransitionError(
        'Cannot save production credentials before sandbox is configured. Save sandbox credentials and test first.'
      );
    case 'SANDBOX_ACTIVE':
      return environment === 'production' ? 'PRODUCTION_ACTIVE' : 'SANDBOX_ACTIVE';
    case 'PRODUCTION_ACTIVE':
      if (environment === 'production') return 'PRODUCTION_ACTIVE';
      throw new PgStateTransitionError(
        'School is live (PRODUCTION_ACTIVE). Saving sandbox credentials here is not allowed.'
      );
    case 'SUSPENDED':
      throw new PgStateTransitionError(
        'PG is SUSPENDED for this school. Credentials cannot be changed until NexSyrus restores it.'
      );
    default:
      throw new PgStateTransitionError(`Unknown pg_state '${current}'.`);
  }
}

/**
 * Encrypt + upsert Cashfree PG credentials for one school, then advance pg_state.
 *
 * @param {number} schoolId  schools.id (INTEGER). MUST be JWT-derived by the caller.
 * @param {{ appId: string, secretKey: string, environment: 'sandbox'|'production' }} creds
 * @returns {Promise<{ state: string, environment: string, configuredAt: string }>}
 */
export async function saveCredentials(schoolId, { appId, secretKey, environment } = {}) {
  // Defensive input validation — failures throw, never swallow.
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    throw new Error('saveCredentials: schoolId must be a positive integer (JWT-derived).');
  }
  if (typeof appId !== 'string' || !appId.trim()) {
    throw new Error('saveCredentials: appId is required.');
  }
  if (typeof secretKey !== 'string' || !secretKey.trim()) {
    throw new Error('saveCredentials: secretKey is required.');
  }
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error("saveCredentials: environment must be 'sandbox' or 'production'.");
  }

  // Encrypt each field independently — each gets its own IV + auth tag (no nonce reuse).
  // If the Secret Manager key fetch or encryption fails, this throws and the DB is never touched.
  const appIdEnc = await encrypt(appId.trim());
  const secretEnc = await encrypt(secretKey.trim());

  // One transaction: lock the lifecycle decision + write atomically.
  return await sql.begin(async (tx) => {
    const [school] = await tx`
      SELECT id, pg_enabled, pg_state
      FROM schools
      WHERE id = ${schoolId}
      LIMIT 1
    `;
    if (!school) {
      throw new Error(`saveCredentials: school ${schoolId} not found.`);
    }
    // Defense-in-depth: the route also checks pg_enabled, but the service refuses too.
    if (school.pg_enabled !== true) {
      throw new PgNotEnabledError('Payment gateway is not enabled for this school.');
    }

    // Validate the lifecycle move BEFORE writing. Throws on an illegal transition.
    const targetState = nextPgState(school.pg_state, environment);

    const [row] = await tx`
      INSERT INTO school_pg_credentials (
        school_id, pg_provider,
        cf_app_id_encrypted, cf_app_id_iv, cf_app_id_tag,
        cf_secret_encrypted, cf_secret_iv, cf_secret_tag,
        cf_environment, updated_at
      ) VALUES (
        ${schoolId}, 'cashfree',
        ${appIdEnc.encrypted}, ${appIdEnc.iv}, ${appIdEnc.tag},
        ${secretEnc.encrypted}, ${secretEnc.iv}, ${secretEnc.tag},
        ${environment}, now()
      )
      ON CONFLICT (school_id, pg_provider) DO UPDATE SET
        cf_app_id_encrypted = EXCLUDED.cf_app_id_encrypted,
        cf_app_id_iv        = EXCLUDED.cf_app_id_iv,
        cf_app_id_tag       = EXCLUDED.cf_app_id_tag,
        cf_secret_encrypted = EXCLUDED.cf_secret_encrypted,
        cf_secret_iv        = EXCLUDED.cf_secret_iv,
        cf_secret_tag       = EXCLUDED.cf_secret_tag,
        cf_environment      = EXCLUDED.cf_environment,
        updated_at          = now()
      RETURNING cf_environment, created_at
    `;

    await tx`
      UPDATE schools SET pg_state = ${targetState} WHERE id = ${schoolId}
    `;

    return {
      state: targetState,
      environment: row.cf_environment,
      configuredAt: row.created_at,
    };
  });
}

/**
 * Lifecycle status for one school. NEVER returns credentials, ciphertext, IVs, or tags.
 *
 * @param {number} schoolId  schools.id (INTEGER), JWT-derived by the caller.
 * @returns {Promise<{ state, pgEnabled, pgLiveMode, provider, environment, configuredAt, updatedAt }>}
 */
export async function getStatus(schoolId) {
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    throw new Error('getStatus: schoolId must be a positive integer (JWT-derived).');
  }

  const [school] = await sql`
    SELECT pg_state, pg_enabled, pg_live_mode
    FROM schools
    WHERE id = ${schoolId}
    LIMIT 1
  `;
  if (!school) {
    throw new Error(`getStatus: school ${schoolId} not found.`);
  }

  // Only non-secret metadata is selected — no *_encrypted / *_iv / *_tag columns.
  const [cred] = await sql`
    SELECT pg_provider, cf_environment, created_at, updated_at
    FROM school_pg_credentials
    WHERE school_id = ${schoolId} AND pg_provider = 'cashfree'
    LIMIT 1
  `;

  return {
    state: school.pg_state,
    pgEnabled: school.pg_enabled,
    pgLiveMode: school.pg_live_mode,
    provider: cred?.pg_provider ?? null,
    environment: cred?.cf_environment ?? null,
    configuredAt: cred?.created_at ?? null,
    updatedAt: cred?.updated_at ?? null,
  };
}
