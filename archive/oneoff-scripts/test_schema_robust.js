import { readFileSync, writeFileSync } from 'fs';
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    const schema = readFileSync('schema.sql', 'utf-8');
    const lines = schema.split('\n');
    let currentStatement = '';
    let statementCount = 0;
    let inDollarQuotes = false;
    let dollarTag = null;
    let log = '';

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        currentStatement += line + '\n';

        if (!inDollarQuotes) {
            // Check for start of dollar quote: $tag$
            const match = line.match(/\$([a-zA-Z0-9_]*)\$/);
            if (match) {
                inDollarQuotes = true;
                dollarTag = match[0];
                // Check if it ends on the same line (rare but possible)
                if (line.indexOf(dollarTag, line.indexOf(dollarTag) + 1) !== -1) {
                    inDollarQuotes = false;
                    dollarTag = null;
                }
            }
        } else {
            // Check for end of dollar quote
            if (line.includes(dollarTag)) {
                inDollarQuotes = false;
                dollarTag = null;
            }
        }

        if (line.trim().endsWith(';') && !inDollarQuotes) {
            statementCount++;
            try {
                await client.query(currentStatement);
                if (statementCount % 100 === 0) {
                    console.log(`Executed ${statementCount} statements...`);
                }
            } catch (e) {
                log += `❌ ERROR: Statement #${statementCount} ending line ${i + 1}\n`;
                log += `Message: ${e.message}\n`;
                log += `Statement Fragment: \n${currentStatement.trim().substring(0, 500)}...\n`;
                writeFileSync('test_log.txt', log);
                console.error(`Error at statement ${statementCount} (line ${i + 1}): ${e.message}`);
                process.exit(1);
            }
            currentStatement = '';
        }
    }

    log += `SUCCESS executed all ${statementCount} statements\n`;
    writeFileSync('test_log.txt', log);
    console.log(`SUCCESS: Executed all ${statementCount} statements`);
    await client.end();
}
run();
