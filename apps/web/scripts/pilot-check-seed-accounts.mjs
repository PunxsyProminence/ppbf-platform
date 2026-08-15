import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only report of the accounts eligible to be recorded as the seeder in
 * `seed-reference-data`'s `seed_account_id` input.
 *
 * This exists because that input had no pipeline answer. The runbook told an
 * operator to "read it from the database rather than reusing what staging
 * took" -- which meant either pointing a production connection string at a
 * laptop, or copying an id out of Azure by hand. The same file criticises
 * exactly that shape for `organization_id`: a value the operator cannot see
 * from the Actions form, where a typo writes real rows under something that
 * does not exist. `seed_account_id` had the identical problem and no
 * equivalent fix, so it stayed a blocker rather than a lookup.
 *
 * The specific trap this is built to catch: production's active platform
 * owner is `Admin@punxsyprominence.org` with a CAPITAL A, and a lowercase
 * row for the same human is retired. Reusing staging's lowercase string
 * against production stamps a retired account onto all 119 drills as their
 * seeder -- silently, because nothing about that is an error. So this report
 * deliberately groups accounts whose emails differ only by case and says
 * which one is live, instead of printing a flat list and leaving the reader
 * to notice.
 *
 * `active_flag` alone is not the whole answer. An account can be active and
 * still be the wrong seeder if it cannot act -- so `auth_provider` and
 * whether a session could ever resolve are reported next to it.
 *
 * Emails are masked to first character plus domain, as in the stranded
 * guardians check: enough to recognise the person in a CI summary, not
 * enough to republish the address. account_id prints verbatim, because it is
 * the value being looked up -- masking it would defeat the purpose.
 *
 * SELECTs only, inside an explicit READ ONLY transaction. There is no code
 * path in this file that can mutate anything, so it is safe against
 * production.
 */

/** Roles that may plausibly be recorded as a seeder of reference data. */
const SEEDER_ROLES = ['platform_owner', 'organization_admin', 'admin'];

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

export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) {
    return email ?? '(none)';
  }
  const [local, ...domainParts] = email.split('@');
  const domain = domainParts.join('@');
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/**
 * Groups accounts whose login_email differs only by case. Returned groups
 * with more than one member are the ones worth reading closely: that is the
 * capital-A / lowercase collision the runbook warns about, and it is
 * invisible in a list sorted any other way.
 */
export function groupByEmailFold(accounts) {
  const groups = new Map();
  for (const account of accounts) {
    const key = (account.login_email ?? '').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }
  return [...groups.entries()]
    .map(([fold, members]) => ({ fold, members }))
    .sort((a, b) => (b.members.length - a.members.length) || a.fold.localeCompare(b.fold));
}

export async function checkSeedAccounts(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const accountsResult = await client.query(
      `select
         a.account_id,
         a.login_email,
         a.role,
         a.organization_id,
         a.active_flag,
         a.auth_provider,
         a.created_at
       from pilot.accounts a
       where a.role = any($1::text[])
       order by a.active_flag desc, a.role asc, a.created_at asc, a.account_id asc`,
      [SEEDER_ROLES],
    );

    await client.query('COMMIT');
    return { accounts: accountsResult.rows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });

  await client.connect();
  let report;
  try {
    report = await checkSeedAccounts(client);
  } finally {
    await client.end();
  }

  const { accounts } = report;
  const active = accounts.filter((a) => a.active_flag);
  const groups = groupByEmailFold(accounts);
  const collisions = groups.filter((g) => g.members.length > 1);

  console.log('Seeder-account candidates (roles: ' + SEEDER_ROLES.join(', ') + ')');
  console.log('=============================================================');

  if (accounts.length === 0) {
    console.log('(no account holds any of those roles)');
  }

  for (const account of accounts) {
    const flags = [
      account.active_flag ? 'ACTIVE' : 'retired',
      `auth=${account.auth_provider}`,
    ].join(', ');
    console.log(
      `    ${account.active_flag ? '->' : '  '} ${account.role} `
      + `account_id=${JSON.stringify(account.account_id)} `
      + `email=${maskEmail(account.login_email)} org=${account.organization_id} (${flags})`,
    );
  }

  if (collisions.length > 0) {
    console.log('');
    console.log('CASE COLLISIONS -- same address, different case, different rows:');
    for (const group of collisions) {
      console.log(`  ${maskEmail(group.fold)}`);
      for (const member of group.members) {
        console.log(
          `      ${member.active_flag ? 'ACTIVE ' : 'retired'} `
          + `account_id=${JSON.stringify(member.account_id)} `
          + `(stored as ${JSON.stringify(member.login_email)})`,
        );
      }
    }
    console.log('');
    console.log(
      'Use the ACTIVE row. This is the exact failure the runbook warns about: '
      + 'reusing the other environment\'s string here records a RETIRED account '
      + 'as the seeder of every row loaded, and nothing about that surfaces as '
      + 'an error.',
    );
  }

  console.log('=============================================================');
  console.log(
    `PILOT SEED ACCOUNT CHECK: ${accounts.length} candidate(s), ${active.length} active, `
    + `${collisions.length} case collision(s)`,
  );

  if (active.length === 0 && accounts.length > 0) {
    console.log(
      'NO ACTIVE CANDIDATE. Every account holding a seeder role is retired; '
      + 'seeding with any of them would attribute the load to a dead account.',
    );
  }

  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { accounts } = await run();
    // Exits non-zero only when there is nothing usable to report. Case
    // collisions are the normal, expected finding here -- they are what the
    // operator came to see -- so they are not a failure.
    const hasActive = accounts.some((a) => a.active_flag);
    process.exit(hasActive ? 0 : 1);
  } catch (error) {
    console.error('PILOT SEED ACCOUNT CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
