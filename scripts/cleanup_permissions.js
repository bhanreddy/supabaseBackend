import sql from '../db.js';

async function cleanupPermissions() {
  console.log('Revoking restricted permissions based on rule 1...');

  try {
    // Revoke expenses.approve from accounts role
    await sql`
      DELETE FROM role_permissions
      WHERE role_id IN (SELECT id FROM roles WHERE code = 'accounts')
        AND permission_id IN (SELECT id FROM permissions WHERE code = 'expenses.approve')
    `;
    console.log('Revoked expenses.approve from accounts role.');

    // Revoke expenses.view and expenses.create from staff role
    await sql`
      DELETE FROM role_permissions
      WHERE role_id IN (SELECT id FROM roles WHERE code = 'staff')
        AND permission_id IN (SELECT id FROM permissions WHERE code IN ('expenses.view', 'expenses.create'))
    `;
    console.log('Revoked expenses.view and expenses.create from staff role.');

    console.log('✅ Rule 1 restrictions applied successfully.');
  } catch (err) {
    console.error('Error applying restrictions:', err);
  } finally {
    process.exit(0);
  }
}

cleanupPermissions();
