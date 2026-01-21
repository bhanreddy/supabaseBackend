
import sql from '../db.js';

async function applyMigration() {
  console.log('🚀 Applying Notification Schema Migration...');

  try {
    // 1. Add preferred_language to users
    // We check existence first to avoid errors on re-run
    console.log('Checking users table...');
    await sql`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'preferred_language') THEN
          ALTER TABLE users ADD COLUMN preferred_language TEXT CHECK (preferred_language IN ('en', 'hi', 'te')) DEFAULT 'en';
          RAISE NOTICE 'Added preferred_language to users';
        ELSE
          RAISE NOTICE 'preferred_language already exists';
        END IF;
      END $$;
    `;

    // 2. Create user_devices table
    console.log('Creating user_devices table...');
    await sql`
      CREATE TABLE IF NOT EXISTS user_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        fcm_token TEXT NOT NULL,
        platform TEXT CHECK (platform IN ('android', 'ios')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
        last_used_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
        UNIQUE(user_id, fcm_token)
      );
    `;

    // 3. Indexes
    console.log('Applying indexes...');
    await sql`CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_user_devices_token ON user_devices(fcm_token)`;

    console.log('✅ Migration applied successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

applyMigration();
