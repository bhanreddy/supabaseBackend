import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireFeature } from '../middleware/requireFeature.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

router.get('/science-projects', requireAuth, requireFeature('quick.science_projects'), asyncHandler(async (req, res) => {
  const projects = await sql`
    SELECT
      id,
      title,
      description,
      difficulty_level,
      is_group_project,
      min_participants,
      max_participants,
      materials_required,
      safety_instructions,
      thumbnail_url,
      content_url,
      created_at
    FROM science_projects
    WHERE school_id = ${req.schoolId}
    ORDER BY created_at DESC
  `;

  return sendSuccess(res, req.schoolId, projects);
}));

export default router;
