import { readFileSync, appendFileSync } from 'fs';
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    const policy = `
DROP POLICY IF EXISTS "View Notices" ON notices;

CREATE POLICY "View Notices" ON notices
FOR SELECT
USING (
  (created_by = auth.uid()) OR
  (audience = 'all' AND auth.role() = 'authenticated') OR
  (audience = 'staff' AND auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts'])) OR
  (audience = 'students' AND auth_has_role(ARRAY['admin', 'student'])) OR
  (audience = 'parents' AND auth_has_role(ARRAY['admin', 'parent'])) OR
  (audience = 'class' AND target_class_id IS NOT NULL)
);
`;

    try {
        await client.query(policy);
        console.log('SUCCESS View Notices');
    } catch (e) {
        console.error('ERROR View Notices:', e.message);
    }

    const policy2 = `
DROP POLICY IF EXISTS "Manage Notices" ON notices;
CREATE POLICY "Manage Notices" ON notices
FOR ALL 
USING (
  auth_has_role(ARRAY['admin']) OR
  EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN role_permissions rp ON ur.role_id = rp.role_id
    JOIN permissions p ON rp.permission_id = p.id
    WHERE ur.user_id = auth.uid() AND (p.code = 'notices.create' OR p.code = 'notices.manage')
  )
);
`;
    try {
        await client.query(policy2);
        console.log('SUCCESS Manage Notices');
    } catch (e) {
        console.error('ERROR Manage Notices:', e.message);
    }
    await client.end();
}
run();
