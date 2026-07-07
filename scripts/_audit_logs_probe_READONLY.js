// READ-ONLY: investigate audit_logs / financial_audit_logs rows owned by school-17 student logins.
import sql from '../db.js';
const S = 17;
async function main() {
  const suser = `(
    SELECT DISTINCT ur.user_id AS id FROM user_roles ur JOIN roles r ON r.id=ur.role_id
    WHERE ur.school_id=${S} AND r.name='Student'
      AND ur.user_id NOT IN (SELECT ur2.user_id FROM user_roles ur2 JOIN roles r2 ON r2.id=ur2.role_id
                             WHERE ur2.school_id=${S} AND r2.name<>'Student'))`;

  console.log('--- audit_logs columns ---');
  console.log((await sql`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' ORDER BY ordinal_position`).map(r=>`${r.column_name}:${r.data_type}(${r.is_nullable})`).join(', '));

  console.log('\n--- audit_logs rows owned by student users: total + school_id distribution ---');
  console.log(await sql.unsafe(`SELECT school_id, count(*)::int AS n FROM audit_logs WHERE user_id IN ${suser} GROUP BY school_id ORDER BY school_id`));

  console.log('\n--- audit_logs total where school_id=17 (any user) ---');
  console.log(await sql`SELECT count(*)::int n FROM audit_logs WHERE school_id=${S}`);

  console.log('\n--- sample 3 such audit_logs rows ---');
  console.log(await sql.unsafe(`SELECT * FROM audit_logs WHERE user_id IN ${suser} LIMIT 3`));

  console.log('\n--- financial_audit_logs owned by student users (school_id distribution) ---');
  console.log(await sql.unsafe(`SELECT school_id, count(*)::int AS n FROM financial_audit_logs WHERE performed_by IN ${suser} GROUP BY school_id ORDER BY school_id`));

  await sql.end();
}
main().catch(async e=>{console.error('FAILED:',e.message);try{await sql.end();}catch{}process.exit(1);});
