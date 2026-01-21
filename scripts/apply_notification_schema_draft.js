
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function applyMigration() {
    console.log('Applying Notification Schema Migration...');

    const sql = `
    -- Add preferred_language to users if it doesn't exist
    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'preferred_language') THEN
        ALTER TABLE users ADD COLUMN preferred_language TEXT CHECK (preferred_language IN ('en', 'hi')) DEFAULT 'en';
      END IF;
    END $$;

    -- Create user_devices table
    CREATE TABLE IF NOT EXISTS user_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      fcm_token TEXT NOT NULL,
      platform TEXT CHECK (platform IN ('android', 'ios')),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      last_used_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      UNIQUE(user_id, fcm_token)
    );

    -- Index for faster lookups during multicast
    CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_devices_token ON user_devices(fcm_token);
  `;

    const { error } = await supabase.rpc('exec_sql', { sql_query: sql });

    // Fallback if exec_sql rpc is not available (common in some setups), try direct query if possible or just log instructions.
    // Since we are using supabase-js, we usually can't run raw DDL unless we have a specific function exposed.
    // However, the user asked for "SQL migrations" primarily.
    // I will write the SQL to a file for them to run in dashboard if this script fails, but I 'll try to provide a script that *would* work if they have the pg driver or a helper.
    // Wait, the previous project files used 'postgres' or 'pg' library for direct connection?
    // Let's check db.js
}

// Actually, let's look at db.js to see how they connect.
