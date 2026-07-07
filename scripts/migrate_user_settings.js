import sql from '../db.js';

async function migrate() {

  try {
    await sql`
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                notification_sound VARCHAR(20) DEFAULT 'custom' CHECK (notification_sound IN ('custom', 'default')),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `;

    await sql`
            CREATE OR REPLACE FUNCTION update_user_settings_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `;

    await sql`
            DROP TRIGGER IF EXISTS trg_user_settings_updated ON user_settings;
        `;

    await sql`
            CREATE TRIGGER trg_user_settings_updated
            BEFORE UPDATE ON user_settings
            FOR EACH ROW
            EXECUTE FUNCTION update_user_settings_updated_at();
        `;

    await sql`
            INSERT INTO user_settings (user_id)
            SELECT id FROM users
            ON CONFLICT (user_id) DO NOTHING;
        `;

  } catch (e) {

  }
  process.exit(0);
}
migrate();