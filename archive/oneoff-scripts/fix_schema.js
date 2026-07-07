import fs from 'fs';

// 1. Read the backup
let schema = fs.readFileSync('schema_patched3.sql', 'utf8');

// 2. Fix notification_batches constraint syntax (if present)
schema = schema.replace(
    /ALTER TABLE notification_batches ADD\s+\(type IN \('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER'\)\);/g,
    "ALTER TABLE notification_batches ADD CONSTRAINT notification_batches_type_check_v2 CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER'));"
);

// 3. Comment out ALTER ROLE authenticator
schema = schema.replace(
    /ALTER ROLE authenticator SET app\.settings\.sessions\.timebox = '31536000';/g,
    "-- ALTER ROLE authenticator SET app.settings.sessions.timebox = '31536000';"
);
schema = schema.replace(
    /ALTER ROLE authenticator SET app\.settings\.sessions\.inactivity_timeout = '0';/g,
    "-- ALTER ROLE authenticator SET app.settings.sessions.inactivity_timeout = '0';"
);

// 4. Comment out conflicting debug alterations
schema = schema.replace(
    /ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS class_name character varying\(50\);/g,
    "-- ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS class_name character varying(50);"
);
schema = schema.replace(
    /ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS section_name character varying\(50\);/g,
    "-- ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS section_name character varying(50);"
);
schema = schema.replace(
    /ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS teacher_name text;/g,
    "-- ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS teacher_name text;"
);
schema = schema.replace(
    /ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS academic_year character varying\(20\);/g,
    "-- ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS academic_year character varying(20);"
);
schema = schema.replace(
    /ALTER TABLE IF EXISTS debug_role_permissions ADD COLUMN IF NOT EXISTS role character varying\(50\);/g,
    "-- ALTER TABLE IF EXISTS debug_role_permissions ADD COLUMN IF NOT EXISTS role character varying(50);"
);
schema = schema.replace(
    /ALTER TABLE IF EXISTS debug_role_permissions ADD COLUMN IF NOT EXISTS permissions text;/g,
    "-- ALTER TABLE IF EXISTS debug_role_permissions ADD COLUMN IF NOT EXISTS permissions text;"
);

// 5. Improve idempotency of constraints (mass replace duplicate_object)
schema = schema.replace(/EXCEPTION WHEN duplicate_object THEN null;/g, "EXCEPTION WHEN others THEN null;");

// 6. Ensure views are preceded by DROP VIEW IF EXISTS CASCADE
// We first remove any existing DROP VIEW IF EXISTS right before the CREATE VIEW to avoid duplication
schema = schema.replace(/DROP VIEW IF EXISTS\s+([\w.]+)\s+CASCADE;\s+CREATE OR REPLACE VIEW/gi, 'CREATE OR REPLACE VIEW');
// Now we add it back for ALL views
schema = schema.replace(/CREATE OR REPLACE VIEW\s+([\w.]+)\s+AS/gi, "DROP VIEW IF EXISTS $1 CASCADE; CREATE OR REPLACE VIEW $1 AS");

// 7. Write back to schema.sql
fs.writeFileSync('schema.sql', schema);
console.log('Fixed schema.sql restored from schema_patched3.sql and patched.');
