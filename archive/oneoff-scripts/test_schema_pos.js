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

        const schema = readFileSync('schema.sql', 'utf-8');

        try {
            await client.query(schema);
            console.log('Schema executed successfully!');
        } catch (err) {
            console.error('ERROR MESSAGE:', err.message);
            if (err.position) {
                const pos = parseInt(err.position, 10);

                console.error(`\nError is near character position: ${pos}`);
                console.error('----------------------------------------');
                // Provide a window of 200 characters before and after
                const startStr = Math.max(0, pos - 200);
                const endStr = Math.min(schema.length, pos + 200);
                const snippet = schema.substring(startStr, endStr);

                // Mark the exact spot
                const exactPosInSnippet = pos - startStr;
                const snippetMarked = snippet.substring(0, exactPosInSnippet) + ' >>> ERROR HERE <<< ' + snippet.substring(exactPosInSnippet);
                console.error(snippetMarked);
                console.error('----------------------------------------');

                // Also print the line number
                const linesBefore = schema.substring(0, pos).split('\n');
                console.error(`Line number: ${linesBefore.length}`);
                console.error(`Line content: ${linesBefore[linesBefore.length - 1]}`);
            } else {
                console.error('No position provided by Postgres.');
            }
        }

    } catch (err) {
        console.error('Connection error:', err);
    } finally {
        await client.end();
    }
}

run();
