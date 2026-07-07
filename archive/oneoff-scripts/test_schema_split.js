import { readFileSync } from 'fs';
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    });

    try {
        await client.connect();
        console.log('Connected to DB');

        const schema = readFileSync('schema.sql', 'utf-8');
        // split by ';' but carefully handle $$

        let currentStatement = '';
        let inDollarQuote = false;
        let dollarQuoteType = '';

        const lines = schema.split('\n');
        let lineNum = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            currentStatement += line + '\n';

            // Count $$ occurrences to know if we are inside or outside
            let idx = 0;
            while ((idx = line.indexOf('$$', idx)) !== -1) {
                inDollarQuote = !inDollarQuote;
                idx += 2;
            }

            if (line.includes(';') && !inDollarQuote) {
                // End of statement!
                try {
                    await client.query(currentStatement);
                } catch (err) {
                    console.error('ERROR AT LINE:', i + 1);
                    console.error('STATEMENT:', currentStatement.trim().substring(0, 500));
                    console.error('ERROR MESSAGE:', err.message);
                    process.exit(1);
                }
                currentStatement = '';
            }
        }

        console.log('Schema executed successfully!');
    } catch (err) {
        console.error('Connection error:', err);
    } finally {
        await client.end();
    }
}

run();
