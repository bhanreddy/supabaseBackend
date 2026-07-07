-- ===========================================================================
-- Fix fee-mode migration collisions on student_fees unique assignment index.
--
-- The old index counted soft-deleted rows, so toggling per_class <-> per_section
-- could fail when repointing a live fee onto a structure that still had a
-- deleted ghost row from a previous merge (idx_student_fees_unique_assignment).
-- ===========================================================================

DROP INDEX IF EXISTS idx_student_fees_unique_assignment;

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_fees_unique_assignment
ON student_fees (student_id, fee_structure_id)
WHERE deleted_at IS NULL;
