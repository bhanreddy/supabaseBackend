import sql from '../db.js';

async function migrate() {

  await sql`
        CREATE TABLE IF NOT EXISTS school_settings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            key VARCHAR(100) UNIQUE NOT NULL,
            value TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `;

  // Seed the default settings
  const defaults = [
  { key: 'school_name', value: 'My School' },
  { key: 'school_address', value: '' },
  { key: 'school_phone', value: '' },
  { key: 'school_email', value: '' },
  { key: 'school_website', value: '' },
  { key: 'school_logo_url', value: '' },
  { key: 'school_tagline', value: '' },
  { key: 'school_affiliation', value: '' },
  { key: 'school_principal', value: '' }];

  for (const d of defaults) {
    await sql`
            INSERT INTO school_settings (key, value)
            VALUES (${d.key}, ${d.value})
            ON CONFLICT (key) DO NOTHING
        `;
  }

  process.exit(0);
}

migrate().catch((err) => {

  process.exit(1);
});