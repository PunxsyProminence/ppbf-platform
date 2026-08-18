import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only report: of the active athletes in each gym, how many have a
 * medical administrative status on file, and what does it say?
 *
 * WHY THIS EXISTS
 *
 * assertMedicalStatusAllowsRecommendation (shadowRecommendations.ts) now runs
 * unconditionally on every SHADOW recommendation and decision, and blocks
 * unless the athlete's latest medical administrative status is a 'cleared'
 * record that is still in force -- shadowMedicalStatus.ts's isClearanceCurrent
 * also requires the record's `expires_at` (if any) to be in the future. That
 * closed a real hole -- the guard used to be armed by a client-supplied
 * boolean, so omitting one JSON field skipped it entirely -- but it also
 * means an athlete with no status row on file, one still 'pending', or one
 * whose 'cleared' record has lapsed, blocks every recommendation and decision
 * for them until a coach explicitly (re-)sets one.
 *
 * That is the intended reading of the guard ("absence of a decision is not a
 * decision", and per shadowMedicalStatus.ts, "a clearance that has run out is
 * not a clearance either"), not a bug. But it turns "how many athletes are
 * actually covered right now" from a curiosity into a deploy precondition:
 * rolling the fail-closed gate out to a gym with real athletes and no current
 * clearance data logs every coach interaction as blocked on day one. This
 * script answers that question against a real database instead of guessing
 * at it.
 *
 * The `cleared` / lapsed distinction below mirrors effectiveMedicalStatus's
 * own vocabulary (EXPIRED_CLEARANCE_STATUS) rather than inventing a second
 * one: a lapsed clearance is a materially different remediation ("re-confirm")
 * from no record or a pending one ("decide for the first time"), so folding it
 * into `cleared` would overstate coverage and folding it into `no_record`
 * would erase who last cleared the athlete and when.
 *
 * SELECT statements only, inside an explicit READ ONLY transaction: there is
 * no code path in this file that can mutate anything, so it is safe to point
 * at production.
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

export async function checkMedicalClearanceCoverage(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    // "Latest" resolved the same way getLatestMedicalAdministrativeStatus
    // does -- order by effective_at desc, limit 1 -- and "current" resolved
    // the same way isClearanceCurrent does -- status = 'cleared' and
    // (expires_at is null or expires_at > now()) -- so this report can never
    // disagree with what the gate itself would decide for a given athlete.
    const byOrg = await client.query(
      `select o.organization_id,
              count(*) filter (where a.active_flag)::int as active_athletes,
              count(*) filter (
                where a.active_flag and latest.status = 'cleared'
                  and (latest.expires_at is null or latest.expires_at > now())
              )::int as cleared,
              count(*) filter (
                where a.active_flag and latest.status = 'cleared'
                  and latest.expires_at is not null and latest.expires_at <= now()
              )::int as cleared_expired,
              count(*) filter (where a.active_flag and latest.status = 'restricted')::int as restricted,
              count(*) filter (where a.active_flag and latest.status = 'not_cleared')::int as not_cleared,
              count(*) filter (where a.active_flag and latest.status = 'pending')::int as pending,
              count(*) filter (where a.active_flag and latest.status is null)::int as no_record
         from pilot.organizations o
         join pilot.athletes a on a.organization_id = o.organization_id
         left join lateral (
           select s.status, s.expires_at
             from pilot.shadow_medical_administrative_status s
            where s.organization_id = a.organization_id and s.athlete_id = a.athlete_id
            order by s.effective_at desc
            limit 1
         ) latest on true
        group by o.organization_id
        order by o.organization_id`,
    );

    return { byOrg: byOrg.rows };
  } finally {
    // Read-only transaction: nothing to commit, and rolling back is the
    // honest end for a diagnostic.
    await client.query('ROLLBACK').catch(() => {});
  }
}

function pad(value, width) {
  return String(value ?? '').padEnd(width);
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  let result;
  try {
    result = await checkMedicalClearanceCoverage(client);
  } finally {
    await client.end();
  }

  console.log('SHADOW medical clearance coverage check');
  console.log('========================================');
  console.log('');
  console.log('PER ORGANIZATION (active athletes only)');
  console.log(`  ${pad('organization_id', 24)}${pad('active', 8)}${pad('cleared', 9)}${pad('lapsed', 8)}${pad('restricted', 12)}${pad('not_cleared', 13)}${pad('pending', 9)}no_record`);
  for (const r of result.byOrg) {
    console.log(
      `  ${pad(r.organization_id, 24)}${pad(r.active_athletes, 8)}${pad(r.cleared, 9)}${pad(r.cleared_expired, 8)}`
      + `${pad(r.restricted, 12)}${pad(r.not_cleared, 13)}${pad(r.pending, 9)}${r.no_record}`,
    );
  }

  const totals = result.byOrg.reduce(
    (acc, r) => ({
      active: acc.active + r.active_athletes,
      cleared: acc.cleared + r.cleared,
      lapsed: acc.lapsed + r.cleared_expired,
      blocked: acc.blocked + r.cleared_expired + r.restricted + r.not_cleared + r.pending + r.no_record,
    }),
    { active: 0, cleared: 0, lapsed: 0, blocked: 0 },
  );

  console.log('');
  if (totals.active === 0) {
    console.log('PILOT MEDICAL CLEARANCE COVERAGE CHECK: NO ACTIVE ATHLETES');
    console.log('  No gym has an active athlete on file yet -- the fail-closed gate has no roster to be tested against.');
  } else if (totals.blocked === 0) {
    console.log('PILOT MEDICAL CLEARANCE COVERAGE CHECK: FULLY COVERED');
    console.log(`  All ${totals.active} active athlete(s) across ${result.byOrg.length} organization(s) have a current 'cleared' status on file.`);
  } else {
    console.log('PILOT MEDICAL CLEARANCE COVERAGE CHECK: GAP FOUND');
    console.log(
      `  ${totals.blocked} of ${totals.active} active athlete(s) do NOT have a current 'cleared' status on file `
      + `(no record, 'pending', 'restricted', 'not_cleared', or a lapsed clearance). Every SHADOW recommendation `
      + 'and decision for those athletes is blocked by design until a coach sets or re-confirms a \'cleared\' '
      + 'status for them -- setting one is the remedy, not a workaround.',
    );
    if (totals.lapsed > 0) {
      console.log(
        `  ${totals.lapsed} of those were cleared once but the clearance has since expired -- that remedy is `
        + 're-confirm, not decide for the first time.',
      );
    }
  }

  return result;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
    // Always zero: this reports a state (how much of the roster has a
    // current clearance record), it does not gate one. A gym with zero
    // cleared athletes pre-launch is expected, not a defect.
    process.exit(0);
  } catch (error) {
    console.error('PILOT MEDICAL CLEARANCE COVERAGE CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
