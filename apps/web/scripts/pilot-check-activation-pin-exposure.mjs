import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only report on athlete accounts still sitting on a PIN an administrator
 * typed for them.
 *
 * WHY THIS EXISTS. activateAccountPin -- the supported way a PIN is set on an
 * athlete promoted from intake -- did not set must_change_pin. The column
 * defaults to false, so those accounts signed in on a credential their
 * administrator knows and were never once asked to replace it. The code fix
 * changes what happens from now on; it does nothing for accounts already in
 * that state, and nothing anywhere reports them.
 *
 * THE COARSE QUERY OVER-COUNTS, WHICH IS WHY THIS IS NOT A ONE-LINER.
 * `must_change_pin = false` is also the normal, healthy state of every athlete
 * who has chosen their own PIN -- changeOwnPin sets it false on success. So
 * counting that column alone reports the entire healthy roster as exposed,
 * which is worse than no report: it would be dismissed on first reading and
 * then ignored when it mattered.
 *
 * The narrowing is the audit trail. An account is reported only when it has a
 * `pin_activate` event and NO `change_own_pin` event after it. Both are
 * written by the routes that perform those acts
 * (admin/accounts/pin-reset and auth/change-pin), so this asks what actually
 * happened rather than inferring it from current state.
 *
 * WHAT IT CANNOT SEE, stated because it changes how the number should be read:
 * an account activated before audit events carried these action strings has no
 * `pin_activate` row and will not appear, so the count is a FLOOR, not a total.
 * The coarse figure is printed alongside as the ceiling.
 *
 * REMEDIATION IS PER-ACCOUNT AND HUMAN, matching the stranded-guardian
 * precedent: an administrator resets the PIN for each flagged athlete, which
 * already sets must_change_pin and revokes their sessions. This script writes
 * nothing and deliberately offers no bulk fix -- a bulk flag flip would lock
 * every listed athlete out of their own account at their next session with no
 * warning and no one expecting it.
 *
 * Every statement runs inside an explicit READ ONLY transaction, so Postgres
 * itself refuses any write this file could attempt. Safe against production by
 * construction, not by intent.
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
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
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

export async function checkActivationPinExposure(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const database = (await client.query('select current_database() as db')).rows[0].db;

    // The ceiling. Every athlete on a local PIN who is not currently being
    // forced to change it -- which includes everyone who has healthily chosen
    // their own, so this number is not a finding on its own.
    const ceiling = await client.query(
      `select count(*)::int as count
         from pilot.accounts
        where role = 'athlete'
          and auth_provider = 'ppbf_local'
          and active_flag = true
          and pin_hash is not null
          and must_change_pin = false`,
    );

    // The floor. Activated by an administrator, and no self-chosen PIN since.
    const exposed = await client.query(
      `select
         a.account_id,
         a.organization_id,
         a.athlete_id,
         act.activated_at::date::text as activated_on,
         (now() - act.activated_at)::text as held_for
       from pilot.accounts a
       join lateral (
         select max(e.created_at) as activated_at
           from pilot.audit_events e
          where e.entity_type = 'account'
            and e.entity_id = a.account_id
            and e.details->>'action' = 'pin_activate'
       ) act on act.activated_at is not null
       where a.role = 'athlete'
         and a.auth_provider = 'ppbf_local'
         and a.active_flag = true
         and a.pin_hash is not null
         and a.must_change_pin = false
         and not exists (
           select 1
             from pilot.audit_events c
            where c.entity_type = 'account'
              and c.entity_id = a.account_id
              and c.details->>'action' = 'change_own_pin'
              and c.created_at > act.activated_at
         )
       order by act.activated_at`,
    );

    // Named separately so a reader can tell "nobody was ever activated" from
    // "everybody who was activated has since chosen their own PIN". Those are
    // very different states and both produce an empty list above.
    const everActivated = await client.query(
      `select count(distinct entity_id)::int as count
         from pilot.audit_events
        where entity_type = 'account'
          and details->>'action' = 'pin_activate'`,
    );

    await client.query('COMMIT');

    return {
      database,
      ceiling: ceiling.rows[0].count,
      everActivated: everActivated.rows[0].count,
      exposed: exposed.rows,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export function report(result) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  push(`Activation-PIN exposure report -- database: ${result.database}`);
  push();
  push('An athlete whose PIN was typed by an administrator and never replaced is');
  push('signed in on a credential somebody else knows.');
  push();
  push(`  Ever activated by an admin:            ${result.everActivated}`);
  push(`  Still on that PIN (the finding):       ${result.exposed.length}`);
  push(`  Not currently forced to change (all):  ${result.ceiling}  <- includes every`);
  push('                                             healthy self-chosen PIN, so this');
  push('                                             is a ceiling, not a finding.');
  push();

  if (result.exposed.length === 0) {
    push(result.everActivated === 0
      ? 'No account has ever been activated this way, so there is nothing to remediate.'
      : 'Every activated account has since chosen its own PIN. Nothing to remediate.');
  } else {
    push('=== Accounts to remediate ===');
    for (const row of result.exposed) {
      push(`  ${String(row.account_id).padEnd(28)} org=${String(row.organization_id).padEnd(16)}`
        + ` athlete=${String(row.athlete_id ?? '(none)').padEnd(20)} activated ${row.activated_on}`);
    }
    push();
    push('For each: an organization administrator resets that athlete PIN in /admin/pin,');
    push('or "Reset to starting PIN" in /admin/people. Either sets must_change_pin and');
    push('revokes their sessions, so the next sign-in must choose a new PIN.');
    push();
    push('Deliberately NOT a bulk flag flip. Setting must_change_pin on all of these at');
    push('once locks every listed athlete out of everything at their next session, with');
    push('no warning and nobody expecting it. One at a time, by someone who can tell the');
    push('athlete why.');
  }

  push();
  push('=== What this cannot see ===');
  push('  An account activated before audit details carried these action strings has');
  push('  no pin_activate row and does not appear above. The finding is a FLOOR.');

  return lines.join('\n');
}

async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();

  let result;
  try {
    result = await checkActivationPinExposure(client);
  } finally {
    await client.end();
  }

  console.log(report(result));
  console.log();

  if (result.exposed.length > 0) {
    console.log(
      `ACTIVATION PIN EXPOSURE NEEDS A HUMAN: ${result.exposed.length} athlete account(s) `
      + 'are still on a PIN an administrator typed.',
    );
  } else {
    console.log('ACTIVATION PIN EXPOSURE CHECK PASS');
  }

  // Non-zero only when a person still has to do something, matching the other
  // pilot:check-* scripts.
  process.exitCode = result.exposed.length > 0 ? 1 : 0;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('ACTIVATION PIN EXPOSURE CHECK FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
