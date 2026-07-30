import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only report of accounts stranded by the pre-#46 guardian provisioning
 * defect: non-athlete accounts whose auth_provider is 'ppbf_local'.
 *
 * Such an account has NO working login path at all:
 *   - PIN login is athlete-only (loginWithAccountIdAndPin returns null for
 *     every other role),
 *   - Microsoft login resolves identities by lower(login_email) with
 *     auth_provider = 'microsoft', so a ppbf_local row never matches,
 *   - and resolvePrincipal revokes any non-athlete ppbf_local session on
 *     sight, so even a session minted before that rule shipped is dead.
 *
 * The intake review path used to provision guardians exactly this way
 * (createParentAccount wrote a local PIN account for role 'parent'). #46
 * fixed the forward path -- guardians are now Microsoft-provisioned through
 * createOrUpdateMicrosoftStaffAccount -- but changed no existing rows, so
 * every guardian onboarded before it is still stranded. This script reports
 * the blast radius; it changes nothing.
 *
 * Remediation is deliberately NOT automated here. Note for whoever performs
 * it: staffProvisioning refuses to re-invite an email while a ppbf_local row
 * holds it ("this email is already used by a PIN-based athlete account"), so
 * each account below needs an explicit operator decision, not a fresh invite.
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

// Emails go to a CI job summary, so they are masked to first character plus
// domain -- enough for an operator to recognize the person, not enough to
// republish the address. The account_id prints verbatim because it is the
// remediation key: without it the operator cannot act on the row at all.
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) {
    return email ?? '(none)';
  }
  const [local, ...domainParts] = email.split('@');
  const domain = domainParts.join('@');
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export async function checkStrandedGuardians(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    // Every non-athlete on ppbf_local, not just role 'parent'. The intake
    // defect only ever wrote parents, but any other role in this state is
    // stranded for exactly the same three reasons and belongs in the same
    // report rather than staying invisible until someone tries to sign in.
    const accountsResult = await client.query(
      `select
         a.account_id,
         a.login_email,
         a.role,
         a.organization_id,
         a.active_flag,
         (a.pin_hash is not null) as has_pin,
         a.created_at,
         coalesce(pg.parent_ids, '{}') as parent_ids,
         coalesce(pg.linked_athlete_count, 0)::int as linked_athlete_count
       from pilot.accounts a
       left join (
         select p.account_id,
                p.organization_id,
                -- distinct on both aggregates: the join fans each parent row
                -- out once per guardian link, which would otherwise repeat
                -- parent_ids and count an athlete once per linking record.
                array_agg(distinct p.parent_id) as parent_ids,
                count(distinct gl.athlete_id)::int as linked_athlete_count
         from pilot.parents p
         left join pilot.guardian_links gl
           on gl.organization_id = p.organization_id
          and gl.parent_id = p.parent_id
         group by p.account_id, p.organization_id
       ) pg on pg.account_id = a.account_id and pg.organization_id = a.organization_id
       where a.auth_provider = 'ppbf_local'
         and a.role <> 'athlete'
       order by a.role, a.created_at asc, a.account_id asc`,
    );

    const byRoleResult = await client.query(
      `select a.role,
              count(*)::int as account_count,
              (count(*) filter (where a.active_flag))::int as active_count
       from pilot.accounts a
       where a.auth_provider = 'ppbf_local'
         and a.role <> 'athlete'
       group by a.role
       order by account_count desc, a.role asc`,
    );

    await client.query('COMMIT');
    return { accounts: accountsResult.rows, byRole: byRoleResult.rows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
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
  let report;
  try {
    report = await checkStrandedGuardians(client);
  } finally {
    await client.end();
  }

  const { accounts, byRole } = report;

  console.log('Stranded guardian check (non-athlete accounts on ppbf_local)');
  console.log('=============================================================');
  if (accounts.length === 0) {
    console.log('(no affected accounts)');
  }
  for (const row of byRole) {
    console.log(`role ${row.role}: ${row.account_count} account(s), ${row.active_count} active`);
  }
  for (const account of accounts) {
    const flags = [
      account.active_flag ? 'active' : 'inactive',
      account.has_pin ? 'has PIN' : 'no PIN',
      account.linked_athlete_count > 0
        ? `${account.linked_athlete_count} linked athlete(s)`
        : 'no athlete links',
    ].join(', ');
    console.log(
      `    ${account.role} account_id=${JSON.stringify(account.account_id)} `
      + `email=${maskEmail(account.login_email)} org=${account.organization_id} (${flags})`,
    );
  }
  console.log('=============================================================');

  if (accounts.length === 0) {
    console.log('PILOT STRANDED GUARDIAN CHECK: CLEAN');
    console.log(
      'No non-athlete account is on ppbf_local. Every guardian and staff row '
      + 'holds a Microsoft identity and can sign in (tenant membership permitting).',
    );
  } else {
    console.log(`PILOT STRANDED GUARDIAN CHECK: STRANDED ACCOUNTS FOUND (${accounts.length})`);
    console.log(
      'Each account above has no working login path: PIN login is athlete-only, '
      + 'Microsoft login only matches auth_provider=microsoft, and any existing '
      + 'session is revoked on first use. #46 fixed provisioning going forward '
      + 'but did not touch these rows. Re-inviting the same email is refused '
      + 'while the ppbf_local row holds it, so each row needs an explicit '
      + 'operator decision (re-key the account to Microsoft, or retire it).',
    );
  }

  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { accounts } = await run();
    // Exits non-zero when stranded accounts exist, not on a script error --
    // this is a gate result, not a crash, and CI should show it as a stop
    // sign rather than a passing diagnostic that happened to print a warning.
    process.exit(accounts.length === 0 ? 0 : 1);
  } catch (error) {
    console.error('PILOT STRANDED GUARDIAN CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
