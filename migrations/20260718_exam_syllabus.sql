-- Per-paper syllabus with mark weightage.
-- exam_subjects.syllabus: JSONB array of { "topic": string, "marks": number|null }.
-- JSONB (not a child table) keeps it a free-form per-paper document the admin
-- fully controls; totals are advisory against max_marks, validated in the API.
ALTER TABLE exam_subjects ADD COLUMN IF NOT EXISTS syllabus JSONB;
