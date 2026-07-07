
import sql from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const deployTrigger = async () => {
  try {

    const sqlPath = path.join(__dirname, 'update_fees_trigger.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    // Execute the SQL file content
    await sql.unsafe(sqlContent);

    process.exit(0);
  } catch (error) {

    process.exit(1);
  }
};

deployTrigger();