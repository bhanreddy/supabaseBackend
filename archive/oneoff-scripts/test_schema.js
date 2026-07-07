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

        // Split schema into statements conceptually (this is hard due to dollar quotes, let's just run it all and parse PostgreSQL's error position)
        try {
            await client.query(schema);
            console.log('Schema executed successfully!');
        } catch (err) {
            console.error('ERROR EXECUTING SCHEMA:');
            console.error(err.message);
            if (err.position) {
                const pos = parseInt(err.position, 10);
                const beforeError = schema.substring(0, pos);
                const line = beforeError.split('\n').length;
                console.error(`Error is near line: ${line}`);

                // Print the context
                const lines = schema.split('\n');
                const startLine = Math.max(0, line - 5);
                const endLine = Math.min(lines.length, line + 5);
                console.error('Context:');
                for (let i = startLine; i < endLine; i++) {
                    console.error(`${i + 1}: ${lines[i]}`);
                }
            } else {
                console.error(err);
            }
        }

    } catch (err) {
        console.error('Connection error:', err);
    } finally {
        await client.end();
    }
}

run();
