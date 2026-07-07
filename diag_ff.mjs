import sql from './db.js';
import { resolveFeatures } from './utils/featureRegistry.js';
try {
  console.log('--- overrides for school 1 ---');
  const rows = await sql`SELECT feature_key, enabled FROM school_feature_flags WHERE school_id = 1 ORDER BY feature_key`;
  console.log(rows.map(r => `${r.feature_key}=${r.enabled}`).join('\n') || '(none)');

  console.log('\n--- resolveFeatures(1) sample ---');
  const eff = await resolveFeatures(1);
  console.log('menu.dcgd:', eff['menu.dcgd'], '| quick.life_values:', eff['quick.life_values'], '| quick.transport:', eff['quick.transport']);

  console.log('\n--- role codes in school 1 ---');
  const roles = await sql`SELECT code, name FROM roles WHERE school_id = 1 ORDER BY code`;
  console.log(roles.map(r => r.code).join(', '));

  console.log('\n--- a student user roles (school 1) ---');
  const u = await sql`
    SELECT ur.user_id, array_agg(r.code) AS codes
    FROM user_roles ur JOIN roles r ON ur.role_id = r.id
    WHERE ur.school_id = 1 AND r.code IN ('student','parent')
    GROUP BY ur.user_id LIMIT 3`;
  console.log(u.map(x => `${x.user_id}: [${x.codes.join(',')}]`).join('\n') || '(no student/parent users)');
} catch (e) { console.error('ERR:', e.message); } finally { await sql.end({ timeout: 5 }); process.exit(); }
