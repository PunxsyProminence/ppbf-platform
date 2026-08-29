import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only diagnostic for the question the membership-account-fk migration
 * left open when it first failed against production: `all` reported
 * `orphan_membership_rows: 17` and rolled back without touching anything, so
 * 17 rows exist in pilot.organization_memberships whose account_id matches no
 * row in pilot.accounts, and nobody has looked at what they are.
 *
 * The migration's own comment predicts the shape: organization_memberships
 * never had a foreign key on account_id, so the retention purge
 * (pilot-cleanup-deleted-data.mjs) hard-deletes pilot.accounts and
 * pilot.parents but has no statement that touches
 * pilot.organization_memberships -- there was nothing forcing it to. This
 * confirms the count and the shape without guessing at identities: which
 * organizations, which roles, how old, and how the count compares to what
 * the retention job's own audit trail says it has purged.
 *
 * account_id on this table resolves to the person's login email unless an
 * admin supplied a hint, so it is treated as personal data throughout:
 * masked the same way duplicateGuardians.ts masks one (first character plus
 * domain), never printed in full, and never returned as a value the caller
 * could reconstruct.
 *
 * This performs SELECT statements only, inside an explicit READ ONLY
 * transaction, so it is safe to run directly against production: there is no
 * code path in this file that can mutate anything.
 */

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
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
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
  return value;
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

/**
 * Same mask as duplicateGuardians.ts's maskEmail: first character of the
 * local part, the rest starred, full domain. Not imported from there --
 * that module pulls in the app's `./db` pool wiring, which this standalone
 * script does not want -- so the one-line function is duplicated rather than
 * the dependency.
 */
export function maskAccountId(accountId) {
  if (typeof accountId !== 'string' || !accountId.includes('@')) {
    return accountId ? `(non-email id, length ${accountId.length})` : '(none)';
  }
  const [local, ...domainParts] = accountId.split('@');
  const domain = domainParts.join('@');
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

// High enough to be the complete set for any realistic accumulation of
// orphans, low enough that a pathological database cannot make this
// diagnostic print unboundedly. Exceeding it is reported, never silent --
// see pilot-check-multiorg-orphans.mjs, which this mirrors.
const ROW_LIMIT = 500;

export async function checkMembershipOrphans(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const orphanRows = await client.query(
      `select m.organization_id, m.role, m.active_flag, m.created_at, m.account_id
         from pilot.organization_memberships m
        where not exists (
          select 1 from pilot.accounts a where a.account_id = m.account_id
        )
        order by m.created_at
        limit ${ROW_LIMIT + 1}`,
    );
    const truncated = orphanRows.rows.length > ROW_LIMIT;
    const rows = truncated ? orphanRows.rows.slice(0, ROW_LIMIT) : orphanRows.rows;

    const totalResult = await client.query(
      `select count(*)::int as total
         from pilot.organization_memberships m
        where not exists (
          select 1 from pilot.accounts a where a.account_id = m.account_id
        )`,
    );
    const total = totalResult.rows[0].total;

    // Context, not identification: how many accounts the retention job's own
    // audit trail says it has ever purged. A large purge history consistent
    // with the orphan count supports the retention-purge hypothesis; it does
    // not prove any single row's origin, and this makes no claim that it does.
    const purgeHistory = await client.query(
      `select count(*)::int as purge_runs,
              coalesce(sum((details->>'accounts_deleted')::int), 0)::int as accounts_ever_purged
         from pilot.audit_events
        where event_type = 'data_purged' and entity_type = 'retention_cleanup'`,
    );

    await client.query('commit');
    return { total, rows, truncated, purgeHistory: purgeHistory.rows[0] };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  let result;
  try {
    result = await checkMembershipOrphans(client);
  } finally {
    await client.end();
  }

  const { total, rows, truncated, purgeHistory } = result;

  console.log('Membership account_id orphan check');
  console.log('====================================');
  console.log(`pilot.organization_memberships: ${total} orphaned row(s)`);
  console.log(
    `retention purge history: ${purgeHistory.purge_runs} run(s), `
    + `${purgeHistory.accounts_ever_purged} account(s) ever purged (from pilot.audit_events)`,
  );
  console.log('');

  if (total > 0) {
    const byOrg = new Map();
    for (const row of rows) {
      const key = row.organization_id;
      if (!byOrg.has(key)) byOrg.set(key, []);
      byOrg.get(key).push(row);
    }
    for (const [orgId, orgRows] of byOrg) {
      console.log(`  organization_id=${JSON.stringify(orgId)}: ${orgRows.length} row(s)`);
      for (const row of orgRows) {
        console.log(
          `    role=${row.role} active_flag=${row.active_flag} `
          + `created_at=${row.created_at.toISOString()} `
          + `account_id=${maskAccountId(row.account_id)}`,
        );
      }
    }
    if (truncated) {
      console.log(`  !! more than ${ROW_LIMIT} rows -- list above is TRUNCATED and incomplete`);
    } else if (rows.length !== total) {
      // Should be unreachable -- see the equivalent comment in
      // pilot-check-multiorg-orphans.mjs. Said explicitly rather than left to
      // disagree silently.
      console.log(`  !! listed ${rows.length} of ${total} row(s) -- output is inconsistent`);
    }
  }
  console.log('====================================');

  if (total === 0) {
    console.log('PILOT MEMBERSHIP ORPHAN CHECK: CLEAN');
    console.log(
      'No orphaned account_id values in pilot.organization_memberships. '
      + 'Adding the foreign key (pilot:apply-membership-account-fk) will not fail on existing data.',
    );
  } else {
    console.log(`PILOT MEMBERSHIP ORPHAN CHECK: ORPHANS FOUND (${total} total row(s))`);
    console.log(
      'Applying pilot:apply-membership-account-fk as-is WILL fail with the count above. '
      + 'This check does not decide whether to delete or keep these rows -- that is a data '
      + 'decision for the platform owner, not something this diagnostic can determine.',
    );
  }

  return { total, rows, truncated, purgeHistory };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { total } = await run();
    // Mirrors pilot-check-multiorg-orphans.mjs: exits non-zero on orphans
    // found so CI shows this as a stop sign, not a passing diagnostic that
    // happened to print a warning.
    process.exit(total === 0 ? 0 : 1);
  } catch (error) {
    console.error('PILOT MEMBERSHIP ORPHAN CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
