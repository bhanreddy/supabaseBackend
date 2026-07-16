import { supabase, supabaseAdmin } from '../db.js';
import sql from '../db.js';
import { withRetry } from '../utils/retry.js';
import { toZonedTime } from 'date-fns-tz';
import config from '../config/env.js';

// --- CONFIG CACHE FOR SCHOOL HOURS (per-school) ---
const schoolHoursCache = new Map(); // keyed by schoolId
const SCHOOL_HOURS_CACHE_TTL = 60 * 1000; // 60 seconds

async function getSchoolHoursConfig(schoolId) {
  const cached = schoolHoursCache.get(schoolId);
  if (cached && Date.now() - cached.timestamp < SCHOOL_HOURS_CACHE_TTL) {
    return cached.data;
  }
  const rows = await sql`
        SELECT key, value FROM school_settings 
        WHERE school_id = ${schoolId}
          AND key IN ('school_hours_start', 'school_hours_end', 'school_timezone')
    `;
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  const data = {
    school_hours_start: config.school_hours_start || '08:00',
    school_hours_end: config.school_hours_end || '17:00',
    school_timezone: config.school_timezone || 'Asia/Kolkata'
  };
  schoolHoursCache.set(schoolId, { data, timestamp: Date.now() });
  // Evict stale entries if map grows too large
  if (schoolHoursCache.size > 100) {
    const oldest = schoolHoursCache.keys().next().value;
    schoolHoursCache.delete(oldest);
  }
  return data;
}

/** True when this HTTP request targets payroll routes (month-end release must work outside Mon–Fri school hours). */
function isPayrollBackendRequest(req) {
  const u = `${req.originalUrl || ''}${req.url || ''}${req.path || ''}`;
  return u.includes('/payroll');
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
      // Distinguish network failure from invalid tokeny
      const isNetworkError =
        authErr.code === 'ETIMEDOUT' ||
        authErr.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        authErr.message?.includes('fetch failed') ||
        authErr.message?.includes('Connect Timeout') ||
        authErr.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';

      // Supabase Auth (GoTrue) throttled us (429) or hit a transient server
      // error (5xx). This is an INFRA problem, not a bad token — during a login
      // surge, dozens of getUser() calls can trip Supabase's auth rate limit.
      // Never downgrade a VALID session to 401 because of it.
      const authStatus = Number(authErr.status) || 0;
      const isAuthServiceOverloaded =
        authStatus === 429 || (authStatus >= 500 && authStatus <= 599);

      const isTokenExpired = authErr.status === 401 && authErr.message?.includes('token expired');

      if (isNetworkError || isAuthServiceOverloaded) {
        // Best effort: if we verified THIS exact token recently and it hasn't
        // expired, keep the user flowing — invisible to returning users mid-surge.
        const stale = getStaleCachedUser(token);
        if (stale && tokenNotYetExpired(token)) {
          req.user = stale;
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
            const refreshResult = await supabase.auth.refreshSession({ refresh_token: refreshToken });
            if (refreshResult.error) throw refreshResult.error;

            user = refreshResult.data.user;

            // Only the finance console has the short re-auth policy.  A driver
            // must not be signed out in the middle of a live trip merely
            // because an access token needed refresh.
            const [userLoginCheck] = await sql`
              SELECT u.last_login_at,
                COALESCE(BOOL_OR(r.code IN ('accountant', 'accounts')), false) AS is_accounts
              FROM users u
              LEFT JOIN user_roles ur ON ur.user_id = u.id
              LEFT JOIN roles r ON r.id = ur.role_id
              WHERE u.id = ${user.id}
              GROUP BY u.id, u.last_login_at
              LIMIT 1`;
            if (userLoginCheck && userLoginCheck.last_login_at && userLoginCheck.is_accounts) {
              const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
              const loginAge = Date.now() - new Date(userLoginCheck.last_login_at).getTime();
              if (loginAge >= SEVEN_DAYS_MS) {
                try { await supabaseAdmin.auth.admin.signOut(user.id, 'global'); } catch (e) { }
                return res.status(401).json({ error: 'Weekly session reset. Please log in again.', code: 'WEEKLY_LOGOUT' });
              }
            }

            // Set the new token on the response so the mobile client can save it
            res.setHeader('X-Refreshed-Token', refreshResult.data.session.access_token);
            res.setHeader('X-Refreshed-Refresh-Token', refreshResult.data.session.refresh_token);
          } catch (refreshErr) {

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
                        u.unrestricted_access,
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
      return res.status(403).json({ error: 'Account is not active' });
    }

    // A refreshed token is valid for every active role. In particular, never
    // turn a successful silent refresh into a logout for a driver mid-trip.

    // FIX #2: TIME-RESTRICTED ACCESS FOR ACCOUNTS ROLE
    // Decision order for accounts-role requests:
    //   1. Standing override (unrestricted_access) ON  → allow, skip the gate entirely.
    //   2. Else within Asia/Kolkata school-hours window → allow.
    //   3. Else (and no active temp grant)             → deny (403, client shows popup).
    if (dbUser.roles && dbUser.roles.includes('accounts')
        && !isPayrollBackendRequest(req)
        && dbUser.unrestricted_access !== true) {
      // 1. Fetch school hours from DB (cache for 60s to avoid per-request DB hits)
      const { school_hours_start, school_hours_end, school_timezone } = await getSchoolHoursConfig(dbUser.school_id);

      // 2. Get current time in school timezone
      const now = toZonedTime(new Date(), school_timezone);
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const [startH, startM] = school_hours_start.split(':').map(Number);
      const [endH, endM] = school_hours_end.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      // 3. Also check it is a weekday (Mon–Fri only - getDay() returns 0 for Sunday, 1 for Mon, up to 6 for Sat)
      const dayOfWeek = now.getDay();
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

      if (!isWeekday || currentMinutes < startMinutes || currentMinutes >= endMinutes) {
        // Check temp_access_grants to see if an admin has granted them temporary access
        let hasTempAccess = false;
        try {
          const grants = await sql`
            SELECT id FROM temp_access_grants
            WHERE requested_by = ${dbUser.id}
              AND department = 'accounts'
              AND is_active = true
              AND expires_at > NOW()
            LIMIT 1
          `;
          if (grants && grants.length > 0) {
            hasTempAccess = true;
          }
        } catch (err) {
          console.error("Error checking temp_access_grants:", err);
        }

        if (!hasTempAccess) {
          // 4. Log violation to admin_notifications
          try {
            await sql`
                          INSERT INTO admin_notifications (school_id, type, message, user_id, ip_address)
                          VALUES (
                              ${dbUser.school_id},
                              'accounts_off_hours_access',
                              ${'Accounts user ' + dbUser.id + ' attempted access outside school hours'},
                              ${dbUser.id},
                              ${req.ip}
                          )
                      `;
          } catch (err) {

          }

          // 5. Return 403 — do NOT reveal exact school hours in error message
          return res.status(403).json({
            error: 'Access denied. Accounts department access is restricted to school hours.',
            code: 'OUT_OF_HOURS_NO_ACCESS'
          });
        }
      }
    }

    // Only accountant/accounts sessions may be rotated weekly.  Transport
    // drivers, teachers, parents, and admins must retain silent refresh so a
    // transient auth renewal cannot stop an unattended trip.
    const isLoginRoute = req.originalUrl.includes('/validate-school-user') || req.originalUrl.includes('/login');
    const isAccountsRole = (dbUser.roles || []).some((role) =>
      role === 'accountant' || role === 'accounts');
    if (dbUser.last_login_at && !isLoginRoute && isAccountsRole) {
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const loginAge = Date.now() - new Date(dbUser.last_login_at).getTime();

      if (loginAge >= SEVEN_DAYS_MS) {
        try {
          await supabaseAdmin.auth.admin.signOut(user.id, 'global');
        } catch (e) { }

        return res.status(401).json({
          error: 'Weekly session reset. Please log in again.',
          code: 'WEEKLY_LOGOUT'
        });
      }
    }

    // Attach to req
    req.user = {
      ...user,
      schoolId: dbUser.school_id,
      roles: (dbUser.roles || []).filter(Boolean),
      permissions: (dbUser.permissions || []).filter(Boolean),
      internal_id: dbUser.id,
      person_id: dbUser.person_id
    };

    // ── Cache the result ──
    setCachedUser(token, req.user);

    next();

  } catch (err) {
    console.error("identifyUser error:", err);
    // Only pass through if it's not a critical error; for now, log and proceed with null user
    req.user = null;
    next();
  }
};

// ── Shared: verify a Supabase access token → { userId, schoolId } ──────────
// Single source of token→identity derivation for loop callers (e.g. the
// notification fan-out endpoint), reusing the SAME primitive `identifyUser`
// uses to validate a JWT: supabase.auth.getUser(token) + an active-user lookup.
// Unlike `identifyUser` (Express middleware tightly coupled to one req/res and
// carrying app-wide policy: student auto-refresh, weekly logout, off-hours), this
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
      console.warn(`[requirePermission] denied: user=${req.user.internal_id} roles=[${(req.user.roles || []).join(',')}] missing=${permissionCode} ${req.method} ${req.originalUrl}`);
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
      console.warn(`[requireAnyPermission] denied: user=${req.user.internal_id} roles=[${(req.user.roles || []).join(',')}] missingAnyOf=[${permissionCodes.join(',')}] ${req.method} ${req.originalUrl}`);
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
