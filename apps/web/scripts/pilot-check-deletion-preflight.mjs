// Read-only answer to one question: has anybody ever actually been deleted,
// and is anybody exposed by the way it used to work?
//
// WHY THIS EXISTS. Two defects were fixed on 2026-08-27 in the code that
// deletes a person's records:
//
//   #690  deleteGuardianAccount wrote deleted_at and nothing else, so a
//         deleted guardian kept an active account, a live session and a
//         working magic-link path to their linked minor's records.
//   #709  deleteAthleteRecord had the same shape -- the athlete row was
//         marked deleted while the account stayed active and every session
//         token stayed valid.
//
// Both were written up, in PR bodies and in docs/current/AI_RELEASE_CONTROL.md,
// as harms that WERE HAPPENING in production. That was an overstatement. What
// was verified is what the code would do the first time anyone deleted
// someone; nobody checked whether anyone ever had.
//
// The code says probably not. deleteGuardianAccount and deleteAthleteRecord
// have exactly one caller between them -- DELETE /api/pilot/admin/data-deletion
// -- and NOTHING in app/ or components/ calls that endpoint. There is no
// button. No script and no workflow calls it either. Triggering a deletion
// requires hand-crafting an authenticated request against the live API.
//
// "Probably not" is not a number, and this file exists because the difference
// matters: if the audit table is empty then those two PRs closed a hole before
// it was ever used, and there is nothing to remediate. If it is not empty,
// somebody is owed a repair.
//
// EVERY DELETION WRITES AN AUDIT ROW IN ITS OWN TRANSACTION, so
// pilot.audit_events is the authoritative record. A deletion that committed
// has a row; one that did not commit left nothing behind to find.
//
// SELECT ONLY, inside an explicit READ ONLY transaction, so Postgres itself
// refuses any write this file could attempt. Safe to run against production.
//
// WHAT IT DELIBERATELY DOES NOT PRINT. Counts and timestamps only -- no
// account ids, no athlete ids, no names, no emails. The question here is "did
// this happen, and to how many", and ids answer a different question. If a
// count comes back non-zero, deciding what to do is an owner call and the ids
// it needs can be pulled then, deliberately, rather than being sprayed into a
// CI log by a check whose job was to count.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env var must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Set it in apps/web/.env.local, or export it before running this script.',
    );
  }
  return value.trim();
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

const count = (rows) => Number(rows[0]?.count ?? 0);

async function main() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();

  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    // deleted_at is added by the data-retention migration, not the base
    // schema. Reporting its absence is a real answer -- "this environment has
    // never been able to record a deletion" -- and a better one than a crash
    // on a missing column.
    const columns = await client.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'pilot'
          and column_name = 'deleted_at'
          and table_name in ('athletes', 'accounts')`,
    );
    const present = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    const retentionApplied = present.has('athletes.deleted_at') && present.has('accounts.deleted_at');

    console.log('=== DELETION PREFLIGHT (read-only) ===\n');

    if (!retentionApplied) {
      console.log('The data-retention migration has NOT been applied to this database.');
      console.log('pilot.athletes.deleted_at present:', present.has('athletes.deleted_at'));
      console.log('pilot.accounts.deleted_at present:', present.has('accounts.deleted_at'));
      console.log('\nNo deletion can ever have been recorded here. Nothing to remediate.');
      await client.query('COMMIT');
      await client.end();
      process.exit(0);
    }

    // 1. THE AUTHORITATIVE QUESTION. Every committed deletion writes one of
    //    these rows inside the deleting transaction.
    const deletionEvents = await client.query(
      `select entity_type, count(*)::text as count,
              min(created_at)::text as first_seen,
              max(created_at)::text as last_seen
         from pilot.audit_events
        where event_type = 'data_deletion_initiated'
        group by entity_type
        order by entity_type`,
    );

    const totalDeletions = deletionEvents.rows.reduce((sum, row) => sum + Number(row.count), 0);
    console.log(`Deletion audit events: ${totalDeletions}`);
    for (const row of deletionEvents.rows) {
      console.log(`  ${row.entity_type}: ${row.count}  (first ${row.first_seen}, last ${row.last_seen})`);
    }

    const purges = await client.query(
      `select count(*)::text as count from pilot.audit_events where event_type = 'data_purged'`,
    );
    console.log(`Retention purge events: ${count(purges.rows)}`);

    // 2. THE ROWS THEMSELVES. A deletion could in principle predate the audit
    //    row's existence, so these are counted independently rather than
    //    inferred from the events above.
    const deletedAthletes = await client.query(
      `select count(*)::text as count from pilot.athletes where deleted_at is not null`,
    );
    const deletedAccounts = await client.query(
      `select role, count(*)::text as count from pilot.accounts
        where deleted_at is not null group by role order by role`,
    );
    console.log(`\nSoft-deleted athlete rows: ${count(deletedAthletes.rows)}`);
    console.log(`Soft-deleted account rows: ${deletedAccounts.rows.reduce((s, r) => s + Number(r.count), 0)}`);
    for (const row of deletedAccounts.rows) {
      console.log(`  role ${row.role}: ${row.count}`);
    }

    // 3. THE EXPOSURE. This is the part that decides whether anyone is owed a
    //    repair: a record marked deleted whose access was never actually
    //    closed. Each of these is exactly the footprint one of the two bugs
    //    leaves behind, so a non-zero count here names a real person who can
    //    still get in.
    const activeDeletedAccounts = await client.query(
      `select role, count(*)::text as count from pilot.accounts
        where deleted_at is not null and active_flag = true
        group by role order by role`,
    );
    const deletedAthletesWithLiveAccount = await client.query(
      `select count(*)::text as count
         from pilot.athletes a
         join pilot.accounts acc
           on acc.organization_id = a.organization_id
          and acc.athlete_id = a.athlete_id
          and acc.role = 'athlete'
        where a.deleted_at is not null
          and acc.active_flag = true`,
    );
    const liveSessionsOnDeletedAccounts = await client.query(
      `select count(*)::text as count
         from pilot.session_tokens t
         join pilot.accounts acc on acc.account_id = t.account_id
        where acc.deleted_at is not null
          and t.revoked_at is null
          and t.expires_at > now()`,
    );

    const activeDeletedTotal = activeDeletedAccounts.rows.reduce((s, r) => s + Number(r.count), 0);
    const athletesExposed = count(deletedAthletesWithLiveAccount.rows);
    const liveSessions = count(liveSessionsOnDeletedAccounts.rows);

    console.log('\n--- EXPOSURE ---');
    console.log(`Deleted accounts still active_flag = true: ${activeDeletedTotal}`);
    for (const row of activeDeletedAccounts.rows) {
      console.log(`  role ${row.role}: ${row.count}`);
    }
    console.log(`Deleted athletes whose account is still active: ${athletesExposed}`);
    console.log(`Unrevoked, unexpired sessions on deleted accounts: ${liveSessions}`);

    const exposure = activeDeletedTotal + athletesExposed + liveSessions;

    console.log('');
    if (totalDeletions === 0 && count(deletedAthletes.rows) === 0) {
      console.log('DELETION PREFLIGHT: NOTHING EVER DELETED.');
      console.log('No deletion has been recorded in this database. The fixes in #690 and #709');
      console.log('closed the hole before it was used; there is nobody to remediate.');
    } else if (exposure === 0) {
      console.log('DELETION PREFLIGHT: DELETIONS FOUND, NO EXPOSURE.');
      console.log('Records were deleted, and every one of them has its access closed.');
    } else {
      console.log('DELETION PREFLIGHT: EXPOSURE FOUND.');
      console.log(`${exposure} record(s) are marked deleted with access still open.`);
      console.log('This is an owner decision, not a script\'s: re-run with a follow-up that');
      console.log('selects the ids once somebody has decided what to do about them.');
    }

    await client.query('COMMIT');
    await client.end();
    process.exit(exposure === 0 ? 0 : 1);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    console.error('Deletion preflight failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

await main();
