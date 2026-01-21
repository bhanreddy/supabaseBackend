import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccountPath = path.join(process.cwd(), 'service-account.json');
const envPath = path.join(process.cwd(), '.env');

if (!fs.existsSync(serviceAccountPath)) {
    console.error('service-account.json not found');
    process.exit(1);
}

const secrets = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
const envContent = fs.readFileSync(envPath, 'utf8');

const lines = envContent.split(/\r?\n/).filter(l => !l.startsWith('FIREBASE_') && l.trim() !== '');

lines.push(`FIREBASE_PROJECT_ID=${secrets.project_id}`);
lines.push(`FIREBASE_CLIENT_EMAIL=${secrets.client_email}`);
lines.push(`FIREBASE_PRIVATE_KEY="${secrets.private_key.replace(/\n/g, '\\n')}"`);

fs.writeFileSync(envPath, lines.join('\n') + '\n');
console.log('Successfully updated .env with individual Firebase variables');
