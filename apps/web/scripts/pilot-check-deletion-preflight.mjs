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
// The code said probably not. deleteGuardianAccount and deleteAthleteRecord
// have exactly one caller between them -- DELETE /api/pilot/admin/data-deletion
// -- and until 2026-09-29 NOTHING in app/ or components/ called that endpoint:
// there was no button, and no script or workflow called it either. Triggering
// a deletion required hand-crafting an authenticated request against the live
// API. Since 2026-09-29 the /admin/data-deletion screen calls it, so a
// non-zero count is now expected and is not by itself evidence of the old
// exposure, which needed a deletion made before the 2026-08-27 fixes. The
// first_seen / last_seen timestamps printed below are where to look.
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

/**
 * Who marked deleted can still get in, and who is marked deleted but refused.
 *
 * SIGN-IN REFUSES ANY ACCOUNT MARKED DELETED (OD-2026-09-29-003 Q9,
 * src/server/pilot/deletedAccountSignIn.ts): PIN, Microsoft and sign-in-link
 * sign-in, and resolvePrincipal for every session. So an account with
 * deleted_at set is not access, whatever its active_flag says, and neither is
 * a session it holds. Before that rule both were the footprint #690/#709
 * left, and this check counted them as exposure. They are still counted, as
 * `refused*`: an account marked deleted but flagged active is a login an admin
 * path turned back on that can never sign in, which is worth seeing, and on a
 * deployed revision older than the rule they can still get in.
 *
 * What is still EXPOSURE is a deleted athlete whose own login is active and
 * NOT marked deleted -- the sign-in rule reads accounts.deleted_at only, so
 * that login still works.
 */
export async function countDeletedAccess(client) {
  const refusedAccounts = await client.query(
    `select role, count(*)::text as count from pilot.accounts
      where deleted_at is not null and active_flag = true
      group by role order by role`,
  );
  const athletesExposed = await client.query(
    `select count(*)::text as count
       from pilot.athletes a
       join pilot.accounts acc
         on acc.organization_id = a.organization_id
        and acc.athlete_id = a.athlete_id
        and acc.role = 'athlete'
      where a.deleted_at is not null
        and acc.active_flag = true
        and acc.deleted_at is null`,
  );
  const refusedSessions = await client.query(
    `select count(*)::text as count
       from pilot.session_tokens t
       join pilot.accounts acc on acc.account_id = t.account_id
      where acc.deleted_at is not null
        and t.revoked_at is null
        and t.expires_at > now()`,
  );

  const refusedAccountsByRole = refusedAccounts.rows.map((row) => ({
    role: row.role,
    count: Number(row.count),
  }));
  return {
    refusedAccountsByRole,
    refusedAccounts: refusedAccountsByRole.reduce((sum, row) => sum + row.count, 0),
    refusedSessions: count(refusedSessions.rows),
    athletesExposed: count(athletesExposed.rows),
  };
}

/** Non-zero only when a deleted record can still get in. */
export function deletionPreflightExitCode(access) {
  return access.athletesExposed === 0 ? 0 : 1;
}

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

    // 3. THE EXPOSURE, and what sign-in now refuses. See countDeletedAccess:
    //    since the Q9 rule, only a deleted athlete whose own login is not
    //    marked deleted can still get in, so only that decides the exit code.
    const access = await countDeletedAccess(client);
    const exposure = access.athletesExposed;

    console.log('\n--- EXPOSURE ---');
    console.log(`Deleted athletes whose own account is active and not marked deleted: ${exposure}`);

    console.log('\n--- REFUSED AT SIGN-IN (marked deleted; OD-2026-09-29-003 Q9) ---');
    console.log(`Deleted accounts still active_flag = true: ${access.refusedAccounts}`);
    for (const row of access.refusedAccountsByRole) {
      console.log(`  role ${row.role}: ${row.count}`);
    }
    console.log(`Unrevoked, unexpired sessions on deleted accounts: ${access.refusedSessions}`);
    console.log('Sign-in refuses every account marked deleted, and resolvePrincipal resolves');
    console.log('its sessions to nobody, on any revision with that rule');
    console.log('(apps/web/src/server/pilot/deletedAccountSignIn.ts). On a deployed revision');
    console.log('without it, these can still sign in.');

    console.log('');
    if (totalDeletions === 0 && count(deletedAthletes.rows) === 0) {
      console.log('DELETION PREFLIGHT: NOTHING EVER DELETED.');
      console.log('No deletion has been recorded in this database. The fixes in #690 and #709');
      console.log('closed the hole before it was used; there is nobody to remediate.');
    } else if (exposure === 0) {
      console.log('DELETION PREFLIGHT: DELETIONS FOUND, NO EXPOSURE.');
      console.log('Records were deleted, and none of them can still sign in on a revision with that rule.');
    } else {
      console.log('DELETION PREFLIGHT: EXPOSURE FOUND.');
      console.log(`${exposure} deleted athlete(s) still have a login that is active and not marked deleted.`);
      console.log('This is an owner decision, not a script\'s: re-run with a follow-up that');
      console.log('selects the ids once somebody has decided what to do about them.');
    }
    if (access.refusedAccounts > 0) {
      console.log(`${access.refusedAccounts} account(s) are marked deleted but flagged active: sign-in refuses`);
      console.log('them, but an admin screen shows them as active (docs/DATA_RETENTION.md, "Still open").');
    }

    await client.query('COMMIT');
    await client.end();
    process.exit(deletionPreflightExitCode(access));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    console.error('Deletion preflight failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Guarded so a test can import countDeletedAccess without running the check
// (or reading .env.local); `npm run pilot:check-deletion-preflight` runs it.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await main();
}
