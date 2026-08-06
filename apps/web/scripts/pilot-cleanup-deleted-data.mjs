#!/usr/bin/env node

/**
 * Cleanup script: hard-deletes soft-deleted data that has reached its retention window.
 *
 * Usage: npm run pilot:cleanup-deleted-data
 *        (runs once and exits)
 *
 * Deployment: run daily via cron or container scheduling:
 *   00 03 * * * npm --prefix /app/apps/web run pilot:cleanup-deleted-data
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.AZURE_POSTGRES_CONNECTION_STRING,
});

async function purgeExpiredData() {
  const client = await pool.connect();

  try {
    // Hard-delete athletes soft-deleted >2 years ago
    const athleteRes = await client.query(
      `DELETE FROM pilot.athletes
       WHERE deleted_at IS NOT NULL
         AND deleted_at < (now() - interval '2 years')
       RETURNING athlete_id`,
    );

    // Hard-delete parent accounts soft-deleted >1 year ago
    const accountRes = await client.query(
      `DELETE FROM pilot.accounts
       WHERE deleted_at IS NOT NULL
         AND deleted_at < (now() - interval '1 year')
         AND role = 'parent'
       RETURNING account_id`,
    );

    const athleteDeleted = athleteRes.rows.length;
    const accountDeleted = accountRes.rows.length;
    const totalDeleted = athleteDeleted + accountDeleted;

    if (totalDeleted > 0) {
      // Log the cleanup
      await client.query(
        `INSERT INTO pilot.audit_events (
           event_type, organization_id, entity_type, entity_id, details
         ) VALUES (
           $1, $2, $3, $4, $5
         )`,
        [
          'data_purged',
          null,
          'retention_cleanup',
          'system',
          JSON.stringify({
            athletes_deleted: athleteDeleted,
            accounts_deleted: accountDeleted,
            total_rows_deleted: totalDeleted,
            purged_at: new Date().toISOString(),
          }),
        ],
      );

      console.log(`✓ Data retention cleanup complete.`);
      console.log(`  Athletes hard-deleted: ${athleteDeleted}`);
      console.log(`  Parent accounts hard-deleted: ${accountDeleted}`);
      console.log(`  Total rows deleted: ${totalDeleted}`);
    } else {
      console.log('✓ No data to purge.');
    }
  } catch (error) {
    console.error('✗ Cleanup failed:', error);
    process.exit(1);
  } finally {
    await client.release();
    await pool.end();
  }
}

purgeExpiredData();
