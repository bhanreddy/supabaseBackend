import sql from '../db.js';

async function fixPermissions() {
  console.log('Adding missing expenses permissions...');
  
  try {
    // Insert permissions
    await sql`
      INSERT INTO permissions (school_id, code, name)
      SELECT 1, v.code, v.name
      FROM (VALUES
        ('expenses.view', 'View Expenses'),
        ('expenses.create', 'Create Expenses'),
        ('expenses.edit', 'Edit Expenses'),
        ('expenses.delete', 'Delete Expenses'),
        ('expenses.approve', 'Approve Expenses')
      ) AS v(code, name)
      WHERE NOT EXISTS (
        SELECT 1 FROM permissions p WHERE p.school_id = 1 AND p.code = v.code
      )
    `;
    console.log('Permissions added successfully.');

    // Grant to accounts role
    await sql`
      INSERT INTO role_permissions (school_id, role_id, permission_id)
      SELECT 1, r.id, p.id FROM roles r, permissions p 
      WHERE r.code = 'accounts' AND p.code IN (
          'expenses.view', 'expenses.create', 'expenses.edit', 'expenses.delete', 'expenses.approve'
      )
      AND NOT EXISTS (
        SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
      )
    `;
    console.log('Granted expenses.* to accounts role.');

    // Grant to staff role
    await sql`
      INSERT INTO role_permissions (school_id, role_id, permission_id)
      SELECT 1, r.id, p.id FROM roles r, permissions p 
      WHERE r.code = 'staff' AND p.code IN (
          'expenses.view', 'expenses.create'
      )
      AND NOT EXISTS (
        SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
      )
    `;
    console.log('Granted expenses.view and expenses.create to staff role.');

    // Grant to admin role
    await sql`
      INSERT INTO role_permissions (school_id, role_id, permission_id)
      SELECT 1, r.id, p.id
      FROM roles r, permissions p
      WHERE r.code = 'admin'
        AND NOT EXISTS (
          SELECT 1 FROM role_permissions rp
          WHERE rp.role_id = r.id AND rp.permission_id = p.id
        )
    `;
    console.log('Granted all permissions to admin role.');

    console.log('✅ Fix applied successfully.');
  } catch (err) {
    console.error('Error applying fix:', err);
  } finally {
    process.exit(0);
  }
}

fixPermissions();
