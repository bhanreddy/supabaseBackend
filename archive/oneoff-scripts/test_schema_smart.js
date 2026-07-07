import { readFileSync, appendFileSync } from 'fs';
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    });

    try {
        await client.connect();

        // reset database to empty if possible? No, we just run the DDL. DDL is idempotent mostly.

        const schema = readFileSync('schema.sql', 'utf-8');
        const statements = schema.split(';');

        // We can't just split on ';' because of functions. 
        // Let's use a smarter parser or regex
        let buffer = '';
        let inDollarQuotes = false;
        let lineNum = 1;

        const lines = schema.split('\n');

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            buffer += line + '\n';

            // rudimentary dollar quote detection
            let pos = 0;
            while ((pos = line.indexOf('$$', pos)) !== -1) {
                inDollarQuotes = !inDollarQuotes;
                pos += 2;
            }

            if (line.includes(';') && !inDollarQuotes) {
                try {
                    await client.query(buffer);
                } catch (e) {
                    console.error(`\n========================================`);
                    console.error(`ERROR at lines ${lineNum} to ${i + 1}`);
                    console.error(`Message: ${e.message}`);
                    console.error(`Statement: \n${buffer.substring(0, 300)}...`);
                    console.error(`========================================\n`);
                    process.exit(1);
                }
                buffer = '';
                lineNum = i + 2;
            }
        }

        console.log('Done!');
    } catch (err) {
        console.error('Connection error:', err);
    } finally {
        await client.end();
    }
}

run();
