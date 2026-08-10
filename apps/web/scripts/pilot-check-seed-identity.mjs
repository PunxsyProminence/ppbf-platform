// Read-only lookup for the two identifiers every seeding workflow asks an operator to type.
//
// WHY THIS EXISTS. PRODUCTION_STATE.json records the blocker in its own words: "no read-only
// workflow exposes the id -- check-database.yml has three fixed checks and none of them look it up.
// It has to come from a human who can read it out of the database." DEPLOY_RUNBOOK_2026-08-08.md
// says the same and adds the trap: production's active platform owner is
// Admin@punxsyprominence.org with a CAPITAL A, and the lowercase row is retired.
//
// So the state before this check was: to seed anything, somebody opens a SQL client against
// production and reads an id out by eye. That is the exact activity postgres-write-target.mjs was
// written to discourage -- a human holding a production connection string in a shell already cost
// this project 361 orphaned rows on 2026-07-18. Needing an id is not a reason to reintroduce it.
//
// SELECT ONLY. No INSERT, UPDATE, DELETE or DDL. It cannot change anything, which is why it belongs
// in check-database.yml beside the other read-only checks rather than inside a seeding workflow.
//
// WHAT IT DELIBERATELY DOES NOT PRINT. Only accounts whose role is platform_owner,
// organization_admin or admin -- the three a seed actor may have. Athlete and parent accounts are
// never selected, because "help the operator find an id" is not a reason to print a roster of
// families, and a check that returns more than its purpose requires is one people are right to be
// nervous about running.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// The three roles import-shadow-research.mjs and the reference-data loaders accept as an actor.
const PRIVILEGED_ROLES = ['platform_owner', 'organization_admin', 'admin'];

async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');
  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
  }
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

const pad = (value, width) => String(value ?? '').padEnd(width);

async function main() {
  await loadEnvLocal();
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) {
    console.error('Missing AZURE_POSTGRES_CONNECTION_STRING');
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();

  try {
    const orgs = await client.query(
      `select organization_id, organization_name, status
         from pilot.organizations
        order by organization_id`,
    );

    console.log('ORGANIZATIONS (candidates for organization_id)');
    console.log(`  ${pad('organization_id', 40)}${pad('status', 12)}name`);
    for (const r of orgs.rows) {
      console.log(`  ${pad(r.organization_id, 40)}${pad(r.status, 12)}${r.organization_name ?? ''}`);
    }
    console.log('');

    const actors = await client.query(
      `select account_id, role, organization_id, active_flag, is_platform_owner
         from pilot.accounts
        where role = any($1::text[])
        order by is_platform_owner desc, role, account_id`,
      [PRIVILEGED_ROLES],
    );

    console.log('PRIVILEGED ACCOUNTS (candidates for seed_account_id)');
    if (actors.rowCount === 0) {
      console.log('  none -- a seed cannot run until a privileged account exists');
    } else {
      console.log(`  ${pad('account_id', 44)}${pad('role', 20)}${pad('active', 8)}organization_id`);
      for (const r of actors.rows) {
        // active_flag is printed rather than filtered out: an inactive privileged account is
        // exactly what an operator would otherwise copy and then hit SEED_ACCOUNT_INACTIVE on.
        console.log(`  ${pad(r.account_id, 44)}${pad(r.role, 20)}${pad(r.active_flag ? 'yes' : 'NO', 8)}${r.organization_id ?? ''}`);
      }
    }
    console.log('');

    // Case is load-bearing here and invisible in prose. The runbook records that production's
    // owner carries a capital A while a retired lowercase row exists, so any pair differing only
    // by case is called out rather than left for the operator to spot.
    const byLower = new Map();
    for (const r of actors.rows) {
      const key = r.account_id.toLowerCase();
      byLower.set(key, [...(byLower.get(key) ?? []), r]);
    }
    const caseCollisions = [...byLower.values()].filter((group) => group.length > 1);
    if (caseCollisions.length) {
      console.log('CASE-DIFFERING DUPLICATES -- copy the exact string, capitals included');
      for (const group of caseCollisions) {
        for (const r of group) {
          console.log(`  ${pad(r.account_id, 44)}active=${r.active_flag ? 'yes' : 'NO'}`);
        }
      }
      console.log('');
    }

    const activeCount = actors.rows.filter((r) => r.active_flag).length;
    console.log(`organizations: ${orgs.rowCount} | privileged accounts: ${actors.rowCount} (${activeCount} active)`);
    console.log('PILOT SEED IDENTITY CHECK PASS');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('PILOT SEED IDENTITY CHECK FAIL');
  console.error(String(error?.message ?? error));
  process.exit(1);
});
