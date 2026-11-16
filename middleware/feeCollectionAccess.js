import sql from '../db.js';
import { getFeeCollectionAccess, FEE_COLLECTION_RESTRICTED } from '../services/feeCollectionAccessService.js';

// Route middleware runs even when identifyUser served a cached/stale identity.
export async function requireFeeCollectionAccess(req, res, next) {
  try {
    const access = await getFeeCollectionAccess(req.user);
    if (access.allowed) return next();
    if (access.code === FEE_COLLECTION_RESTRICTED) {
      try {
        await sql`
          INSERT INTO admin_notifications (school_id, type, message, user_id, ip_address)
          VALUES (${req.user.schoolId}, 'accounts_off_hours_access',
            ${'Accounts user ' + req.user.internal_id + ' attempted fee collection outside school hours'},
            ${req.user.internal_id || req.user.id}, ${req.ip})
        `;
      } catch { /* Notification delivery must not affect the collection decision. */ }
    }
    return res.status(req.user ? 403 : 401).json({ error: access.message, code: access.code });
  } catch (error) {
    console.error('Fee collection access check failed:', error);
    return res.status(503).json({ error: 'Unable to verify fee collection access. Please retry.' });
  }
}
