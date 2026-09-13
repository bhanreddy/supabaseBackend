import fs from 'node:fs';

// Reuse real column types, FKs, financial checks and exclusion constraints from
// the repository schema. Only the unrelated application triggers are omitted.
export async function createFeeRecoveryFixture(db) {
  const schema = fs.readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
  const tables = new Map([...schema.matchAll(/^CREATE TABLE IF NOT EXISTS (?:public\.)?(\w+) \([\s\S]*?^\);/gm)].map(m => [m[1], m[0]]));
  await db.unsafe('CREATE EXTENSION IF NOT EXISTS btree_gist');
  for (const match of schema.matchAll(/CREATE TYPE \w+ AS ENUM\s*\([\s\S]*?\);/g)) await db.unsafe(match[0]);
  const made = new Set();
  async function make(name) {
    if (made.has(name)) return;
    const ddl = tables.get(name);
    if (!ddl) throw new Error(`Fixture missing schema table ${name}`);
    made.add(name);
    for (const match of ddl.matchAll(/REFERENCES (\w+)\(/g)) if (match[1] !== name) await make(match[1]);
    await db.unsafe(ddl);
  }
  for (const name of ['student_fees', 'fee_transactions', 'student_parents', 'student_enrollments', 'person_contacts', 'receipt_items', 'roles', 'user_roles']) await make(name);
  await db.unsafe(`CREATE TABLE audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer NOT NULL REFERENCES schools(id), user_id uuid REFERENCES users(id), action text, entity text, entity_id text, details jsonb);
    CREATE TABLE school_feature_flags (school_id integer REFERENCES schools(id), role text, feature_key text, enabled boolean, PRIMARY KEY(school_id,role,feature_key));
    CREATE TABLE daily_attendance (attendance_date date, student_enrollment_id uuid, status text);
    CREATE TABLE marks (exam_subject_id uuid, student_enrollment_id uuid);`);
  // Real authoritative payment balance/status triggers, including negative refunds.
  for (const name of ['update_fee_paid_amount', 'update_fee_status']) {
    const start = schema.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);
    const end = schema.indexOf('$$ LANGUAGE plpgsql;', start) + '$$ LANGUAGE plpgsql;'.length;
    await db.unsafe(schema.slice(start, end));
  }
  await db.unsafe(`CREATE TRIGGER fixture_payment AFTER INSERT ON fee_transactions FOR EACH ROW EXECUTE FUNCTION update_fee_paid_amount();
    CREATE TRIGGER fixture_status BEFORE UPDATE ON student_fees FOR EACH ROW EXECUTE FUNCTION update_fee_status();`);
}
