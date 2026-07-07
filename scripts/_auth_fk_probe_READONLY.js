// READ-ONLY: auth.* FK children of auth.users + their on-delete rules; and per-child counts for the 1458 student logins.
import sql from '../db.js';
import fs from 'fs';
import path from 'path';
function latestBackup(){const d=path.resolve('./backups');const f=fs.readdirSync(d).filter(x=>x.startsWith('school17_students_backup_')).sort().pop();return path.join(d,f);}
async function main(){
  const bk=JSON.parse(fs.readFileSync(latestBackup(),'utf8'));
  const ids=[...new Set((bk.tables.users||[]).map(u=>u.id).filter(Boolean))];
  console.log('student auth ids:', ids.length);

  console.log('\n--- FK children of auth.users (table.col -> on_delete) ---');
  console.log(await sql.unsafe(`
    SELECT cl.relname AS child, att.attname AS col, con.confdeltype AS on_delete
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid=con.conrelid
    JOIN pg_class clf ON clf.oid=con.confrelid
    JOIN pg_namespace n ON n.oid=cl.relnamespace
    JOIN pg_namespace nf ON nf.oid=clf.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY ck(attnum,ord) ON true
    JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=ck.attnum
    WHERE con.contype='f' AND clf.relname='users' AND nf.nspname='auth'
    ORDER BY child`));

  console.log('\n--- counts in auth child tables for these 1458 ids (c=CASCADE handles them) ---');
  for (const [t,col] of [['identities','user_id'],['sessions','user_id'],['mfa_factors','user_id'],['one_time_tokens','user_id']]) {
    try { const r=await sql.unsafe(`SELECT count(*)::int n FROM auth.${t} WHERE ${col} IN ${'('+ids.map(i=>`'${i}'`).join(',')+')'}`); console.log(`  auth.${t.padEnd(16)} = ${r[0].n}`);} catch(e){console.log(`  auth.${t} -> ${e.message}`);}
  }

  console.log('\n--- public-schema FKs still pointing at these ids? (should be none post-purge) ---');
  const r = await sql`SELECT count(*)::int n FROM public.users WHERE id IN ${sql(ids)}`;
  console.log('  public.users still present with these ids:', r[0].n);

  await sql.end();
}
main().catch(async e=>{console.error('FAILED:',e.message);try{await sql.end();}catch{}process.exit(1);});
