import postgres from 'postgres'
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const connectionString = process.env.DATABASE_URL

if (!connectionString || connectionString.includes('your_postgres_connection_string_here')) {
    console.error('\x1b[31m%s\x1b[0m', '❌ ERROR: DATABASE_URL is not set correctly in .env')
    console.error('Please update your .env file with a real PostgreSQL connection string.')
    process.exit(1)
}

const sql = postgres(connectionString);

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = (supabaseUrl && supabaseKey)
    ? createClient(supabaseUrl, supabaseKey)
    : null;

export const supabaseAdmin = (supabaseUrl && supabaseServiceKey)
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

if (!supabase) {
    console.warn('⚠️ Supabase URL or Anon Key missing in .env. Supabase client not initialized.');
}
if (!supabaseAdmin) {
    console.warn('⚠️ Supabase Service Role Key missing in .env. Admin operations (creating users) will fail.');
}

export const getTransaction = async (callback) => {
    return await sql.begin(callback);
}

export default sql;