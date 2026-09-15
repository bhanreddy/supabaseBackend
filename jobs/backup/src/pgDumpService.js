import { spawn } from 'node:child_process';
import fs from 'node:fs';
import postgres from 'postgres';
import { assertDirectDatabaseUrl } from './config.js';

const PGDMP_MAGIC = Buffer.from('PGDMP', 'ascii'); // PostgreSQL custom format magic header

/**
 * Parses PostgreSQL connection URL into safe environment variables
 * so passwords never appear in process argument lists.
 * @param {string} urlString
 * @returns {{ host?: string, port?: string, user?: string, password?: string, database?: string }}
 */
export function parseConnectionParams(urlString) {
  try {
    const parsed = new URL(urlString);
    return {
      host: parsed.hostname,
      port: parsed.port || '5432',
      user: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
      database: parsed.pathname.replace(/^\//, ''),
    };
  } catch (err) {
    throw new Error(`Failed to parse database connection URL: ${err.message}`);
  }
}

/**
 * Queries database engine to get full PostgreSQL version string.
 * @param {string} databaseUrl
 * @returns {Promise<string>}
 */
export async function getPostgresVersion(databaseUrl) {
  const sql = postgres(databaseUrl, {
    max: 1,
    ssl: { rejectUnauthorized: false },
    connect_timeout: 10,
  });
  try {
    const result = await sql`SELECT version()`;
    return result[0]?.version || 'Unknown PostgreSQL Version';
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Validates that an unencrypted dump file starts with the PostgreSQL custom format header ('PGDMP').
 * @param {string} filePath
 * @returns {boolean}
 */
export function verifyDumpHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    return buf.equals(PGDMP_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs pg_dump to produce a PostgreSQL custom archive format file.
 *
 * @param {Object} options
 * @param {string} options.databaseUrl
 * @param {string} options.outputPath
 * @param {string} [options.pgDumpPath='pg_dump']
 * @param {number} [options.timeoutMs=3600000] 1 hour default
 * @returns {Promise<{ fileSizeBytes: number, durationSeconds: number }>}
 */
export async function executePgDump({
  databaseUrl,
  outputPath,
  pgDumpPath = 'pg_dump',
  timeoutMs = 3600000,
}) {
  assertDirectDatabaseUrl(databaseUrl);
  const params = parseConnectionParams(databaseUrl);
  const startTime = Date.now();

  const env = {
    ...process.env,
    PGHOST: params.host,
    PGPORT: params.port,
    PGUSER: params.user,
    PGPASSWORD: params.password,
    PGDATABASE: params.database,
    PGSSLMODE: 'require',
  };

  const args = [
    '-Fc', // custom format (compressed, binary, flexible restore)
    '--no-owner', // do not output commands to set ownership of objects to match original database
    '--no-privileges', // do not dump access privileges (grant/revoke)
    '--verbose',
    `--file=${outputPath}`,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(pgDumpPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stderrData = '';

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      // Keep only last 2048 chars to avoid memory bloat while preserving error cause
      if (stderrData.length > 4096) {
        stderrData = stderrData.slice(-2048);
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn pg_dump (${pgDumpPath}): ${err.message}`));
    });

    child.on('close', (code) => {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      if (code !== 0) {
        return reject(
          new Error(`pg_dump exited with error code ${code}. Stderr: ${stderrData.trim()}`)
        );
      }

      if (!fs.existsSync(outputPath)) {
        return reject(new Error(`pg_dump succeeded but output file was not found at ${outputPath}`));
      }

      const stats = fs.statSync(outputPath);
      if (stats.size === 0) {
        return reject(new Error('pg_dump produced an empty (0 byte) backup file'));
      }

      if (!verifyDumpHeader(outputPath)) {
        return reject(new Error('pg_dump output failed header verification: missing PGDMP magic bytes'));
      }

      resolve({
        fileSizeBytes: stats.size,
        durationSeconds,
      });
    });
  });
}
