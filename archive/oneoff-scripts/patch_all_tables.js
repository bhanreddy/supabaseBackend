import fs from 'fs';

// 1. Read the current schema.sql
let schema = fs.readFileSync('schema.sql', 'utf8');

// 2. Define ALL tables that MUST have school_id (extracted from find_tables.js)
const tables = [
    "academic_years", "academic_terms", "bus_locations", "buses", "class_sections", "class_subjects", "classes",
    "complaints", "daily_attendance", "diary_entries", "discipline_records", "events", "exam_subjects", "exams",
    "expenses", "fee_structures", "fee_transactions", "fee_types", "financial_audit_logs", "financial_policy_rules",
    "grading_scales", "hostel_allocations", "hostel_blocks", "hostel_rooms", "leave_applications", "life_values_modules",
    "lms_courses", "lms_materials", "marks", "money_science_modules", "notices", "notification_batches", "notification_logs",
    "parents", "periods", "permissions", "person_contacts", "persons", "receipt_items", "receipts", "role_permissions",
    "roles", "science_projects", "sections", "staff", "staff_attendance", "staff_payroll", "staff_statuses",
    "student_enrollments", "student_fees", "student_life_values_progress", "student_money_science_progress",
    "student_parents", "student_science_projects", "student_statuses", "student_transport", "students", "subjects",
    "transport_routes", "transport_stops", "trip_stop_status", "trips", "user_devices", "user_roles", "user_settings", "users"
];

// 3. Clean up previous ENSURE blocks
schema = schema.replace(/\n-- ENSURE SCHOOL_ID ON ALL TABLES[\s\S]*?CREATE INDEX IF NOT EXISTS idx_countries_school_id/gi, '\nCREATE INDEX IF NOT EXISTS idx_countries_school_id');
schema = schema.replace(/\n-- ENSURE SCHOOL_ID ON REFERENCE TABLES[\s\S]*?CREATE INDEX IF NOT EXISTS idx_countries_school_id/gi, '\nCREATE INDEX IF NOT EXISTS idx_countries_school_id');

let alterStatements = '\n-- ENSURE SCHOOL_ID ON ALL TABLES\n';
tables.forEach(table => {
    alterStatements += `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE;\n`;
});

// 4. Insert BEFORE the FIRST index (idx_countries_school_id)
schema = schema.replace(/CREATE INDEX IF NOT EXISTS idx_countries_school_id/gi, alterStatements + '\nCREATE INDEX IF NOT EXISTS idx_countries_school_id');

// 5. Write back to schema.sql
fs.writeFileSync('schema.sql', schema);
console.log('Patched schema.sql with ALL 66 tables for school_id ensure.');
