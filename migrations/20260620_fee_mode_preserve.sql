-- ════════════════════════════════════════════════════════════
-- Migration: Non-destructive fee mode toggle
-- Date: 2026-06-20
-- ════════════════════════════════════════════════════════════
-- Toggling per_class <-> per_section must NOT delete the other
-- mode's fee structures or drop student fee records. Instead the
-- inactive mode's structures are *hidden* (deleted_at + a new
-- mode_deactivated marker) so they can be restored on toggle-back,
-- and student_fees are re-pointed to the active structure with
-- amount_paid preserved (see services/feeModeService.js).
--
-- mode_deactivated distinguishes a structure hidden by a mode
-- switch (auto-restorable) from one the user deleted on purpose
-- (stays deleted).
--
-- Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════

BEGIN;

-- 1. Marker column: TRUE when a structure was hidden by a mode switch.
ALTER TABLE fee_structures
  ADD COLUMN IF NOT EXISTS mode_deactivated BOOLEAN NOT NULL DEFAULT FALSE;

-- Helps the restore-on-toggle query find hidden structures quickly.
CREATE INDEX IF NOT EXISTS idx_fee_structures_mode_deactivated
  ON fee_structures (school_id)
  WHERE mode_deactivated = TRUE;

-- 2. Backfill: structures already soft-deleted by the OLD toggle logic.
--    The admin UI only ever lists/deletes structures of the school's
--    CURRENT mode, so any soft-deleted structure of the OPPOSITE mode
--    must have been hidden by a mode switch -> mark it restorable.
UPDATE fee_structures fs
SET mode_deactivated = TRUE
FROM schools s
WHERE fs.school_id = s.id
  AND fs.deleted_at IS NOT NULL
  AND fs.mode_deactivated = FALSE
  AND (
    (COALESCE(s.fee_mode, 'per_class') = 'per_class' AND fs.section_id IS NOT NULL)
    OR (s.fee_mode = 'per_section' AND fs.section_id IS NULL)
  );

COMMIT;
