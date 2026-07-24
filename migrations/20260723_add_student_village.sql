-- Migration: Add `village` column to students
-- Adds an optional free-text village field to student records so schools can
-- capture the student's native/residential village. Nullable and additive —
-- safe to run against production.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'students'
          AND column_name = 'village'
    ) THEN
        ALTER TABLE students ADD COLUMN village VARCHAR(100);
        RAISE NOTICE 'Column students.village added';
    ELSE
        RAISE NOTICE 'Column students.village already exists';
    END IF;
END $$;
