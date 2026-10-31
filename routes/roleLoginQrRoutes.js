import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import {
  assertRoleLoginQrExportScope,
  issueRoleLoginQrCredential,
  listRoleLoginQrMetadata,
  listRoleLoginQrUsers,
} from '../services/roleLoginQrService.js';
import { LoginQrError, hasStudentLoginQrRole, STUDENT_LOGIN_QR_ALLOWED_ROLES } from '../utils/studentLoginQr.js';

const router = express.Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function allowedRoles(req, res, next) {
  try {
    if (req.staffPortalAccess || (req.activeContext &&
      !hasStudentLoginQrRole(req.activeContext.role_codes || []))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const roles = await sql`SELECT r.code FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id AND r.deleted_at IS NULL
      JOIN users u ON u.id = ur.user_id AND u.deleted_at IS NULL AND u.account_status = 'active'
      JOIN schools s ON s.id = ur.school_id AND s.is_active = true
      WHERE ur.user_id = ${req.user.internal_id || req.user.id} AND ur.school_id = ${req.schoolId}
        AND ur.deleted_at IS NULL AND r.code = ANY(${STUDENT_LOGIN_QR_ALLOWED_ROLES})`;
    if (!roles.length) return res.status(403).json({ error: 'Insufficient permissions' });
    req.actorRoleCodes = roles.map((role) => role.code);
    req.userRole = req.actorRoleCodes[0];
    next();
  } catch { return res.status(503).json({ error: 'QR authorization is temporarily unavailable.' }); }
}

const perUserKey = (req) => {
  const userId = req.user?.internal_id || req.user?.id;
  if (userId) return `user:${userId}`;
  return `ip:${ipKeyGenerator(req.ip)}`;
};
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: perUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many QR operations. Please wait a minute.' },
});
const bulkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: perUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bulk QR operations. Please wait a minute.' },
});

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, requireAuth, allowedRoles);
router.param('userId', (req, res, next, value) => uuid.test(value)
  ? next() : res.status(400).json({ error: 'Invalid account ID.' }));

function actorId(req) {
  return req.staffPortalAccess?.admin_user_id || req.user?.internal_id || req.user?.id;
}

async function audit(req, action, entityId = null, details = {}) {
  await sql`INSERT INTO audit_logs
    (school_id, user_id, action, entity, entity_id, details, ip_address, user_agent, request_id)
    VALUES (${req.schoolId}, ${actorId(req)}, ${action}, 'role_login_qr', ${entityId},
      ${sql.json({ ...details, actor_role: req.userRole || null })}, ${req.ip},
      ${req.headers['user-agent'] || null}, ${req.requestId || req.id || null})`;
}

function handleError(res, error) {
  if (!(error instanceof LoginQrError)) {
    const missingRelation = error?.code === '42P01' || /role_login_qr_credentials/i.test(String(error?.message || ''));
    console.error('[role-login-qr] operation failed', error?.code || '', error?.message || error);
    if (missingRelation) {
      return res.status(503).json({
        error: 'Login QR storage is not installed. Run the role login QR migration and retry.',
        code: 'LOGIN_QR_NOT_CONFIGURED',
      });
    }
    return res.status(500).json({ error: 'The login QR operation could not be completed.' });
  }
  if (error.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'Account not found.', code: error.code });
  if (error.code === 'LOGIN_NOT_CONFIGURED') {
    return res.status(409).json({ error: 'Login is not configured for this account.', code: error.code });
  }
  if (error.code === 'QR_LOGIN_NOT_ALLOWED') {
    return res.status(409).json({ error: 'This account cannot use a role login QR.', code: error.code });
  }
  if (error.code === 'QR_ROLE_OUT_OF_SCOPE') {
    return res.status(403).json({
      error: 'You cannot issue a login QR for an account with a higher role.',
      code: error.code,
    });
  }
  if (error.code === 'LOGIN_QR_NOT_CONFIGURED') {
    return res.status(503).json({ error: 'Login QR service is not configured.', code: error.code });
  }
  if (error.code === 'LOGIN_QR_KEY_ROTATED') {
    return res.status(409).json({ error: 'The school QR key changed. Regenerate this login QR.', code: error.code });
  }
  return res.status(400).json({ error: 'The login QR request is invalid.', code: error.code });
}

router.get('/metadata', async (req, res) => {
  try {
    return sendSuccess(res, req.schoolId, await listRoleLoginQrMetadata(req.schoolId, req.actorRoleCodes));
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/users', async (req, res) => {
  try {
    const data = await listRoleLoginQrUsers(req.schoolId, req.actorRoleCodes, {
      role: req.query.role,
      search: req.query.search,
      page: req.query.page,
      limit: req.query.limit,
    });
    return sendSuccess(res, req.schoolId, data);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/:userId/generate', generateLimiter, async (req, res) => {
  try {
    const result = await issueRoleLoginQrCredential({
      schoolId: req.schoolId,
      userId: req.params.userId,
      actorUserId: actorId(req),
      actorRoleCodes: req.actorRoleCodes,
    });
    return sendSuccess(res, req.schoolId, result);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/:userId/regenerate', generateLimiter, async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Explicit confirmation is required to regenerate a login QR.' });
  }
  try {
    const result = await issueRoleLoginQrCredential({
      schoolId: req.schoolId,
      userId: req.params.userId,
      actorUserId: actorId(req),
      actorRoleCodes: req.actorRoleCodes,
      regenerate: true,
    });
    return sendSuccess(res, req.schoolId, result);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/bulk', bulkLimiter, async (req, res) => {
  const userIds = Array.isArray(req.body?.userIds)
    ? [...new Set(req.body.userIds.map(String))]
    : [];
  if (!userIds.length || userIds.length > 200 || userIds.some((id) => !uuid.test(id))) {
    return res.status(400).json({ error: 'Select between 1 and 200 accounts.' });
  }
  try {
    const credentials = [];
    const failures = [];
    for (const userId of userIds) {
      try {
        credentials.push(await issueRoleLoginQrCredential({
          schoolId: req.schoolId,
          userId,
          actorUserId: actorId(req),
          actorRoleCodes: req.actorRoleCodes,
        }));
      } catch (error) {
        failures.push({ userId, code: error instanceof LoginQrError ? error.code : 'FAILED' });
      }
    }
    await audit(req, 'LOGIN_QR_BULK_GENERATED', null, {
      requested_count: userIds.length,
      generated_count: credentials.length,
      failed_count: failures.length,
    });
    return sendSuccess(res, req.schoolId, { credentials, failures });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/export-audit', async (req, res) => {
  const allowed = new Set(['png', 'single_card_pdf', 'a4_pdf', 'print']);
  const exportType = String(req.body?.exportType || '');
  const userIds = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.map(String))] : [];
  if (!allowed.has(exportType) || !userIds.length || userIds.length > 200 || userIds.some((id) => !uuid.test(id))) {
    return res.status(400).json({ error: 'Invalid QR export audit request.' });
  }
  try {
    const inScope = await assertRoleLoginQrExportScope(req.schoolId, userIds, req.actorRoleCodes);
    if (!inScope) return res.status(404).json({ error: 'Account not found.' });
    await audit(req, exportType === 'png' ? 'LOGIN_QR_PNG_EXPORTED' : 'LOGIN_QR_PDF_EXPORTED', userIds.length === 1 ? userIds[0] : null, {
      export_type: exportType,
      account_count: userIds.length,
      role: req.body?.role || null,
    });
    return sendSuccess(res, req.schoolId, { recorded: true });
  } catch (error) { return handleError(res, error); }
});

export default router;
