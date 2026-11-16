import { redactAnalyticsUrl } from '../utils/analyticsPrivacy.js';
import { readStaffDevicePublicKey } from '../utils/staffDeviceHeaders.js';
import { supabase, createRequestAuthClient } from '../db.js';
import sql from '../db.js';
import { withRetry, isTransientError } from '../utils/retry.js';
import config from '../config/env.js';
import { enforceStaffDeviceProof } from '../services/staffDeviceService.js';

export function normalizeStaffDeviceProofPath(originalUrl = '') {
  return String(originalUrl).split('?')[0].replace(/^\/api\/v1/, '').replace(/^\/api/, '');
}

function staffDevicePath(req) {
  return normalizeStaffDeviceProofPath(req.originalUrl);
}

function requiresStaffDeviceProof(req) {
  const path = staffDevicePath(req);
  return path === '/attendance/v2/challenge' || path === '/attendance/v2/verify';
}

async function enforceStaffDeviceForRequest(req, res, user) {
  const roles = user?.roles || [];
  const isAttendanceStaff = roles.some((role) => ['staff', 'teacher', 'principal'].includes(role));
  if (!user?.person_id || !isAttendanceStaff || roles.includes('admin') || !requiresStaffDeviceProof(req)) return true;

  const path = staffDevicePath(req);
  const isAttendanceSelfAction = path.startsWith('/attendance/v2/challenge') || path.startsWith('/attendance/v2/verify');
  const hasDeviceHeaders = Boolean(req.headers['x-device-session-key'] || req.headers['x-device-public-key']);
  if (!isAttendanceSelfAction && !hasDeviceHeaders) {
    return true;
  }

  try {
    await enforceStaffDeviceProof({
      schoolId: user.schoolId,
      userId: user.internal_id || user.id,
      personId: user.person_id,
      publicKey: readStaffDevicePublicKey(req.headers),
      installationId: req.headers['x-device-id'] || null,
      proofTimestamp: req.headers['x-device-proof-timestamp'] || null,
      proofNonce: req.headers['x-device-proof-nonce'] || null,
      proofSignature: req.headers['x-device-proof'] || null,
      method: req.method,
      path: staffDevicePath(req),
      requireRegistration: isAttendanceSelfAction,
    });
    return true;
  } catch (err) {
    res.status(403).json({ error: err.message, code: err.code || 'INVALID_DEVICE_PROOF' });
    return false;
  }
}

// ── In-Memory Token Cache ──────────────────────────────────────────────
// Caches verified token → user data to avoid repeated Supabase API calls.
// TTL: 5 minutes. Evicted on expiry or when cache grows too large.
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — normal fresh-cache window
// Stale-fallback window: a previously-verified token may be reused for up to
// 60 min, but ONLY when Supabase Auth is throttling/unreachable (never on the
// happy path). Bounded by the token's own `exp`, so it can't extend a session.
const TOKEN_CACHE_GRACE_TTL = 60 * 60 * 1000; // 60 minutes
const TOKEN_CACHE_MAX_SIZE = 500;

function getCachedUser(token) {
  const entry = tokenCache.get(token);
  if (!entry) return null;
  if (!tokenNotYetExpired(token)) {
    tokenCache.delete(token);
    return null;
  }
  if (Date.now() - entry.timestamp > TOKEN_CACHE_TTL) {
    // Past the fresh window: don't serve on the happy path, but KEEP the entry
    // so it can act as a stale fallback if Supabase Auth is throttled below.
    return null;
  }
  return entry.user;
}

// Stale fallback — returns a previously-verified user for THIS exact token even
// after the fresh TTL, as long as it's within the grace window. Used only when
// Supabase Auth rate-limits/errors, to avoid mass 401s during login surges.
function getStaleCachedUser(token) {
  const entry = tokenCache.get(token);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TOKEN_CACHE_GRACE_TTL) {
    tokenCache.delete(token);
    return null;
  }
  return entry.user;
}

// Reads the JWT `exp` claim WITHOUT verifying the signature (same base64url
// decode the rate-limiter uses). Guarantees the stale fallback never serves a
// token past its own expiry, so no session is ever extended.
function tokenNotYetExpired(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    );
    return typeof payload?.exp === 'number' && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function setCachedUser(token, user) {
  // Evict oldest entries if cache is too large
  if (tokenCache.size >= TOKEN_CACHE_MAX_SIZE) {
    const firstKey = tokenCache.keys().next().value;
    tokenCache.delete(firstKey);
  }
  tokenCache.set(token, { user, timestamp: Date.now() });
}

// ── Middleware: identifyUser ───────────────────────────────────────────
// Verifies the Supabase JWT, fetches user roles/permissions, attaches to req.
// Uses token cache + retry logic to survive transient network issues.
export const identifyUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      req.user = null;
      return next();
    }

    // ── Check cache first ──
    const cached = getCachedUser(token);
    if (cached) {
      req.user = cached;
      if (!(await enforceStaffDeviceForRequest(req, res, cached))) return;
      return next();
    }

    // ── 1. Verify Token with Supabase (with retry) ──
    let user;
    try {
      const result = await withRetry(async () => {
        const { data, error } = await supabase.auth.getUser(token);
        if (error) throw error;
        return data;
      }, { retries: 3, delayMs: 1000 });
      user = result.user;
    } catch (authErr) {
      // Supabase Auth (GoTrue) throttled us (429) or hit a transient server
      // error (5xx). This is an INFRA problem, not a bad token — during a login
      // surge, dozens of getUser() calls can trip Supabase's auth rate limit.
      // Never downgrade a VALID session to 401 because of it.
      const isTokenExpired = authErr.code === 'jwt_expired' ||
        (Number(authErr.status) === 401 && authErr.message?.toLowerCase().includes('token expired'));

      if (isTransientError(authErr)) {
        // Best effort: if we verified THIS exact token recently and it hasn't
        // expired, keep the user flowing — invisible to returning users mid-surge.
        const stale = getStaleCachedUser(token);
        if (stale && tokenNotYetExpired(token)) {
          req.user = stale;
          if (!(await enforceStaffDeviceForRequest(req, res, stale))) return;
          return next();
        }
        // Otherwise ask the client to retry. The mobile client already silently
        // retries 503 twice, so no error popup unless the outage is sustained.
        return res.status(503).json({ error: 'Auth service temporarily unavailable. Please retry.' });
      }

      // Fix #5: Student Session Auto-Refresh (Mobile-First)
      if (isTokenExpired) {
        const refreshToken = req.headers['authorization-refresh'] || req.cookies?.refresh_token;

        if (refreshToken) {
          try {
            // Shared clients coalesce refreshes across requests. Each request
            // needs its own client so two users never receive each other's tokens.
            const refreshResult = await createRequestAuthClient().auth.refreshSession({ refresh_token: refreshToken });
            if (refreshResult.error) throw refreshResult.error;

            user = refreshResult.data.user;

            // Set the new token on the response so the mobile client can save it
            res.setHeader('X-Refreshed-Token', refreshResult.data.session.access_token);
            res.setHeader('X-Refreshed-Refresh-Token', refreshResult.data.session.refresh_token);
          } catch (refreshErr) {
            if (isTransientError(refreshErr)) {
              return res.status(503).json({ error: 'Auth service temporarily unavailable. Please retry.' });
            }
            // Still fail down below
          }
        }
      }

      if (!user) {
        // Check if it was an expired token for a student specifically that failed refresh,
        // but we don't know role yet. We just return 401 if we STILL don't have a user.
        const refreshToken = req.headers['authorization-refresh'] || req.cookies?.refresh_token;
        if (isTokenExpired && refreshToken) {
          return res.status(401).json({ error: 'Session lost permanently. Please login again.', code: 'STUDENT_SESSION_LOST' });
        }

        req.user = null;
        return next();
      }
    }

    if (!user) {
      req.user = null;
      return next();
    }

    // ── 2. Fetch Internal User & Permissions (with retry) ──
    let userInfo;
    try {
      userInfo = await withRetry(async () => {
        return await sql`
                    SELECT
                        u.id,
                        u.school_id,
                        u.account_status,
                        u.person_id,
                        u.last_login_at,
                        array_agg(DISTINCT r.code) as roles,
                        array_agg(DISTINCT p.code) as permissions
                    FROM users u
                    LEFT JOIN user_roles ur ON u.id = ur.user_id
                    LEFT JOIN roles r ON ur.role_id = r.id
                    LEFT JOIN role_permissions rp ON r.id = rp.role_id
                    LEFT JOIN permissions p ON rp.permission_id = p.id
                    WHERE u.id = ${user.id}
                    AND u.deleted_at IS NULL
                    GROUP BY u.id, u.person_id
                `;
      }, { retries: 1, delayMs: 500 });
    } catch (dbErr) {

      return res.status(503).json({ error: 'Database temporarily unavailable. Please retry.' });
    }

    if (userInfo.length === 0) {
      req.user = null;
      return next();
    }

    const dbUser = userInfo[0];

    if (dbUser.account_status !== 'active') {
      req.user = null;
      return res.status(403).json({ error: 'Account is not active', code: 'ACCOUNT_NOT_ACTIVE' });
    }

    // A refreshed token is valid for every active role. In particular, never
    // turn a successful silent refresh into a logout for a driver mid-trip.

    // Authentication is available at all hours. Fee collection enforces its
    // own school-hours policy after authentication, including cached sessions.

    // Attach to req
    req.user = {
      ...user,
      schoolId: dbUser.school_id,
      roles: (dbUser.roles || []).filter(Boolean),
      permissions: (dbUser.permissions || []).filter(Boolean),
      internal_id: dbUser.id,
      person_id: dbUser.person_id
    };

    if (!(await enforceStaffDeviceForRequest(req, res, req.user))) return;

    // ── Cache the result ──
    setCachedUser(token, req.user);

    next();

  } catch (err) {
    console.error("identifyUser error:", err);
    // An internal failure is not proof of an invalid login. Returning 503
    // avoids sending clients into unnecessary refresh/reauthentication loops.
    return res.status(503).json({ error: 'Authentication temporarily unavailable. Please retry.' });
  }
};

// ── Shared: verify a Supabase access token → { userId, schoolId } ──────────
// Single source of token→identity derivation for loop callers (e.g. the
// notification fan-out endpoint), reusing the SAME primitive `identifyUser`
// uses to validate a JWT: supabase.auth.getUser(token) + an active-user lookup.
// Unlike `identifyUser` (Express middleware tightly coupled to one req/res and
// carrying app-wide policy such as student auto-refresh), this
// is a pure function callable per-entry in a batch. It NEVER trusts any
// client-supplied id — identity comes only from the verified token.
export async function verifyAccessTokenIdentity(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'missing_token' };
  }

  // 1. Verify the JWT with Supabase (same call as identifyUser), with retry.
  let authUser;
  try {
    const result = await withRetry(async () => {
      const { data, error } = await supabase.auth.getUser(token);
      if (error) throw error;
      return data;
    }, { retries: 2, delayMs: 800 });
    authUser = result.user;
  } catch (err) {
    return { ok: false, reason: 'invalid_or_expired_token' };
  }
  if (!authUser?.id) {
    return { ok: false, reason: 'invalid_or_expired_token' };
  }

  // 2. Resolve the internal active user; schoolId is derived here, server-side,
  //    NEVER taken from the request body/query.
  let rows;
  try {
    rows = await sql`
      SELECT id, school_id, account_status
      FROM users
      WHERE id = ${authUser.id} AND deleted_at IS NULL
      LIMIT 1
    `;
  } catch (dbErr) {
    return { ok: false, reason: 'db_unavailable' };
  }
  if (!rows.length) {
    return { ok: false, reason: 'account_not_found' };
  }
  const dbUser = rows[0];
  if (dbUser.account_status !== 'active') {
    return { ok: false, reason: 'account_not_active' };
  }

  return { ok: true, userId: dbUser.id, schoolId: dbUser.school_id };
}

// Middleware to require specific permission
export const requirePermission = (permissionCode) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Admin is treated as management and bypasses granular permission checks.
    if (req.user.roles.includes('admin') || req.staffPortalAccess?.admin_user_id) {
      return next();
    }

    if (!req.user.permissions.includes(permissionCode)) {
      // Never leak which permission was missing to the client; log it server-side.
      console.warn(`[requirePermission] denied: user=${req.user.internal_id} roles=[${(req.user.roles || []).join(',')}] missing=${permissionCode} ${req.method} ${redactAnalyticsUrl(req.originalUrl)}`);
      return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    }

    next();
  };
};

/** User must have at least one of the listed permissions (admin role still bypasses). */
export const requireAnyPermission = (permissionCodes) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized: No user logged in' });
    }
    if (req.user.roles.includes('admin') || req.staffPortalAccess?.admin_user_id) {
      return next();
    }
    const ok = permissionCodes.some((code) => req.user.permissions.includes(code));
    if (!ok) {
      console.warn(`[requireAnyPermission] denied: user=${req.user.internal_id} roles=[${(req.user.roles || []).join(',')}] missingAnyOf=[${permissionCodes.join(',')}] ${req.method} ${redactAnalyticsUrl(req.originalUrl)}`);
      return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    }
    next();
  };
};

// Middleware to just require authentication (valid user)
export const requireAuth = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

/** Alias: JWT verified user required (same as requireAuth). */
export const verifyToken = requireAuth;

/** Re-export requireRole for convenience and backward compatibility */
export { requireRole } from './requireRole.js';
