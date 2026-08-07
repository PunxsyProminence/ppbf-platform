#!/usr/bin/env node

/**
 * Applies the data retention and deletion migration.
 * Adds soft-delete tracking (deleted_at columns) to accounts and athletes tables.
 * Creates cascade deletion triggers.
 *
 * Safe to run multiple times (idempotent).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = path.join(__dirname, '../../../infra/azure');

const pool = new Pool({
  connectionString: process.env.AZURE_POSTGRES_CONNECTION_STRING,
});

async function applyMigration() {
  const migrationPath = path.join(
    INFRA_DIR,
    'pilot_slice_postgres_data_retention_deletion_migration.sql',
  );

  const sql = fs.readFileSync(migrationPath, 'utf8');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(sql);

    await client.query('COMMIT');

    console.log('✓ Data retention migration applied successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('✗ Migration failed:', error);
    process.exit(1);
  } finally {
    await client.release();
    await pool.end();
  }
}

applyMigration();
