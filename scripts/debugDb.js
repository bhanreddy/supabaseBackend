import 'dotenv/config';
import sql from '../db.js';

async function debug() {
    try {
        console.log('🔍 Checking DB version...');
        const [version] = await sql`SELECT version()`;
        console.log('Version:', version);

        console.log('🔍 Checking gen_random_uuid()...');
        try {
            const [u1] = await sql`SELECT gen_random_uuid() as uuid`;
            console.log('✅ gen_random_uuid() works:', u1);
        } catch (e) {
            console.log('❌ gen_random_uuid() failed:', e.message);
        }

        console.log('🔍 Checking uuid_generate_v4()...');
        try {
            await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`; // Try enabling
            const [u2] = await sql`SELECT uuid_generate_v4() as uuid`;
            console.log('✅ uuid_generate_v4() works:', u2);
        } catch (e) {
            console.log('❌ uuid_generate_v4() failed:', e.message);
        }

        process.exit(0);
    } catch (e) {
        console.error('Fatal:', e);
        process.exit(1);
    }
}

debug();
