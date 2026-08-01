-- Migration: Add aadhaar_number, tc_number, previous_school to students
-- Optional intake fields for Aadhaar (12 digits), previous-school TC number,
-- and whether the student attended a previous school (Yes/No).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'students'
          AND column_name = 'aadhaar_number'
    ) THEN
        ALTER TABLE students ADD COLUMN aadhaar_number VARCHAR(12);
        RAISE NOTICE 'Column students.aadhaar_number added';
    ELSE
        RAISE NOTICE 'Column students.aadhaar_number already exists';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'students'
          AND column_name = 'tc_number'
    ) THEN
        ALTER TABLE students ADD COLUMN tc_number VARCHAR(50);
        RAISE NOTICE 'Column students.tc_number added';
    ELSE
        RAISE NOTICE 'Column students.tc_number already exists';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'students'
          AND column_name = 'previous_school'
    ) THEN
        ALTER TABLE students ADD COLUMN previous_school BOOLEAN;
        RAISE NOTICE 'Column students.previous_school added';
    ELSE
        RAISE NOTICE 'Column students.previous_school already exists';
    END IF;
END $$;
