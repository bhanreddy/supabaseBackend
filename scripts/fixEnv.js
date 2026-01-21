
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND_ENV_PATH = path.join(__dirname, '..', '.env');
const FRONTEND_ENV_PATH = path.join(__dirname, '..', '..', 'testapp', '.env');

console.log(`Backend Env Path: ${BACKEND_ENV_PATH}`);
console.log(`Frontend Env Path: ${FRONTEND_ENV_PATH}`);

function parseEnv(content) {
    const res = {};
    const lines = content.split(/\r?\n/);
    lines.forEach(line => {
        const idx = line.indexOf('=');
        if (idx > 0) {
            const key = line.substring(0, idx).trim();
            const val = line.substring(idx + 1).trim();
            res[key] = val;
        }
    });
    return res;
}

try {
    console.log('Reading Frontend .env...');
    const feContent = fs.readFileSync(FRONTEND_ENV_PATH, 'utf8');
    const feEnv = parseEnv(feContent);

    // Extract frontend keys
    const sbUrl = feEnv['EXPO_PUBLIC_SUPABASE_URL'] || feEnv['SUPABASE_URL'];
    const sbAnon = feEnv['EXPO_PUBLIC_SUPABASE_ANON_KEY'] || feEnv['SUPABASE_ANON_KEY'];

    console.log('Reading Backend .env...');
    let beContent = fs.readFileSync(BACKEND_ENV_PATH, 'utf8');

    // Fix missing newline issue roughly
    // The issue observed: PORT=3000SERVICE_ROLE_KEY...
    if (beContent.includes('PORT=3000SERVICE')) {
        console.log('Detected missing newline after PORT=3000, fixing...');
        beContent = beContent.replace('PORT=3000', 'PORT=3000\n');
    }
    // Also checked for generic case
    beContent = beContent.replace(/PORT=(\d+)([A-Z_]+)=/, 'PORT=$1\n$2=');


    // Parse backend properly now
    const beEnv = parseEnv(beContent);

    // Construct new env
    const newEnv = [
        `DATABASE_URL=${beEnv.DATABASE_URL || ''}`,
        `PORT=${beEnv.PORT || '3000'}`,
        `SUPABASE_URL=${sbUrl || beEnv.SUPABASE_URL || ''}`,
        `SUPABASE_ANON_KEY=${sbAnon || beEnv.SUPABASE_ANON_KEY || ''}`,
        `SUPABASE_SERVICE_ROLE_KEY=${beEnv.SERVICE_ROLE_KEY || beEnv.SUPABASE_SERVICE_ROLE_KEY || ''}`
    ];

    const fixedContent = newEnv.join('\n');

    console.log('--- Proposed .env Content ---');
    newEnv.forEach(line => {
        const [k, v] = line.split('=');
        if (k.includes('KEY') || k.includes('URL')) {
            console.log(`${k}=${v ? v.substring(0, 5) + '...' + v.substring(v.length - 5) : 'MISSING'}`);
        } else {
            console.log(line);
        }
    });

    fs.writeFileSync(path.join(__dirname, '..', '.env.fixed'), fixedContent);
    console.log('✅ Wrote .env.fixed');

} catch (err) {
    console.error('❌ Error:', err.message);
}
