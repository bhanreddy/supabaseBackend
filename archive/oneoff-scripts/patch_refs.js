import fs from 'fs';

// 1. Read the current schema.sql
let schema = fs.readFileSync('schema.sql', 'utf8');

// 2. Remove the misplaced ALTER TABLE statements if they exist
schema = schema.replace(/\n-- ENSURE SCHOOL_ID ON REFERENCE TABLES[\s\S]*?-- 1b\. SEED REFERENCE DATA/gi, '\n-- 1b. SEED REFERENCE DATA');

// 3. Define the ALTER TABLE statements
const refTables = ['countries', 'genders', 'student_categories', 'religions', 'blood_groups', 'relationship_types', 'staff_designations'];
let alterStatements = '\n-- ENSURE SCHOOL_ID ON REFERENCE TABLES\n';
refTables.forEach(table => {
    alterStatements += `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE;\n`;
});

// 4. Insert them BEFORE the indices (which start with idx_countries_school_id)
schema = schema.replace(/CREATE INDEX IF NOT EXISTS idx_countries_school_id/gi, alterStatements + '\nCREATE INDEX IF NOT EXISTS idx_countries_school_id');

// 5. Write back to schema.sql
fs.writeFileSync('schema.sql', schema);
console.log('Fixed order of ALTER TABLE statements in schema.sql.');
