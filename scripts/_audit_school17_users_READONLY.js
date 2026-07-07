// READ-ONLY. How are student/parent logins distinguished from staff/admin in school 17?
import sql from '../db.js';
const S = 17;
const cols = async (t) => (await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=${t} ORDER BY ordinal_position`);
async function main() {
  for (const t of ['users', 'persons', 'parents', 'students', 'roles', 'user_roles', 'person_contacts', 'parents']) {
    console.log(`\n=== columns: ${t} ===`);
    console.log((await cols(t)).map(c => `${c.column_name}:${c.data_type}`).join(', '));
  }

  console.log('\n=== roles in school 17 (id, name) ===');
  console.log(await sql`SELECT id, name FROM roles WHERE school_id=${S} ORDER BY id`);

  console.log('\n=== user_roles breakdown for school 17 (role -> #users) ===');
  console.log(await sql`
    SELECT r.name AS role, count(*)::int AS users
    FROM user_roles ur JOIN roles r ON r.id=ur.role_id
    WHERE ur.school_id=${S} GROUP BY r.name ORDER BY users DESC`);

  console.log('\n=== persons: how to tell person_type? distinct columns sample ===');
  console.log(await sql`SELECT * FROM persons WHERE school_id=${S} LIMIT 1`);

  console.log('\n=== users sample (1 row, keys only) ===');
  const u = await sql`SELECT * FROM users WHERE school_id=${S} LIMIT 1`;
  console.log(u.length ? Object.keys(u[0]).join(', ') : '(none)');

  console.log('\n=== Does users link to person_id? students.person_id / parents.person_id present? ===');
  console.log('students sample person link:', await sql`SELECT id, person_id FROM students WHERE school_id=${S} LIMIT 1`);
  console.log('parents sample person link:', await sql`SELECT id, person_id FROM parents WHERE school_id=${S} LIMIT 1`);

  // Are there users that are NOT student/parent? Try to identify staff/admin users.
  console.log('\n=== staff persons vs student/parent persons count (via persons<-students/parents/staff) ===');
  console.log('student persons:', (await sql`SELECT count(DISTINCT person_id)::int n FROM students WHERE school_id=${S}`)[0].n);
  console.log('parent  persons:', (await sql`SELECT count(DISTINCT person_id)::int n FROM parents  WHERE school_id=${S}`)[0].n);
  console.log('staff   persons:', (await sql`SELECT count(DISTINCT person_id)::int n FROM staff    WHERE school_id=${S}`)[0].n);
  console.log('total   persons:', (await sql`SELECT count(*)::int n FROM persons WHERE school_id=${S}`)[0].n);

  // How are users tied to a person / student / parent / staff?
  console.log('\n=== sample 5 users with their role names ===');
  console.log(await sql`
    SELECT u.id, u.${sql('school_id')} AS sid, COALESCE(string_agg(r.name, ','), '(none)') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id=u.id
    LEFT JOIN roles r ON r.id=ur.role_id
    WHERE u.school_id=${S}
    GROUP BY u.id LIMIT 5`);

  await sql.end();
}
main().catch(async e => { console.error('FAILED:', e.message); try { await sql.end(); } catch {} process.exit(1); });
