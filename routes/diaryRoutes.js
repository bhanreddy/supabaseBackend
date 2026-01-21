import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /diary
 * Get diary entries (filter by class, date)
 */
router.get('/', requirePermission('diary.view'), asyncHandler(async (req, res) => {
    const { class_section_id, date, from_date, to_date, subject_id, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let entries;
    if (class_section_id && date) {
        // Specific class and date
        entries = await sql`
      SELECT 
        d.id, d.entry_date, d.title, d.content, d.homework_due_date, d.attachments,
        s.name as subject_name,
        creator.display_name as created_by_name,
        d.created_at
      FROM diary_entries d
      LEFT JOIN subjects s ON d.subject_id = s.id
      JOIN users u ON d.created_by = u.id
      JOIN persons creator ON u.person_id = creator.id
      WHERE d.class_section_id = ${class_section_id}
        AND d.entry_date = ${date}
        ${subject_id ? sql`AND d.subject_id = ${subject_id}` : sql``}
      ORDER BY s.name NULLS LAST
    `;
    } else if (class_section_id && from_date && to_date) {
        // Date range
        entries = await sql`
      SELECT 
        d.id, d.entry_date, d.title, d.content, d.homework_due_date,
        s.name as subject_name,
        creator.display_name as created_by_name
      FROM diary_entries d
      LEFT JOIN subjects s ON d.subject_id = s.id
      JOIN users u ON d.created_by = u.id
      JOIN persons creator ON u.person_id = creator.id
      WHERE d.class_section_id = ${class_section_id}
        AND d.entry_date BETWEEN ${from_date} AND ${to_date}
      ORDER BY d.entry_date DESC, s.name NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;
    } else if (class_section_id) {
        // All entries for a class
        entries = await sql`
      SELECT 
        d.id, d.entry_date, d.title, d.homework_due_date,
        s.name as subject_name
      FROM diary_entries d
      LEFT JOIN subjects s ON d.subject_id = s.id
      WHERE d.class_section_id = ${class_section_id}
      ORDER BY d.entry_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    } else {
        return res.status(400).json({ error: 'class_section_id is required' });
    }

    res.json(entries);
}));

/**
 * GET /diary/:id
 * Get single diary entry
 */
router.get('/:id', requirePermission('diary.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [entry] = await sql`
    SELECT 
      d.*,
      s.name as subject_name,
      c.name as class_name, sec.name as section_name,
      creator.display_name as created_by_name
    FROM diary_entries d
    LEFT JOIN subjects s ON d.subject_id = s.id
    JOIN class_sections cs ON d.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN users u ON d.created_by = u.id
    JOIN persons creator ON u.person_id = creator.id
    WHERE d.id = ${id}
  `;

    if (!entry) {
        return res.status(404).json({ error: 'Diary entry not found' });
    }

    res.json(entry);
}));

/**
 * POST /diary
 * Create diary entry
 */
router.post('/', requirePermission('diary.create'), asyncHandler(async (req, res) => {
    const { class_section_id, subject_id, entry_date, title, content, homework_due_date, attachments } = req.body;

    if (!class_section_id || !content || !entry_date) {
        return res.status(400).json({ error: 'class_section_id, content, and entry_date are required' });
    }

    const [entry] = await sql`
    INSERT INTO diary_entries (class_section_id, subject_id, entry_date, title, content, homework_due_date, attachments, created_by)
    VALUES (${class_section_id}, ${subject_id}, ${entry_date}, ${title}, ${content}, 
            ${homework_due_date}, ${attachments ? JSON.stringify(attachments) : null}, ${req.user.internal_id})
    RETURNING *
  `;

    res.status(201).json({ message: 'Diary entry created', entry });
}));

/**
 * PUT /diary/:id
 * Update diary entry
 */
router.put('/:id', requirePermission('diary.create'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { subject_id, title, content, homework_due_date, attachments } = req.body;

    // Check ownership
    const [existing] = await sql`SELECT created_by FROM diary_entries WHERE id = ${id}`;
    if (!existing) {
        return res.status(404).json({ error: 'Diary entry not found' });
    }

    const isAdmin = req.user?.roles.includes('admin');
    if (!isAdmin && existing.created_by !== req.user.internal_id) {
        return res.status(403).json({ error: 'Can only update your own entries' });
    }

    const [updated] = await sql`
    UPDATE diary_entries
    SET 
      subject_id = COALESCE(${subject_id}, subject_id),
      title = COALESCE(${title}, title),
      content = COALESCE(${content}, content),
      homework_due_date = COALESCE(${homework_due_date}, homework_due_date),
      attachments = COALESCE(${attachments ? JSON.stringify(attachments) : null}, attachments)
    WHERE id = ${id}
    RETURNING *
  `;

    res.json({ message: 'Diary entry updated', entry: updated });
}));

/**
 * DELETE /diary/:id
 * Delete diary entry
 */
router.delete('/:id', requirePermission('diary.create'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [existing] = await sql`SELECT created_by FROM diary_entries WHERE id = ${id}`;
    if (!existing) {
        return res.status(404).json({ error: 'Diary entry not found' });
    }

    const isAdmin = req.user?.roles.includes('admin');
    if (!isAdmin && existing.created_by !== req.user.internal_id) {
        return res.status(403).json({ error: 'Can only delete your own entries' });
    }

    await sql`DELETE FROM diary_entries WHERE id = ${id}`;
    res.json({ message: 'Diary entry deleted' });
}));

export default router;
