
import 'dotenv/config';

console.log('--- Environment Variables Debug ---');
console.log('Using dotenv to load .env file');

const dbUrl = process.env.DATABASE_URL;
const sbUrl = process.env.SUPABASE_URL;
const sbKey = process.env.SUPABASE_ANON_KEY;
const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.PORT;

function mask(str, visibleChars = 4) {
    if (!str) return 'UNDEFINED';
    if (str.length <= visibleChars) return str;
    return str.substring(0, visibleChars) + '...' + str.substring(str.length - visibleChars);
}

console.log(`PORT: ${port}`);
console.log(`DATABASE_URL: ${dbUrl ? 'SET (' + dbUrl.length + ' chars)' : 'MISSING'}`);
console.log(`SUPABASE_URL: ${sbUrl}`);
console.log(`SUPABASE_ANON_KEY: ${mask(sbKey)}`);
console.log(`SUPABASE_SERVICE_ROLE_KEY: ${mask(sbService)}`);

if (!sbUrl) {
    console.error('❌ SUPABASE_URL is missing');
}
if (!sbService) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY is missing');
}

console.log('--- End Debug ---');
