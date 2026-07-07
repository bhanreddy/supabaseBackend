import fs from 'fs';

// 1. Read the backup
let schema = fs.readFileSync('schema_patched3.sql', 'utf8');

// 2. Remove ALL multiline comments /* ... */
schema = schema.replace(/\/\*[\s\S]*?\*\//g, '');

// 3. Fix premature function endings (Join blocks) - GLOBAL FLAG ADDED
schema = schema.replace(
    /END;[\s\r\n]*\$\$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;(?=[\s\r\n\-]*(?:--.*[\s\r\n]*)*RETURN QUERY)/gi,
    ""
);

// 4. Ensure RLS Policy Idempotency (Add DROP POLICY IF EXISTS before CREATE POLICY)
schema = schema.replace(
    /CREATE POLICY\s+"([^"]+)"\s+ON\s+([\w.]+)/gi,
    "DROP POLICY IF EXISTS \"$1\" ON $2; CREATE POLICY \"$1\" ON $2"
);

// 5. Comment out the ALTER FUNCTION loop that causes "not unique" errors
schema = schema.replace(
    /DO \$\$ \s*DECLARE\s+func_name TEXT;\s*BEGIN\s*FOR func_name IN \s*SELECT unnest\(ARRAY\[[\s\S]*?EXECUTE format\('ALTER FUNCTION %I SET search_path = ''public'''[\s\S]*?END LOOP;\s*END \$\$;/gi,
    "/* ALTER FUNCTION loop removed because it fails on overloaded functions */"
);

// 6. Comment out invalid ALTER TABLE on Views (both ADD COLUMN and ENABLE ROW LEVEL SECURITY)
schema = schema.replace(
    /ALTER TABLE IF EXISTS (active_persons|active_students|debug_class_teachers|debug_role_permissions) ADD COLUMN IF NOT EXISTS .*?;/gi,
    "-- $&"
);
// Make the regex for RLS on views permissive of whitespace and newlines
schema = schema.replace(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(active_persons|active_students|debug_class_teachers|debug_role_permissions)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\s*;/gi,
    "-- $&"
);

// 7. Fix invalid data types globally FIRST
schema = schema.replace(/ARRAY DEFAULT/gi, "text[] DEFAULT");
schema = schema.replace(/ARRAY,/gi, "text[],"); // Catch inside CREATE TABLE feature_flags
schema = schema.replace(/ARRAY;/gi, "text[];"); // Catch inside ALTER TABLE
schema = schema.replace(/USER-DEFINED/gi, "day_of_week_enum");

// 8. Syntax Fixes & Constraint Idempotency
schema = schema.replace(
    /ALTER TABLE notification_batches ADD\s+\(type IN \('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER'\)\);/g,
    "ALTER TABLE notification_batches ADD CONSTRAINT notification_batches_type_check_v2 CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER')) NOT VALID;"
);

// Ensure ADD CONSTRAINT is idempotent by prefixing with DROP CONSTRAINT IF EXISTS
// Matches: ALTER TABLE [IF EXISTS] table_name ADD CONSTRAINT constraint_name ...;
schema = schema.replace(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s+ADD\s+CONSTRAINT\s+([a-zA-Z0-9_]+)\s+(CHECK|UNIQUE|FOREIGN KEY|PRIMARY KEY)[\s\S]*?;/gi,
    "ALTER TABLE IF EXISTS $1 DROP CONSTRAINT IF EXISTS $2;\n$&"
);

// Fix the constraint issue at the end of the file related to old data.
schema = schema.replace(
    /ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK \(type IN \('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'ATTENDANCE', 'CUSTOM'\)\);/gi,
    "ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'ATTENDANCE', 'CUSTOM', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER')) NOT VALID;"
);

// Instead of applying NOT VALID globally across DO blocks, apply it to specific ones causing violation issues
schema = schema.replace(
    /ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK \(attendance_date <= current_date\);/gi,
    "ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date) NOT VALID;"
);
schema = schema.replace(
    /ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK \(end_date >= start_date\);/gi,
    "ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK (end_date >= start_date) NOT VALID;"
);
schema = schema.replace(
    /ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK \(refund_of IS NULL OR amount < 0\);/gi,
    "ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0) NOT VALID;"
);
schema = schema.replace(
    /ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK \(discount <= amount_due\);/gi,
    "ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due) NOT VALID;"
);


// Add missing unique constraints on seed tables that use ON CONFLICT
const missingConstraints = `
ALTER TABLE IF EXISTS periods DROP CONSTRAINT IF EXISTS periods_name_key;
ALTER TABLE IF EXISTS periods ADD CONSTRAINT periods_name_key UNIQUE (school_id, name);

ALTER TABLE IF EXISTS roles DROP CONSTRAINT IF EXISTS roles_code_key;
ALTER TABLE IF EXISTS roles ADD CONSTRAINT roles_code_key UNIQUE (school_id, code);

ALTER TABLE IF EXISTS permissions DROP CONSTRAINT IF EXISTS permissions_code_key;
ALTER TABLE IF EXISTS permissions ADD CONSTRAINT permissions_code_key UNIQUE (school_id, code);

ALTER TABLE IF EXISTS feature_flags DROP CONSTRAINT IF EXISTS feature_flags_code_key;
ALTER TABLE IF EXISTS feature_flags ADD CONSTRAINT feature_flags_code_key UNIQUE (school_id, code);

ALTER TABLE IF EXISTS ui_route_permissions DROP CONSTRAINT IF EXISTS ui_route_permissions_route_key_key;
ALTER TABLE IF EXISTS ui_route_permissions ADD CONSTRAINT ui_route_permissions_route_key_key UNIQUE (school_id, route_key);
`;
// Only insert missingConstraints ONCE before the very firstINSERT INTO periods occurrence
let constraintsInserted = false;
schema = schema.replace(/INSERT INTO periods/gi, (match) => {
    if (!constraintsInserted) {
        constraintsInserted = true;
        return missingConstraints + "\n" + match;
    }
    return match;
});

// Update ON CONFLICT rules to match multi-tenant unique keys
schema = schema.replace(/ON CONFLICT \(name\)/gi, "ON CONFLICT (school_id, name)");
schema = schema.replace(/ON CONFLICT \(code\)/gi, "ON CONFLICT (school_id, code)");
schema = schema.replace(/ON CONFLICT \(route_key\)/gi, "ON CONFLICT (school_id, route_key)");


// 9. Fix malformed new table creations at the bottom of the schema
// 9A. feature_flags: `is_enabled boolean DEFAULT false` (missing comma in original)
schema = schema.replace(
    /is_enabled boolean DEFAULT false[\s\r\n]*target_roles/gi,
    "is_enabled boolean DEFAULT false,\n  target_roles"
);

// 9B. timetable_entries constraints trailing commas
schema = schema.replace(
    /CONSTRAINT timetable_entries_class_section_id_period_id_day_of_week_key UNIQUE \(school_id, class_section_id, period_id, day_of_week\) -- TODO: VERIFY,/gi,
    "CONSTRAINT timetable_entries_class_section_id_period_id_day_of_week_key UNIQUE (school_id, class_section_id, period_id, day_of_week) -- TODO: VERIFY"
);
schema = schema.replace(
    /CONSTRAINT timetable_entries_class_section_id_fkey FOREIGN KEY \(class_section_id\) REFERENCES class_sections\(id\) -- TODO: VERIFY,/gi,
    "CONSTRAINT timetable_entries_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id) -- TODO: VERIFY"
);
schema = schema.replace(
    /CONSTRAINT timetable_entries_subject_id_fkey FOREIGN KEY \(subject_id\) REFERENCES subjects\(id\) -- TODO: VERIFY,/gi,
    "CONSTRAINT timetable_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id) -- TODO: VERIFY"
);
schema = schema.replace(
    /CONSTRAINT timetable_entries_teacher_id_fkey FOREIGN KEY \(teacher_id\) REFERENCES staff\(id\) -- TODO: VERIFY,/gi,
    "CONSTRAINT timetable_entries_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES staff(id) -- TODO: VERIFY"
);

// 9C. ui_route_permissions invalid type "ARRAY NOT NULL" => "text[] NOT NULL"
schema = schema.replace(/required_permissions ARRAY NOT NULL/gi, "required_permissions text[] NOT NULL");

// 9D. Hard replace of the entire timetable_entries CREATE TABLE block to be safe,
// because there is some weirdness occurring when node scripts apply it.
schema = schema.replace(
    /CREATE TABLE IF NOT EXISTS timetable_entries \([\s\S]*?CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY \(period_id\) REFERENCES periods\(id\) -- TODO: VERIFY\s*\);/gi,
    `CREATE TABLE IF NOT EXISTS timetable_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
  class_section_id uuid NOT NULL,
  subject_id uuid,
  teacher_id uuid,
  period_id uuid NOT NULL,
  day_of_week day_of_week_enum NOT NULL,
  room character varying(50),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT timetable_entries_pkey PRIMARY KEY (id),
  CONSTRAINT timetable_entries_class_section_id_period_id_day_of_week_key UNIQUE (school_id, class_section_id, period_id, day_of_week),
  CONSTRAINT timetable_entries_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id),
  CONSTRAINT timetable_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id),
  CONSTRAINT timetable_entries_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES staff(id),
  CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES periods(id)
);`
);


// 10. Comment out ALTER ROLE authenticator
schema = schema.replace(
    /ALTER ROLE authenticator SET app\.settings\.sessions\.timebox = '31536000';/g,
    "-- ALTER ROLE authenticator SET app.settings.sessions.timebox = '31536000';"
);
schema = schema.replace(
    /ALTER ROLE authenticator SET app\.settings\.sessions\.inactivity_timeout = '0';/g,
    "-- ALTER ROLE authenticator SET app.settings.sessions.inactivity_timeout = '0';"
);

// 11. Mass replace duplicate_object with others
schema = schema.replace(/EXCEPTION WHEN duplicate_object THEN null;/g, "EXCEPTION WHEN others THEN null;");

// 12. Fix views (DROP VIEW IF EXISTS CASCADE before each)
schema = schema.replace(/CREATE OR REPLACE VIEW\s+([\w.]+)\s+AS/gi, "DROP VIEW IF EXISTS $1 CASCADE; CREATE OR REPLACE VIEW $1 AS");

// 13. Ensure school_id on all 73 tables
const tables = [
    "countries", "genders", "student_categories", "religions", "blood_groups", "relationship_types", "staff_designations",
    "academic_years", "academic_terms", "bus_locations", "buses", "class_sections", "class_subjects", "classes",
    "complaints", "daily_attendance", "diary_entries", "discipline_records", "events", "exam_subjects", "exams",
    "expenses", "fee_structures", "fee_transactions", "fee_types", "financial_audit_logs", "financial_policy_rules",
    "grading_scales", "hostel_allocations", "hostel_blocks", "hostel_rooms", "leave_applications", "life_values_modules",
    "lms_courses", "lms_materials", "marks", "money_science_modules", "notices", "notification_batches", "notification_logs",
    "parents", "periods", "permissions", "person_contacts", "persons", "receipt_items", "receipts", "role_permissions",
    "roles", "science_projects", "sections", "staff", "staff_attendance", "staff_payroll", "staff_statuses",
    "student_enrollments", "student_fees", "student_life_values_progress", "student_money_science_progress",
    "student_parents", "student_science_projects", "student_statuses", "student_transport", "students", "subjects",
    "transport_routes", "transport_stops", "trip_stop_status", "trips", "user_devices", "user_roles", "user_settings", "users",
    "feature_flags", "ui_route_permissions", "timetable_entries", "driver_heartbeat", "driver_devices"
];

let alterStatements = '\n-- ENSURE SCHOOL_ID ON ALL TABLES\n';
tables.forEach(table => {
    // Avoid double-adding if we already hand-fixed it above
    if (table !== 'timetable_entries') {
        alterStatements += `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE;\n`;
    }
});

schema = schema.replace(/CREATE INDEX IF NOT EXISTS idx_countries_school_id/gi, alterStatements + '\nCREATE INDEX IF NOT EXISTS idx_countries_school_id');

// 14. Write back to schema.sql
fs.writeFileSync('schema.sql', schema);
console.log('Final fixed schema.sql restored and patched (v29 - manual constraint fixes).');
