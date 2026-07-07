-- ============================================================
-- MULTI-TENANT MIGRATION — PART 2: REFERENCE & CORE TABLES
-- Add school_id to: schema_meta, reference tables, persons,
-- person_contacts, roles, permissions, role_permissions,
-- users, user_settings, user_roles
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════
-- TABLE: schema_meta
-- No unique constraints to fix. Config table.
-- ════════════════════════════════════════════
ALTER TABLE schema_meta ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE schema_meta SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE schema_meta ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE schema_meta ADD CONSTRAINT fk_schema_meta_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_schema_meta_school_id ON schema_meta(school_id);

-- ════════════════════════════════════════════
-- TABLE: countries (global reference — shared across schools)
-- NOTE: Reference/lookup tables like countries, genders, blood_groups, religions,
-- student_categories, relationship_types, staff_designations are GLOBAL.
-- Per your rules "no table is exempt", so we add school_id but these rows
-- are shared (school_id = 1 for seed data). In practice you may want to
-- keep these global. Adding school_id for compliance.
-- ════════════════════════════════════════════
ALTER TABLE countries ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE countries SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE countries ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE countries ADD CONSTRAINT fk_countries_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_countries_school_id ON countries(school_id);
-- Unique: name was UNIQUE globally → scope to school
ALTER TABLE countries DROP CONSTRAINT IF EXISTS countries_name_key;
ALTER TABLE countries ADD CONSTRAINT unique_countries_name_per_school UNIQUE (school_id, name);

-- ════════════════════════════════════════════
-- TABLE: genders
-- ════════════════════════════════════════════
ALTER TABLE genders ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE genders SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE genders ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE genders ADD CONSTRAINT fk_genders_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_genders_school_id ON genders(school_id);
ALTER TABLE genders DROP CONSTRAINT IF EXISTS genders_name_key;
ALTER TABLE genders ADD CONSTRAINT unique_genders_name_per_school UNIQUE (school_id, name);

-- ════════════════════════════════════════════
-- TABLE: student_categories
-- ════════════════════════════════════════════
ALTER TABLE student_categories ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE student_categories SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE student_categories ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE student_categories ADD CONSTRAINT fk_student_categories_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_student_categories_school_id ON student_categories(school_id);
ALTER TABLE student_categories DROP CONSTRAINT IF EXISTS student_categories_name_key;
ALTER TABLE student_categories ADD CONSTRAINT unique_student_categories_name_per_school UNIQUE (school_id, name);

-- ════════════════════════════════════════════
-- TABLE: religions
-- ════════════════════════════════════════════
ALTER TABLE religions ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE religions SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE religions ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE religions ADD CONSTRAINT fk_religions_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_religions_school_id ON religions(school_id);
ALTER TABLE religions DROP CONSTRAINT IF EXISTS religions_name_key;
ALTER TABLE religions ADD CONSTRAINT unique_religions_name_per_school UNIQUE (school_id, name);

-- ════════════════════════════════════════════
-- TABLE: blood_groups
-- ════════════════════════════════════════════
ALTER TABLE blood_groups ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE blood_groups SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE blood_groups ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE blood_groups ADD CONSTRAINT fk_blood_groups_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_blood_groups_school_id ON blood_groups(school_id);
ALTER TABLE blood_groups DROP CONSTRAINT IF EXISTS blood_groups_name_key;
ALTER TABLE blood_groups ADD CONSTRAINT unique_blood_groups_name_per_school UNIQUE (school_id, name);

-- ════════════════════════════════════════════
-- TABLE: relationship_types
-- ════════════════════════════════════════════
ALTER TABLE relationship_types ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE relationship_types SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE relationship_types ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE relationship_types ADD CONSTRAINT fk_relationship_types_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_relationship_types_school_id ON relationship_types(school_id);
ALTER TABLE relationship_types DROP CONSTRAINT IF EXISTS relationship_types_name_key;
ALTER TABLE relationship_types ADD CONSTRAINT unique_relationship_types_name_per_school UNIQUE (school_id, name);

-- ════════════════════════════════════════════
-- TABLE: staff_designations
-- ════════════════════════════════════════════
ALTER TABLE staff_designations ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE staff_designations SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE staff_designations ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE staff_designations ADD CONSTRAINT fk_staff_designations_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_staff_designations_school_id ON staff_designations(school_id);
ALTER TABLE staff_designations DROP CONSTRAINT IF EXISTS staff_designations_name_key;
ALTER TABLE staff_designations ADD CONSTRAINT unique_staff_designations_name_per_school UNIQUE (school_id, name);

-- ════════════════════════════════════════════
-- TABLE: persons
-- No global unique constraints to fix (no unique on name/email here).
-- ════════════════════════════════════════════
ALTER TABLE persons ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE persons SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE persons ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE persons ADD CONSTRAINT fk_persons_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_persons_school_id ON persons(school_id);

-- ════════════════════════════════════════════
-- TABLE: person_contacts
-- Unique indexes are partial (per person_id) — already scoped by person.
-- No global unique to fix.
-- ════════════════════════════════════════════
ALTER TABLE person_contacts ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE person_contacts SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE person_contacts ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE person_contacts ADD CONSTRAINT fk_person_contacts_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_person_contacts_school_id ON person_contacts(school_id);

-- ════════════════════════════════════════════
-- TABLE: roles
-- Unique: code was globally UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE roles ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE roles SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE roles ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE roles ADD CONSTRAINT fk_roles_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_roles_school_id ON roles(school_id);
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_code_key;
ALTER TABLE roles ADD CONSTRAINT unique_roles_code_per_school UNIQUE (school_id, code);

-- ════════════════════════════════════════════
-- TABLE: permissions
-- Unique: code was globally UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE permissions SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE permissions ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE permissions ADD CONSTRAINT fk_permissions_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_permissions_school_id ON permissions(school_id);
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_code_key;
ALTER TABLE permissions ADD CONSTRAINT unique_permissions_code_per_school UNIQUE (school_id, code);

-- ════════════════════════════════════════════
-- TABLE: role_permissions (junction)
-- PK is (role_id, permission_id) — already scoped by role.
-- No global unique to fix.
-- ════════════════════════════════════════════
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE role_permissions SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE role_permissions ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE role_permissions ADD CONSTRAINT fk_role_permissions_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_role_permissions_school_id ON role_permissions(school_id);

-- ════════════════════════════════════════════
-- TABLE: users
-- Unique: idx_users_person_active is partial unique on person_id WHERE deleted_at IS NULL
-- → Needs school_id scoping
-- ════════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE users SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE users ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE users ADD CONSTRAINT fk_users_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_users_school_id ON users(school_id);
DROP INDEX IF EXISTS idx_users_person_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_person_active ON users(school_id, person_id) WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════
-- TABLE: user_settings
-- PK is user_id — already scoped. No global unique to fix.
-- ════════════════════════════════════════════
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE user_settings SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE user_settings ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE user_settings ADD CONSTRAINT fk_user_settings_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_user_settings_school_id ON user_settings(school_id);

-- ════════════════════════════════════════════
-- TABLE: user_roles (junction)
-- PK is (user_id, role_id). No global unique to fix.
-- ════════════════════════════════════════════
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE user_roles SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE user_roles ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE user_roles ADD CONSTRAINT fk_user_roles_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_user_roles_school_id ON user_roles(school_id);

COMMIT;
