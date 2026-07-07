import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

function requireStudentRole(req, res, next) {
  const roles = req.user?.roles || [];
  if (!roles.includes('student')) {
    return res.status(403).json({ error: 'This resource is available to students only' });
  }
  next();
}

/**
 * GET /api/v1/dcgd
 * JWT school context (see middleware/schoolId.js). Returns page settings, programs (active only),
 * and a student profile strip for the DCGD header when visible.
 */
router.get(
  '/',
  requireAuth,
  requireStudentRole,
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    if (req.schoolId != null && String(req.schoolId) !== String(schoolId)) {
      return res.status(403).json({ error: 'School scope mismatch' });
    }

    const [settings] = await sql`
      SELECT id, page_title, subtitle, is_visible, updated_at
      FROM dcgd_settings
      WHERE id = 1
    `;

    if (!settings || !settings.is_visible) {
      return sendSuccess(res, schoolId, {
        visible: false,
        settings: settings || null,
        programs: [],
        profile: null,
      });
    }

    const programs = await sql`
      SELECT id, name, description, icon, display_order, is_active
      FROM dcgd_programs
      WHERE is_active = true
      ORDER BY display_order ASC, id ASC
    `;

    const [profile] = await sql`
      SELECT
        p.display_name AS name,
        p.photo_url AS photo_url,
        s.admission_no AS admission_no,
        se.roll_number AS roll_number,
        TRIM(BOTH ' ' FROM CONCAT(COALESCE(c.name, ''), ' ', COALESCE(sec.name, ''))) AS class_section_label
      FROM users u
      JOIN persons p ON p.id = u.person_id
      LEFT JOIN students s
        ON s.person_id = p.id AND s.school_id = u.school_id AND s.deleted_at IS NULL
      LEFT JOIN student_enrollments se
        ON se.student_id = s.id
        AND se.school_id = u.school_id
        AND se.status = 'active'
        AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes c ON c.id = cs.class_id AND c.school_id = u.school_id
      LEFT JOIN sections sec ON sec.id = cs.section_id AND sec.school_id = u.school_id
      WHERE u.id = ${req.user.internal_id}
      LIMIT 1
    `;

    return sendSuccess(res, schoolId, {
      visible: true,
      settings: {
        page_title: settings.page_title,
        subtitle: settings.subtitle,
        updated_at: settings.updated_at,
      },
      programs,
      profile: profile || null,
    });
  })
);

/**
 * GET /api/v1/dcgd/programs/:programId/content
 * Returns active content items for a specific program, sorted by display_order.
 */
router.get(
  '/programs/:programId/content',
  requireAuth,
  requireStudentRole,
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    if (req.schoolId != null && String(req.schoolId) !== String(schoolId)) {
      return res.status(403).json({ error: 'School scope mismatch' });
    }

    const programId = parseInt(req.params.programId, 10);
    if (!Number.isFinite(programId)) {
      return res.status(400).json({ error: 'Invalid programId' });
    }

    // Verify program exists and is active
    const [program] = await sql`
      SELECT id, name, description, icon
      FROM dcgd_programs
      WHERE id = ${programId} AND is_active = true
    `;
    if (!program) {
      return res.status(404).json({ error: 'Program not found or inactive' });
    }

    const content = await sql`
      SELECT id, title, link_url, pdf_url, image_url, content_body, display_order
      FROM dcgd_program_content
      WHERE program_id = ${programId} AND is_active = true
      ORDER BY display_order ASC, id ASC
    `;

    return sendSuccess(res, schoolId, {
      program,
      content,
    });
  })
);

export default router;
