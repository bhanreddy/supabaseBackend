-- ============================================================
-- MULTI-TENANT MIGRATION — PART 3: STUDENTS, ACADEMICS, ATTENDANCE
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════
-- TABLE: student_statuses
-- Unique: code UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE student_statuses ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE student_statuses SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE student_statuses ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE student_statuses ADD CONSTRAINT fk_student_statuses_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_student_statuses_school_id ON student_statuses(school_id);
ALTER TABLE student_statuses DROP CONSTRAINT IF EXISTS student_statuses_code_key;
ALTER TABLE student_statuses ADD CONSTRAINT unique_student_statuses_code_per_school UNIQUE (school_id, code);

-- ════════════════════════════════════════════
-- TABLE: students
-- Already has school_id (nullable) from sync patches. Backfill + NOT NULL.
-- Unique: idx_students_admission_active (admission_no WHERE deleted_at IS NULL) → scope to school
-- Unique: idx_students_person_active (person_id WHERE deleted_at IS NULL) → scope to school
-- ════════════════════════════════════════════
ALTER TABLE students ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE students SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE students ALTER COLUMN school_id SET NOT NULL;
-- Drop old FK if it was UUID type and recreate as INTEGER
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_school_id_fkey;
DO $$ BEGIN ALTER TABLE students ADD CONSTRAINT fk_students_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_students_school_id ON students(school_id);
DROP INDEX IF EXISTS idx_students_admission_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_admission_active ON students(school_id, admission_no) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS idx_students_person_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_person_active ON students(school_id, person_id) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: parents
-- Unique: idx_parents_person_active → scope to school
-- ════════════════════════════════════════════
ALTER TABLE parents ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE parents SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE parents ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE parents ADD CONSTRAINT fk_parents_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_parents_school_id ON parents(school_id);
DROP INDEX IF EXISTS idx_parents_person_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_parents_person_active ON parents(school_id, person_id) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: student_parents (junction)
-- Unique: uq_active_parent (student_id, parent_id) — already scoped by student. Add school_id.
-- ════════════════════════════════════════════
ALTER TABLE student_parents ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE student_parents SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE student_parents ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE student_parents ADD CONSTRAINT fk_student_parents_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_student_parents_school_id ON student_parents(school_id);

-- ════════════════════════════════════════════
-- TABLE: academic_years
-- Unique: idx_academic_years_code_active → scope to school
-- ════════════════════════════════════════════
ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE academic_years SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE academic_years ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE academic_years ADD CONSTRAINT fk_academic_years_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_academic_years_school_id ON academic_years(school_id);
DROP INDEX IF EXISTS idx_academic_years_code_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_years_code_active ON academic_years(school_id, code) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: classes
-- Already has school_id (nullable). Backfill + NOT NULL.
-- Unique: name UNIQUE globally + idx_classes_name_active → scope to school
-- ════════════════════════════════════════════
ALTER TABLE classes ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE classes SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE classes ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_school_id_fkey;
DO $$ BEGIN ALTER TABLE classes ADD CONSTRAINT fk_classes_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_classes_school_id ON classes(school_id);
ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_name_key;
DROP INDEX IF EXISTS idx_classes_name_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_name_active ON classes(school_id, name) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: sections
-- Unique: name UNIQUE + idx_sections_name_active → scope to school
-- ════════════════════════════════════════════
ALTER TABLE sections ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE sections SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE sections ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE sections ADD CONSTRAINT fk_sections_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_sections_school_id ON sections(school_id);
ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_name_key;
DROP INDEX IF EXISTS idx_sections_name_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_name_active ON sections(school_id, name) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: class_sections
-- Unique: (class_id, section_id, academic_year_id) — already scoped by class.
-- ════════════════════════════════════════════
ALTER TABLE class_sections ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE class_sections SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE class_sections ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE class_sections ADD CONSTRAINT fk_class_sections_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_class_sections_school_id ON class_sections(school_id);

-- ════════════════════════════════════════════
-- TABLE: student_enrollments
-- Unique: (class_section_id, academic_year_id, roll_number) — scoped by class_section.
-- No global unique to fix.
-- ════════════════════════════════════════════
ALTER TABLE student_enrollments ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE student_enrollments SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE student_enrollments ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE student_enrollments ADD CONSTRAINT fk_student_enrollments_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_student_enrollments_school_id ON student_enrollments(school_id);

-- ════════════════════════════════════════════
-- TABLE: daily_attendance
-- Already has school_id (nullable). Backfill + NOT NULL.
-- Composite index: (school_id, student_enrollment_id, attendance_date)
-- ════════════════════════════════════════════
ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE daily_attendance SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE daily_attendance ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE daily_attendance DROP CONSTRAINT IF EXISTS daily_attendance_school_id_fkey;
DO $$ BEGIN ALTER TABLE daily_attendance ADD CONSTRAINT fk_daily_attendance_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_daily_attendance_school_id ON daily_attendance(school_id);
CREATE INDEX IF NOT EXISTS idx_attendance_school_student_date ON daily_attendance(school_id, student_enrollment_id, attendance_date);

-- ════════════════════════════════════════════
-- TABLE: staff_statuses
-- Unique: code UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE staff_statuses ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE staff_statuses SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE staff_statuses ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE staff_statuses ADD CONSTRAINT fk_staff_statuses_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_staff_statuses_school_id ON staff_statuses(school_id);
ALTER TABLE staff_statuses DROP CONSTRAINT IF EXISTS staff_statuses_code_key;
ALTER TABLE staff_statuses ADD CONSTRAINT unique_staff_statuses_code_per_school UNIQUE (school_id, code);

-- ════════════════════════════════════════════
-- TABLE: staff
-- Already has school_id (nullable). Backfill + NOT NULL.
-- Unique: idx_staff_code_active, idx_staff_person_active → scope to school
-- ════════════════════════════════════════════
ALTER TABLE staff ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE staff SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE staff ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_school_id_fkey;
DO $$ BEGIN ALTER TABLE staff ADD CONSTRAINT fk_staff_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_staff_school_id ON staff(school_id);
DROP INDEX IF EXISTS idx_staff_code_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_code_active ON staff(school_id, staff_code) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS idx_staff_person_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_person_active ON staff(school_id, person_id) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: staff_attendance
-- Unique: uq_staff_attendance_active (staff_id, attendance_date)
-- → Already scoped by staff_id. Add school_id column + index.
-- ════════════════════════════════════════════
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE staff_attendance SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE staff_attendance ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE staff_attendance ADD CONSTRAINT fk_staff_attendance_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_staff_attendance_school_id ON staff_attendance(school_id);

COMMIT;
