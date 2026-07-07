import fs from 'fs';
const schema = fs.readFileSync('schema.sql', 'utf8');
const regex = /ON\s+(\w+)\s*\(\s*school_id\s*\)/gi;
const tables = new Set();
let match;
while ((match = regex.exec(schema)) !== null) {
    tables.add(match[1]);
}
console.log(JSON.stringify(Array.from(tables).sort(), null, 2));
