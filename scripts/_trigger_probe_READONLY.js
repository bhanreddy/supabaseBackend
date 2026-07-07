// READ-ONLY: enumerate triggers on financial tables + check our role/privileges.
import sql from '../db.js';
async function main() {
  console.log('--- current_user / role ---');
  console.log(await sql`SELECT current_user, session_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS is_super`);

  const tables = ['fee_transactions','student_fees','receipts','receipt_items','defaulter_dues','defaulter_payments','transport_fee_payments','students','persons','users'];
  console.log('\n--- user triggers on candidate tables (tgenabled: O=enabled, D=disabled, R/A=replica) ---');
  console.log(await sql.unsafe(`
    SELECT c.relname AS table, t.tgname AS trigger, t.tgenabled,
           pg_get_triggerdef(t.oid) AS def,
           pg_get_userbyid(c.relowner) AS table_owner
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal
      AND c.relname IN (${tables.map(t=>`'${t}'`).join(',')})
    ORDER BY c.relname, t.tgname`));

  console.log('\n--- can we SET session_replication_role? (test in a throwaway tx) ---');
  try {
    await sql.begin(async tx => {
      await tx.unsafe(`SET LOCAL session_replication_role = 'replica'`);
      const r = await tx.unsafe(`SHOW session_replication_role`);
      console.log('  OK ->', r[0]);
      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message === '__rollback__') console.log('  (rolled back test)');
    else console.log('  CANNOT set session_replication_role:', e.message);
  }

  console.log('\n--- can we ALTER TABLE ... DISABLE TRIGGER? (test, rolled back) ---');
  try {
    await sql.begin(async tx => {
      await tx.unsafe(`ALTER TABLE public.fee_transactions DISABLE TRIGGER USER`);
      console.log('  OK -> we can disable triggers on fee_transactions');
      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message === '__rollback__') console.log('  (rolled back test)');
    else console.log('  CANNOT disable triggers:', e.message);
  }

  await sql.end();
}
main().catch(async e=>{console.error('FAILED:',e.message);try{await sql.end();}catch{}process.exit(1);});
