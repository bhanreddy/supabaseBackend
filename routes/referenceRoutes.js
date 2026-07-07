import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /reference/staff-designations
 * Get all staff designations
 */
router.get('/staff-designations', requireAuth, asyncHandler(async (req, res) => {
    const designations = await sql`
        SELECT id, name
        FROM staff_designations
        WHERE school_id = ${req.schoolId}
        ORDER BY id ASC
    `;

    return sendSuccess(res, req.schoolId, designations);
}));

export default router;
