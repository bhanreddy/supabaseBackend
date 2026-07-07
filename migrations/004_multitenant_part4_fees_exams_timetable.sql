-- ============================================================
-- MULTI-TENANT MIGRATION — PART 4: FEES, EXAMS, SUBJECTS, TIMETABLE
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════
-- TABLE: subjects
-- Unique: idx_subjects_code_active (code WHERE deleted_at IS NULL) → scope to school
-- ════════════════════════════════════════════
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE subjects SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE subjects ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE subjects ADD CONSTRAINT fk_subjects_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_subjects_school_id ON subjects(school_id);
DROP INDEX IF EXISTS idx_subjects_code_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_code_active ON subjects(school_id, code) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: class_subjects (junction)
-- ════════════════════════════════════════════
ALTER TABLE class_subjects ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE class_subjects SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE class_subjects ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE class_subjects ADD CONSTRAINT fk_class_subjects_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_class_subjects_school_id ON class_subjects(school_id);

-- ════════════════════════════════════════════
-- TABLE: periods
-- ════════════════════════════════════════════
ALTER TABLE periods ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE periods SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE periods ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE periods ADD CONSTRAINT fk_periods_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_periods_school_id ON periods(school_id);

-- ════════════════════════════════════════════
-- TABLE: timetable_slots
-- Already has school_id (nullable). Backfill + NOT NULL.
-- Unique: uq_timetable_slots_active → scope to school
-- ════════════════════════════════════════════
ALTER TABLE timetable_slots ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE timetable_slots SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE timetable_slots ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE timetable_slots DROP CONSTRAINT IF EXISTS timetable_slots_school_id_fkey;
DO $$ BEGIN ALTER TABLE timetable_slots ADD CONSTRAINT fk_timetable_slots_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_timetable_slots_school_id ON timetable_slots(school_id);
DROP INDEX IF EXISTS uq_timetable_slots_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_slots_active ON timetable_slots(school_id, class_section_id, academic_year_id, period_number) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: timetable_entries
-- Unique: (class_section_id, period_id, day_of_week) → scope to school
-- ════════════════════════════════════════════
ALTER TABLE timetable_entries ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE timetable_entries SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE timetable_entries ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE timetable_entries ADD CONSTRAINT fk_timetable_entries_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_timetable_entries_school_id ON timetable_entries(school_id);
ALTER TABLE timetable_entries DROP CONSTRAINT IF EXISTS timetable_entries_class_section_id_period_id_day_of_week_key;
ALTER TABLE timetable_entries ADD CONSTRAINT unique_timetable_entries_per_school UNIQUE (school_id, class_section_id, period_id, day_of_week);

-- ════════════════════════════════════════════
-- TABLE: fee_structures
-- ════════════════════════════════════════════
ALTER TABLE fee_structures ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE fee_structures SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE fee_structures ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE fee_structures ADD CONSTRAINT fk_fee_structures_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_fee_structures_school_id ON fee_structures(school_id);

-- ════════════════════════════════════════════
-- TABLE: student_fees
-- Unique: idx_student_fees_unique_assignment (student_id, fee_structure_id) → scope to school
-- ════════════════════════════════════════════
ALTER TABLE student_fees ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE student_fees SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE student_fees ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE student_fees ADD CONSTRAINT fk_student_fees_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_student_fees_school_id ON student_fees(school_id);
DROP INDEX IF EXISTS idx_student_fees_unique_assignment;
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_fees_unique_assignment ON student_fees(school_id, student_id, fee_structure_id);

-- ════════════════════════════════════════════
-- TABLE: fee_transactions
-- Unique: idx_fee_transactions_unique_ref (transaction_ref) → scope to school
-- ════════════════════════════════════════════
ALTER TABLE fee_transactions ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE fee_transactions SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE fee_transactions ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE fee_transactions ADD CONSTRAINT fk_fee_transactions_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_fee_transactions_school_id ON fee_transactions(school_id);
DROP INDEX IF EXISTS idx_fee_transactions_unique_ref;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_transactions_unique_ref ON fee_transactions(school_id, transaction_ref) WHERE transaction_ref IS NOT NULL AND transaction_ref <> '';

-- ════════════════════════════════════════════
-- TABLE: receipts
-- Unique: receipt_no UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE receipts SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE receipts ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE receipts ADD CONSTRAINT fk_receipts_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_receipts_school_id ON receipts(school_id);
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_receipt_no_key;
ALTER TABLE receipts ADD CONSTRAINT unique_receipts_receipt_no_per_school UNIQUE (school_id, receipt_no);

-- ════════════════════════════════════════════
-- TABLE: receipt_items
-- ════════════════════════════════════════════
ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE receipt_items SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE receipt_items ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE receipt_items ADD CONSTRAINT fk_receipt_items_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_receipt_items_school_id ON receipt_items(school_id);

-- ════════════════════════════════════════════
-- TABLE: exams
-- Unique: name per academic_year_id UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE exams ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE exams SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE exams ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE exams ADD CONSTRAINT fk_exams_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_exams_school_id ON exams(school_id);
ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_name_academic_year_id_key;
ALTER TABLE exams ADD CONSTRAINT unique_exams_name_year_per_school UNIQUE (school_id, academic_year_id, name);

-- ════════════════════════════════════════════
-- TABLE: exam_subjects
-- ════════════════════════════════════════════
ALTER TABLE exam_subjects ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE exam_subjects SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE exam_subjects ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE exam_subjects ADD CONSTRAINT fk_exam_subjects_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_exam_subjects_school_id ON exam_subjects(school_id);

-- ════════════════════════════════════════════
-- TABLE: marks
-- Unique: (enrollment_id, exam_subject_id) UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE marks ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE marks SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE marks ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE marks ADD CONSTRAINT fk_marks_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_marks_school_id ON marks(school_id);
ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_enrollment_id_exam_subject_id_key;
ALTER TABLE marks ADD CONSTRAINT unique_marks_per_school UNIQUE (school_id, enrollment_id, exam_subject_id);

-- ════════════════════════════════════════════
-- TABLE: grading_scales
-- ════════════════════════════════════════════
ALTER TABLE grading_scales ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE grading_scales SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE grading_scales ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE grading_scales ADD CONSTRAINT fk_grading_scales_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_grading_scales_school_id ON grading_scales(school_id);

COMMIT;
