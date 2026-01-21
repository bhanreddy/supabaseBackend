import sql from '../db.js';

async function applyAuditSchema() {
    try {
        console.log('Applying Audit Logs Schema...');

        await sql`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id) ON DELETE SET NULL,
                action VARCHAR(100) NOT NULL,
                entity VARCHAR(100) NOT NULL,
                entity_id VARCHAR(100), -- Can be UUID or other ID
                details JSONB,
                ip_address VARCHAR(45),
                user_agent TEXT,
                request_id VARCHAR(100),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `;

        await sql`
            CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
        `;

        await sql`
            CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id);
        `;

        await sql`
            CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);
        `;

        console.log('Audit Logs Schema Applied Successfully.');
        process.exit(0);
    } catch (error) {
        console.error('Error applying schema:', error);
        process.exit(1);
    }
}

applyAuditSchema();
