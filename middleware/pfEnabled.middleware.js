/**
 * Middleware: pfEnabled
 *
 * Gates every PaperForge route on the per-school `pf_enabled` flag.
 *
 * Runs AFTER requireAuth (so the verified, token-derived identity is on the
 * request) and AFTER the global requireSchoolId (which, for PaperForge paths in
 * JWT_SCHOOL_ID_PATHS, has already set req.schoolId from req.user.schoolId).
 *
 * Per-route order: requireAuth -> (global requireSchoolId, token-derived) -> pfEnabled -> handler
 *
 * Null-safety: `identifyUser` is global and NON-rejecting (it may set
 * req.user = null). This middleware never dereferences a null user — if the
 * identity is missing it returns 401 instead of throwing. If the flag is off or
 * the school is unknown, it returns 403 with code PF_NOT_ENABLED so the frontend
 * can route to the upsell screen.
 */
import sql from '../db.js';

export const pfEnabled = async (req, res, next) => {
  // Defend against the non-rejecting global auth middleware: never deref null.
  if (!req.user || req.user.schoolId == null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = await sql`
      SELECT pf_enabled
      FROM schools
      WHERE id = ${req.user.schoolId}
      LIMIT 1
    `;

    const enabled = rows.length > 0 && rows[0].pf_enabled === true;
    if (!enabled) {
      return res.status(403).json({
        error: 'PaperForge is not enabled for this school',
        code: 'PF_NOT_ENABLED',
      });
    }

    return next();
  } catch (err) {
    // Hand DB errors to the global error handler (maps transient codes -> 503).
    return next(err);
  }
};

export default pfEnabled;
