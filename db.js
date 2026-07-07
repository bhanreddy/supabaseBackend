import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import config from './config/env.js';

// 1. Core Postgres Client (for sql`...` template literals)
const sql = postgres(config.databaseUrl, {
    ssl: config.nodeEnv === 'production' ? 'require' : { rejectUnauthorized: false },
    // Increase idle timeout for server-less environments or long-running queries
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    max: 10,
    prepare: false // Required for PgBouncer / Transaction pooler mode
});

// 2. Supabase Clients
export const supabase = createClient(config.supabase.url, config.supabase.anonKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false
    }
});

export const supabaseAdmin = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false
    }
});

// 3. Export for different usage patterns
// Used via: import sql from './db.js';
export default sql;

// Used via: import { query } from './db.js'; (legacy bridge if needed)
export const query = async (text, params) => {
    // Basic bridge to maintain compatibility with some pg-style code if necessary
    // Note: postgres library uses different interpolation, so this is just a dummy bridge for now
    return sql.unsafe(text, params);
};