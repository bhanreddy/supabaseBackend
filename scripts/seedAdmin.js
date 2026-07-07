/**
 * Bootstrap Admin User Script
 * Creates the first admin user in the system.
 * This is needed because user creation through API requires admin permission.
 * 
 * Usage: node scripts/seedAdmin.js
 */

import 'dotenv/config';
import sql, { supabaseAdmin } from '../db.js';

const ADMIN_EMAIL = 'admin@school.com';
const ADMIN_PASSWORD = 'Admin@123';

async function seedAdmin() {

  if (!supabaseAdmin) {

    process.exit(1);
  }

  try {
    // Check if admin already exists
    const existingUsers = await sql`
            SELECT u.id FROM users u
            JOIN user_roles ur ON u.id = ur.user_id
            JOIN roles r ON ur.role_id = r.id
            WHERE r.code = 'admin'
        `;

    if (existingUsers.length > 0) {

      process.exit(0);
    }

    // Get gender ID (required)
    const [gender] = await sql`SELECT id FROM genders WHERE name = 'Male'`;
    if (!gender) {

      process.exit(1);
    }

    // Begin transaction
    const result = await sql.begin(async (sql) => {
      // 1. Create Person
      const [person] = await sql`
                INSERT INTO persons (first_name, last_name, gender_id)
                VALUES ('Admin', 'User', ${gender.id})
                RETURNING id
            `;

      // 2. Create Supabase Auth User
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        email_confirm: true,
        user_metadata: { person_id: person.id }
      });

      if (authError) {
        throw new Error(`Supabase Auth Error: ${authError.message}`);
      }

      const supabaseUserId = authData.user.id;

      // 3. Create Local User (ID matches Supabase)
      const [user] = await sql`
                INSERT INTO users (id, person_id, account_status)
                VALUES (${supabaseUserId}, ${person.id}, 'active')
                RETURNING id
            `;

      // 4. Get Admin Role
      const [adminRole] = await sql`SELECT id FROM roles WHERE code = 'admin'`;
      if (!adminRole) {
        throw new Error('Admin role not found. Schema not applied correctly.');
      }

      // 5. Assign Admin Role (granted_by is NULL for bootstrap)
      await sql`
                INSERT INTO user_roles (user_id, role_id)
                VALUES (${user.id}, ${adminRole.id})
            `;

      // 6. Add email as contact
      await sql`
                INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary)
                VALUES (${person.id}, 'email', ${ADMIN_EMAIL}, true)
            `;

      return { user_id: user.id, email: ADMIN_EMAIL };
    });

    process.exit(0);

  } catch (error) {

    process.exit(1);
  }
}

seedAdmin();

seedAdmin();