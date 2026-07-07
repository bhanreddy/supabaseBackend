-- ============================================================
-- MULTI-TENANT MIGRATION — PART 6: LMS, NOTIFICATIONS, AUDIT, CONFIG, SAFETY
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════
-- TABLE: lms_courses
-- Already has school_id (nullable). Backfill + NOT NULL.
-- ════════════════════════════════════════════
ALTER TABLE lms_courses ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE lms_courses SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE lms_courses ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE lms_courses DROP CONSTRAINT IF EXISTS lms_courses_school_id_fkey;
DO $$ BEGIN ALTER TABLE lms_courses ADD CONSTRAINT fk_lms_courses_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_lms_courses_school_id ON lms_courses(school_id);

-- ════════════════════════════════════════════
-- TABLE: lms_lessons
-- ════════════════════════════════════════════
ALTER TABLE lms_lessons ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE lms_lessons SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE lms_lessons ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE lms_lessons ADD CONSTRAINT fk_lms_lessons_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_lms_lessons_school_id ON lms_lessons(school_id);

-- ════════════════════════════════════════════
-- TABLE: lms_progress
-- ════════════════════════════════════════════
ALTER TABLE lms_progress ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE lms_progress SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE lms_progress ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE lms_progress ADD CONSTRAINT fk_lms_progress_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_lms_progress_school_id ON lms_progress(school_id);

-- ════════════════════════════════════════════
-- TABLE: money_science_modules
-- ════════════════════════════════════════════
ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE money_science_modules SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE money_science_modules ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE money_science_modules ADD CONSTRAINT fk_money_science_modules_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_money_science_modules_school_id ON money_science_modules(school_id);

-- ════════════════════════════════════════════
-- TABLE: life_values_modules
-- ════════════════════════════════════════════
ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE life_values_modules SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE life_values_modules ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE life_values_modules ADD CONSTRAINT fk_life_values_modules_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_life_values_modules_school_id ON life_values_modules(school_id);

-- ════════════════════════════════════════════
-- TABLE: science_projects
-- ════════════════════════════════════════════
ALTER TABLE science_projects ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE science_projects SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE science_projects ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE science_projects ADD CONSTRAINT fk_science_projects_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_science_projects_school_id ON science_projects(school_id);

-- ════════════════════════════════════════════
-- TABLE: notification_templates
-- Unique: event_type UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notification_templates SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notification_templates ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notification_templates ADD CONSTRAINT fk_notification_templates_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notification_templates_school_id ON notification_templates(school_id);
ALTER TABLE notification_templates DROP CONSTRAINT IF EXISTS notification_templates_event_type_key;
ALTER TABLE notification_templates ADD CONSTRAINT unique_notification_templates_event_type_per_school UNIQUE (school_id, event_type);

-- ════════════════════════════════════════════
-- TABLE: notification_preferences
-- PK: (user_id, event_type, channel) — add school_id column.
-- ════════════════════════════════════════════
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notification_preferences SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notification_preferences ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notification_preferences ADD CONSTRAINT fk_notification_preferences_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notification_preferences_school_id ON notification_preferences(school_id);

-- ════════════════════════════════════════════
-- TABLE: notification_events
-- Unique: idempotency_key UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notification_events SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notification_events ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notification_events ADD CONSTRAINT fk_notification_events_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notification_events_school_id ON notification_events(school_id);
ALTER TABLE notification_events DROP CONSTRAINT IF EXISTS notification_events_idempotency_key_key;
ALTER TABLE notification_events ADD CONSTRAINT unique_notif_events_idempotency_per_school UNIQUE (school_id, idempotency_key);

-- ════════════════════════════════════════════
-- TABLE: notifications
-- Unique: uniq_notifications_event_user (event_id, user_id) → scope to school
-- ════════════════════════════════════════════
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notifications SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notifications ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notifications ADD CONSTRAINT fk_notifications_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notifications_school_id ON notifications(school_id);
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS uniq_notifications_event_user;
DROP INDEX IF EXISTS uniq_notifications_event_user;
ALTER TABLE notifications ADD CONSTRAINT uniq_notifications_event_user_per_school UNIQUE (school_id, event_id, user_id);

-- ════════════════════════════════════════════
-- TABLE: notification_deliveries
-- Unique: uniq_delivery_notification_channel → scope to school
-- ════════════════════════════════════════════
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notification_deliveries SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notification_deliveries ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notification_deliveries ADD CONSTRAINT fk_notification_deliveries_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_school_id ON notification_deliveries(school_id);
ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS uniq_delivery_notification_channel;
DROP INDEX IF EXISTS uniq_delivery_notification_channel;
ALTER TABLE notification_deliveries ADD CONSTRAINT uniq_delivery_notif_channel_per_school UNIQUE (school_id, notification_id, channel);

-- ════════════════════════════════════════════
-- TABLE: notification_audit_logs
-- ════════════════════════════════════════════
ALTER TABLE notification_audit_logs ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notification_audit_logs SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notification_audit_logs ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notification_audit_logs ADD CONSTRAINT fk_notification_audit_logs_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notification_audit_logs_school_id ON notification_audit_logs(school_id);

-- ════════════════════════════════════════════
-- TABLE: notification_config
-- ════════════════════════════════════════════
ALTER TABLE notification_config ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notification_config SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notification_config ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notification_config ADD CONSTRAINT fk_notification_config_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notification_config_school_id ON notification_config(school_id);

-- ════════════════════════════════════════════
-- TABLE: notification_batches
-- ════════════════════════════════════════════
ALTER TABLE notification_batches ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notification_batches SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notification_batches ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notification_batches ADD CONSTRAINT fk_notification_batches_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notification_batches_school_id ON notification_batches(school_id);

-- ════════════════════════════════════════════
-- TABLE: notification_logs
-- ════════════════════════════════════════════
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notification_logs SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notification_logs ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE notification_logs ADD CONSTRAINT fk_notification_logs_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notification_logs_school_id ON notification_logs(school_id);

-- ════════════════════════════════════════════
-- TABLE: user_devices
-- Unique: (user_id, fcm_token) → scope to school
-- ════════════════════════════════════════════
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE user_devices SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE user_devices ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE user_devices ADD CONSTRAINT fk_user_devices_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_user_devices_school_id ON user_devices(school_id);
ALTER TABLE user_devices DROP CONSTRAINT IF EXISTS user_devices_user_id_fcm_token_key;
ALTER TABLE user_devices ADD CONSTRAINT unique_user_devices_per_school UNIQUE (school_id, user_id, fcm_token);

-- ════════════════════════════════════════════
-- TABLE: audit_logs
-- ════════════════════════════════════════════
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE audit_logs SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE audit_logs ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE audit_logs ADD CONSTRAINT fk_audit_logs_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_audit_logs_school_id ON audit_logs(school_id);

-- ════════════════════════════════════════════
-- TABLE: financial_audit_logs
-- ════════════════════════════════════════════
ALTER TABLE financial_audit_logs ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE financial_audit_logs SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE financial_audit_logs ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE financial_audit_logs ADD CONSTRAINT fk_financial_audit_logs_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_financial_audit_logs_school_id ON financial_audit_logs(school_id);

-- ════════════════════════════════════════════
-- TABLE: financial_policy_rules
-- Unique: rule_code UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE financial_policy_rules ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE financial_policy_rules SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE financial_policy_rules ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE financial_policy_rules ADD CONSTRAINT fk_financial_policy_rules_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_financial_policy_rules_school_id ON financial_policy_rules(school_id);
ALTER TABLE financial_policy_rules DROP CONSTRAINT IF EXISTS financial_policy_rules_rule_code_key;
ALTER TABLE financial_policy_rules ADD CONSTRAINT unique_fin_policy_rule_code_per_school UNIQUE (school_id, rule_code);

-- ════════════════════════════════════════════
-- TABLE: girl_safety_complaints
-- Unique: ticket_no UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE girl_safety_complaints ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE girl_safety_complaints SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE girl_safety_complaints ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE girl_safety_complaints ADD CONSTRAINT fk_girl_safety_complaints_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_girl_safety_complaints_school_id ON girl_safety_complaints(school_id);
ALTER TABLE girl_safety_complaints DROP CONSTRAINT IF EXISTS girl_safety_complaints_ticket_no_key;
ALTER TABLE girl_safety_complaints ADD CONSTRAINT unique_girl_safety_ticket_per_school UNIQUE (school_id, ticket_no);

-- ════════════════════════════════════════════
-- TABLE: girl_safety_complaint_threads
-- ════════════════════════════════════════════
ALTER TABLE girl_safety_complaint_threads ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE girl_safety_complaint_threads SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE girl_safety_complaint_threads ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE girl_safety_complaint_threads ADD CONSTRAINT fk_girl_safety_threads_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_girl_safety_threads_school_id ON girl_safety_complaint_threads(school_id);

-- ════════════════════════════════════════════
-- TABLE: school_settings
-- Unique: key is PK → scope to school (change PK)
-- ════════════════════════════════════════════
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE school_settings SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE school_settings ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE school_settings ADD CONSTRAINT fk_school_settings_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_school_settings_school_id ON school_settings(school_id);
-- PK was on (key) alone, we need (school_id, key). Drop old PK and add new.
ALTER TABLE school_settings DROP CONSTRAINT IF EXISTS school_settings_pkey;
ALTER TABLE school_settings ADD PRIMARY KEY (school_id, key);

-- ════════════════════════════════════════════
-- TABLE: admin_notifications
-- ════════════════════════════════════════════
ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE admin_notifications SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE admin_notifications ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE admin_notifications ADD CONSTRAINT fk_admin_notifications_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_admin_notifications_school_id ON admin_notifications(school_id);

-- ════════════════════════════════════════════
-- TABLE: access_requests
-- ════════════════════════════════════════════
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE access_requests SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE access_requests ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE access_requests ADD CONSTRAINT fk_access_requests_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_access_requests_school_id ON access_requests(school_id);

-- ════════════════════════════════════════════
-- TABLE: temp_access_grants
-- ════════════════════════════════════════════
ALTER TABLE temp_access_grants ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE temp_access_grants SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE temp_access_grants ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE temp_access_grants ADD CONSTRAINT fk_temp_access_grants_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_temp_access_grants_school_id ON temp_access_grants(school_id);

-- ════════════════════════════════════════════
-- TABLE: feature_flags
-- Unique: code UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE feature_flags SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE feature_flags ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE feature_flags ADD CONSTRAINT fk_feature_flags_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_feature_flags_school_id ON feature_flags(school_id);
ALTER TABLE feature_flags DROP CONSTRAINT IF EXISTS feature_flags_code_key;
ALTER TABLE feature_flags ADD CONSTRAINT unique_feature_flags_code_per_school UNIQUE (school_id, code);

-- ════════════════════════════════════════════
-- TABLE: ui_route_permissions
-- Unique: route_key UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE ui_route_permissions ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE ui_route_permissions SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE ui_route_permissions ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE ui_route_permissions ADD CONSTRAINT fk_ui_route_permissions_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_ui_route_permissions_school_id ON ui_route_permissions(school_id);
ALTER TABLE ui_route_permissions DROP CONSTRAINT IF EXISTS ui_route_permissions_route_key_key;
ALTER TABLE ui_route_permissions ADD CONSTRAINT unique_ui_route_perm_route_key_per_school UNIQUE (school_id, route_key);

-- ════════════════════════════════════════════
-- VIEWS/MATERIALIZED: active_persons, active_students
-- These look like views. Adding school_id column.
-- ════════════════════════════════════════════
ALTER TABLE active_persons ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE active_persons SET school_id = 1 WHERE school_id IS NULL;

ALTER TABLE active_students ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE active_students SET school_id = 1 WHERE school_id IS NULL;

-- debug_class_teachers, debug_role_permissions are views
-- They will inherit school_id from their base tables automatically.

COMMIT;
