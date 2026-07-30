import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(__dirname, '../../../infra/azure/pilot_slice_postgres_multiorg_migration.sql');

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: true },
  });

  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }

  console.log(`Applied multi-org migration: ${migrationPath}`);
  console.log('PILOT MULTI-ORG MIGRATION PASS');
}

try {
  await run();
} catch (error) {
  console.error('PILOT MULTI-ORG MIGRATION FAIL');
  console.error(String(error));
  process.exit(1);
}
