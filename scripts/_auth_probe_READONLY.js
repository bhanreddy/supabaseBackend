// READ-ONLY: map school-17 student logins in auth.users using ids from the backup.
import sql from '../db.js';
import fs from 'fs';
import path from 'path';

function latestBackup() {
  const dir = path.resolve('./backups');
  const f = fs.readdirSync(dir).filter(x => x.startsWith('school17_students_backup_')).sort().pop();
  return path.join(dir, f);
}

async function main() {
  const bk = JSON.parse(fs.readFileSync(latestBackup(), 'utf8'));
  const studentAuthIds = [...new Set((bk.tables.students || []).map(s => s.auth_user_id).filter(Boolean))];
  const deletedPublicUserIds = [...new Set((bk.tables.users || []).map(u => u.id).filter(Boolean))];
  console.log('backup:', path.basename(latestBackup()));
  console.log('students.auth_user_id (non-null):', studentAuthIds.length);
  console.log('deleted public.users ids       :', deletedPublicUserIds.length);

  // does auth schema exist / can we read it?
  console.log('\n--- auth.users columns sample ---');
  console.log((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='users' ORDER BY ordinal_position`).map(r=>r.column_name).join(', '));

  console.log('\n--- auth.users total with email like %@ghs.com ---');
  console.log(await sql`SELECT count(*)::int n FROM auth.users WHERE email ILIKE '%@ghs.com'`);

  console.log('\n--- sample 5 @ghs.com auth emails ---');
  console.log(await sql`SELECT id, email, created_at FROM auth.users WHERE email ILIKE '%@ghs.com' ORDER BY created_at LIMIT 5`);

  // how many @ghs.com auth users are covered by the backup id-sets?
  const inAuthSet = async (ids) => {
    if (!ids.length) return 0;
    const r = await sql`SELECT count(*)::int n FROM auth.users WHERE id IN ${sql(ids)}`;
    return r[0].n;
  };
  console.log('\n--- coverage check ---');
  console.log('auth.users matching students.auth_user_id  :', await inAuthSet(studentAuthIds));
  console.log('auth.users matching deleted public.users ids:', await inAuthSet(deletedPublicUserIds));

  // Are there @ghs.com auth users NOT in either backup set? (would indicate extra scope)
  const union = [...new Set([...studentAuthIds, ...deletedPublicUserIds])];
  const ghsRows = await sql`SELECT id, email FROM auth.users WHERE email ILIKE '%@ghs.com'`;
  const unionSet = new Set(union);
  const notCovered = ghsRows.filter(r => !unionSet.has(r.id));
  console.log('@ghs.com auth users NOT in backup id-sets   :', notCovered.length);
  if (notCovered.length) console.log('  sample not-covered:', notCovered.slice(0,5));

  // Make sure the 5 surviving staff/admin are NOT in our delete set & what domain they use
  console.log('\n--- surviving school-17 staff/admin public.users -> their auth emails ---');
  const staffPublic = await sql`SELECT id, person_id FROM public.users WHERE school_id=17`;
  const staffIds = staffPublic.map(u=>u.id);
  if (staffIds.length) {
    console.log(await sql`SELECT id, email FROM auth.users WHERE id IN ${sql(staffIds)}`);
    console.log('staff ids present in student delete set?', staffIds.filter(id=>unionSet.has(id)).length);
  }

  await sql.end();
}
main().catch(async e=>{console.error('FAILED:',e.message);try{await sql.end();}catch{}process.exit(1);});
