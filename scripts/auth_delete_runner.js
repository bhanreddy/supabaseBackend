// Hard-deletes the 1458 school-17 student logins from auth.users (CASCADEs auth.identities etc.).
// Scope = the exact public.users ids captured in the student backup (NOT email domain -> never hits staff).
//   node scripts/auth_delete_runner.js            -> DRY RUN (rolls back)
//   node scripts/auth_delete_runner.js --commit   -> REAL DELETE
import sql from '../db.js';
import fs from 'fs';
import path from 'path';

const COMMIT = process.argv.includes('--commit');
const ROLLBACK = '__DRYRUN_ROLLBACK__';

function latestBackup() {
  const d = path.resolve('./backups');
  const f = fs.readdirSync(d).filter(x => x.startsWith('school17_students_backup_')).sort().pop();
  return path.join(d, f);
}

async function main() {
  const bk = JSON.parse(fs.readFileSync(latestBackup(), 'utf8'));
  const ids = [...new Set((bk.tables.users || []).map(u => u.id).filter(Boolean))];
  if (ids.length !== 1458) { console.error(`Expected 1458 ids, got ${ids.length} — aborting`); process.exit(1); }
  console.log(`\n=== ${COMMIT ? 'COMMIT (REAL)' : 'DRY RUN'} | auth.users purge | ${ids.length} student logins ===\n`);

  // 1. Backup the auth rows being removed (read-only) BEFORE deleting.
  if (COMMIT) {
    const authUsers = await sql`SELECT * FROM auth.users WHERE id IN ${sql(ids)}`;
    const identities = await sql`SELECT * FROM auth.identities WHERE user_id IN ${sql(ids)}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.resolve(`./backups/school17_auth_backup_${stamp}.json`);
    fs.writeFileSync(out, JSON.stringify({ meta: { taken_at: new Date().toISOString(), count: authUsers.length }, 'auth.users': authUsers, 'auth.identities': identities }, null, 2));
    console.log('auth backup written:', out, `(users=${authUsers.length}, identities=${identities.length})`);
  }

  try {
    await sql.begin(async (tx) => {
      // Guards: NO-ACTION FKs to auth.users must not reference our ids.
      const f1 = await tx`SELECT count(*)::int n FROM public.financial_audit_logs WHERE performed_by IN ${sql(ids)}`;
      if (f1[0].n) throw new Error(`ABORT: financial_audit_logs.performed_by references ${f1[0].n} of these ids`);
      const f2 = await tx`SELECT count(*)::int n FROM public.financial_policy_rules WHERE updated_by IN ${sql(ids)}`;
      if (f2[0].n) throw new Error(`ABORT: financial_policy_rules.updated_by references ${f2[0].n} of these ids`);

      const before = (await tx`SELECT count(*)::int n FROM auth.identities WHERE user_id IN ${sql(ids)}`)[0].n;
      const r = await tx`DELETE FROM auth.users WHERE id IN ${sql(ids)}`;
      const idLeft = (await tx`SELECT count(*)::int n FROM auth.identities WHERE user_id IN ${sql(ids)}`)[0].n;
      console.log(`auth.users deleted        : ${r.count}`);
      console.log(`auth.identities (cascade) : ${before} -> ${idLeft}`);

      if (!COMMIT) throw new Error(ROLLBACK);
    });
    console.log(`\n✅ COMMITTED. ${ids.length} auth.users (+cascaded identities) permanently deleted.`);
  } catch (e) {
    if (e.message === ROLLBACK) console.log('\n↩️  DRY RUN complete — ROLLED BACK. Re-run with --commit to apply.');
    else { console.error('\n❌ ROLLED BACK:', e.message); process.exitCode = 1; }
  } finally {
    await sql.end();
  }
}
main();
