/**
 * Middleware: requireSchoolId (formerly validateSchoolId)
 * SchoolIMS multi-tenant contract: school_id MUST be explicitly passed on every request.
 * - GET/DELETE: from req.query.school_id
 * - POST/PUT/PATCH: from req.body.school_id
 * Never infer from JWT, session, or auth context.
 */

/**
 * Routes that derive tenant school_id from the authenticated user (JWT → users.school_id),
 * never from query/body. Matches full req.path (e.g. /api/v1/settings/upi).
 */
const JWT_SCHOOL_ID_PATHS = [
  /^\/api\/v1\/settings\/upi\/?$/i,
  /^\/api\/settings\/upi\/?$/i,
  /^\/api\/v1\/school-settings\/?$/i,
  /^\/api\/v1\/dcgd\/?$/i,
  /^\/api\/v1\/dcgd\/programs\/\d+\/content\/?$/i,
  /^\/api\/v1\/fees\/adjust\/?$/i,
  /^\/api\/v1\/fees\/adjustments(\/.*)?$/i,
  /^\/api\/v1\/defaulters\/?$/i,
  /^\/api\/v1\/defaulters\/remind\/?$/i,
  /^\/api\/v1\/defaulters\/[^/]+\/?$/i,
  /^\/api\/v1\/defaulters\/[^/]+\/collect\/?$/i,
  /^\/api\/v1\/transport\/routes-with-fees\/?$/i,
  /^\/api\/v1\/transport\/fee\/?$/i,
  /^\/api\/v1\/transport\/fee\/[^/]+\/?$/i,
  /^\/api\/v1\/transport\/student-fees\/?$/i,
  /^\/api\/v1\/transport\/collect\/?$/i,
  /^\/api\/v1\/app\/payment-banner\/?$/i,
  /^\/api\/v1\/schools\/[^/]+\/profile\/?$/i,
  // PaperForge gateway: identity (school_id + user_id) is derived server-side
  // from the verified JWT, never from client query/body.
  /^\/api\/v1\/paperforge\/ingest\/?$/i,
  /^\/api\/v1\/paperforge\/ingest\/[^/]+\/?$/i,
  /^\/api\/v1\/paperforge\/health\/?$/i,
  // Payment Gateway (Phase 2): school_id MUST come from the JWT, never from the
  // client. These must be added in the same change that introduces the routes so
  // there is never a window where the route trusts a client-supplied school_id.
  /^\/api\/v1\/admin\/payments\/credentials\/?$/i,
  /^\/api\/v1\/admin\/payments\/status\/?$/i,
  // Self-service profile picture (all portals): multipart PATCH runs before
  // multer parses the body, and this is a strictly self-scoped route — school_id
  // is taken from the JWT, never from client query/body.
  /^\/api\/v1\/users\/me\/photo\/?$/i,
  /^\/users\/me\/photo\/?$/i,
  // RBAC & Segregation-of-Duties epic: these financial + staff surfaces MUST
  // derive school_id from the JWT (req.user.schoolId), never from client
  // query/body. Added in the same change that hardens their permission gates so
  // there is never a window where they trust a client-supplied school_id.
  /^\/api\/v1\/expenses(\/.*)?$/i,
  /^\/api\/v1\/payroll(\/.*)?$/i,
  /^\/api\/v1\/refunds(\/.*)?$/i,
  /^\/api\/v1\/approvals(\/.*)?$/i,
  /^\/api\/v1\/fees\/collect\/?$/i,
  /^\/api\/v1\/fees\/transactions\/?$/i,
  /^\/api\/v1\/staff(\/.*)?$/i,
  /^\/staff(\/.*)?$/i,
];

const OPTIONAL_SCHOOL_ID_PATHS = [
  /^\/api\/v1\/app\/version-check\/?$/i,
  // Notification fan-out (Phase 3a): the request carries NO single school_id —
  // each account's {userId, schoolId} is derived server-side from its own access
  // token inside the handler, so no request-level school_id is required here.
  /^\/api\/v1\/notifications\/register-multi\/?$/i,
  // Unread-count badges (Phase 4a): same batch-of-tokens model as register-multi —
  // identity (incl. schoolId) is derived per access token in the handler.
  /^\/api\/v1\/notifications\/unread-counts\/?$/i,
];

function pathUsesJwtSchoolId(req) {
  const p = req.path || '';
  return JWT_SCHOOL_ID_PATHS.some((re) => re.test(p));
}

function pathAllowsMissingSchoolId(req) {
  const p = req.path || '';
  return OPTIONAL_SCHOOL_ID_PATHS.some((re) => re.test(p));
}

/**
 * Extract school_id from request based on HTTP method.
 * @param {import('express').Request} req
 * @returns {string|null} Trimmed school_id or null if missing/empty
 */
export const getSchoolId = (req) => {
  const method = (req.method || '').toUpperCase();
  let raw =
    method === 'GET' || method === 'DELETE'
      ? req.query?.school_id
      : req.body?.school_id;

  // Multipart POST: global middleware runs before multer, so body.school_id is not
  // parsed yet — accept query param (client sends school_id on URL for uploads).
  if ((raw == null || String(raw).trim() === '') && method === 'POST') {
    raw = req.query?.school_id;
  }

  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed || null;
};

/**
 * Middleware: requireSchoolId
 * Extracts school_id from query (GET/DELETE) or body (POST/PUT/PATCH).
 * Rejects with 400 if missing or empty. Sets req.schoolId on success.
 */
export const requireSchoolId = (req, res, next) => {
  if (pathAllowsMissingSchoolId(req)) {
    return next();
  }

  if (pathUsesJwtSchoolId(req)) {
    if (!req.user?.schoolId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    req.schoolId = String(req.user.schoolId);
    return next();
  }

  const schoolId = getSchoolId(req);

  if (!schoolId) {
    return res.status(400).json({ success: false, error: 'school_id is required' });
  }

  req.schoolId = schoolId;
  next();
};

/**
 * Alias for backward compatibility. Use requireSchoolId for new code.
 * @deprecated Use requireSchoolId - this now enforces the same contract
 */
export const validateSchoolId = requireSchoolId;

export default requireSchoolId;
