import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import postgres from 'postgres';

// Only run against an explicitly supplied disposable local database.
const url = process.env.EMPLOYEE_LEAVE_TEST_DATABASE_URL;
test('employee leave permissions for existing and future schools', { skip: !url }, async (t) => {
  const parsed = new URL(url);
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname)
    && /^\/employee_leave_test(?:_|$)/.test(parsed.pathname), 'Use a disposable local employee_leave_test database');
  const db = postgres(url, { max: 1, onnotice() {} });
  t.after(() => db.end());
  await db.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE schools (id integer PRIMARY KEY);
    CREATE TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, code text, deleted_at timestamptz, UNIQUE(school_id,code));
    CREATE TABLE permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, code text, name text, UNIQUE(school_id,code));
    CREATE TABLE role_permissions (school_id integer, role_id uuid REFERENCES roles(id), permission_id uuid REFERENCES permissions(id), PRIMARY KEY(role_id,permission_id));
    INSERT INTO schools VALUES (1),(2);
    INSERT INTO roles(school_id,code) SELECT s.id,v FROM schools s CROSS JOIN unnest(ARRAY['accounts','librarian','staff','student']) v;
    INSERT INTO permissions(school_id,code) SELECT s.id,'leaves.approve' FROM schools s;
    CREATE FUNCTION test_seed_defaults() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO roles(school_id,code) VALUES (NEW.id,'accounts'); RETURN NEW;
    END $$;
    CREATE TRIGGER trg_school_seed_defaults AFTER INSERT ON schools FOR EACH ROW EXECUTE FUNCTION test_seed_defaults();
    CREATE FUNCTION test_seed_library() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO roles(school_id,code) VALUES (NEW.id,'librarian'); RETURN NEW;
    END $$;
    CREATE TRIGGER zz_trg_school_library_access AFTER INSERT ON schools FOR EACH ROW EXECUTE FUNCTION test_seed_library();`);
  const migration = await fs.readFile(new URL('../migrations/20261116_employee_leave_access.sql', import.meta.url), 'utf8');
  const apply = () => db.begin(tx => tx.unsafe(migration.replace(/^BEGIN;|^COMMIT;/gm, '')));
  await apply();
  await apply();
  await db`INSERT INTO schools VALUES (3)`;
  for (const schoolId of [1, 2, 3]) {
    const rows = await db`
      SELECT r.code AS role, p.code AS permission
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.school_id = ${schoolId}
      ORDER BY r.code, p.code`;
    assert.deepEqual([...rows], [
      { role: 'accounts', permission: 'leaves.apply' }, { role: 'accounts', permission: 'leaves.view' },
      { role: 'librarian', permission: 'leaves.apply' }, { role: 'librarian', permission: 'leaves.view' },
    ]);
  }
  const [crossTenant] = await db`
    SELECT count(*)::int AS count FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.school_id <> r.school_id OR rp.school_id <> p.school_id`;
  assert.equal(crossTenant.count, 0);
});
