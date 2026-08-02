import dns from 'node:dns';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import config from './config/env.js';

// Prefer IPv4 for every outbound connection in this process (main pool,
// pg-boss, supabase-js). The Supabase poolers are IPv4-reachable, but some
// networks resolve/route the AAAA (NAT64 `64:ff9b::`) path unreliably, which
// surfaced as periodic "Connection terminated unexpectedly" / read ETIMEDOUT
// drops on idle connections. setDefaultResultOrder is process-global and runs
// before any client actually dials (postgres.js and supabase-js connect lazily).
dns.setDefaultResultOrder('ipv4first');

// 1. Core Postgres Client (for sql`...` template literals)
const sql = postgres(config.databaseUrl, {
    ssl: config.nodeEnv === 'production' ? 'require' : { rejectUnauthorized: false },
    // Increase idle timeout for server-less environments or long-running queries
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    max: 10,
    prepare: false, // Required for PgBouncer / Transaction pooler mode
    // Required alongside `prepare: false` for PgBouncer/Supavisor transaction pooling.
    // postgres.js pipelines queued queries onto an already-busy connection by default
    // (max_pipeline: 100). A transaction-mode pooler can reassign the backend
    // connection between pipelined queries, so keep exactly one in-flight query per
    // connection. `0` is not a valid way to disable pipelining: it prevents the
    // connection from being returned to the dispatch pool after a query and can make
    // a later BEGIN run as an unreserved transaction, poisoning unrelated requests.
    // See https://github.com/porsager/postgres/issues/970
    max_pipeline: 1
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