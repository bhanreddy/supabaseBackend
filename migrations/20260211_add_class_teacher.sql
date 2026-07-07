-- Migration: Add class_teacher_id to class_sections

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'class_sections' 
        AND column_name = 'class_teacher_id'
    ) THEN
        ALTER TABLE class_sections 
        ADD COLUMN class_teacher_id UUID REFERENCES staff(id);
    END IF;
END $$;
