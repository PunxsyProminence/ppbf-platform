import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only report of video publications (pilot.video_publications) whose
 * athlete does not have full guardian media consent on file.
 *
 * T-008's live gate (guardianConsent.ts's assertGuardianMediaConsent, wired
 * into the video-compliance admin route) refuses to APPROVE a publication
 * without consent -- but a publication submitted before consent was
 * withdrawn, or one still sitting in draft/pending_review while a guardian's
 * consent lapses, is invisible to that gate until someone tries to approve
 * it. This script is the standing answer to "which videos, right now, could
 * not clear the gate if someone tried" -- for a compliance sweep, not a
 * blocking check.
 *
 * "Missing consent" means: the athlete has zero linked guardians (consent
 * unverifiable), or at least one linked guardian's latest photo_media
 * waiver is not status='signed' (never signed, or signed then withdrawn).
 * Matches checkGuardianMediaConsent's own definition exactly -- this script
 * intentionally does not reimplement that logic in SQL, to avoid the two
 * ever drifting apart.
 *
 * This performs SELECT statements only, inside an explicit READ ONLY
 * transaction, so it is safe to run directly against production: there is
 * no code path in this file that can mutate anything.
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

export async function checkVideosMissingConsent(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    // For each (athlete, guardian) pair, "current" is the latest photo_media
    // waiver row -- DISTINCT ON with the matching ORDER BY answers "latest
    // per group" in one pass. A publication is missing consent if the
    // athlete has no guardian_links row at all, OR at least one linked
    // guardian's current row is absent or not status='signed'.
    const result = await client.query(
      `with current_consent as (
         select distinct on (organization_id, athlete_id, parent_id)
           organization_id, athlete_id, parent_id, status
         from pilot.waivers
         where waiver_type = 'photo_media' and parent_id is not null
         order by organization_id, athlete_id, parent_id, created_at desc
       ),
       guardian_gap as (
         select gl.organization_id, gl.athlete_id, gl.parent_id,
                cc.status is distinct from 'signed' as unsigned
         from pilot.guardian_links gl
         left join current_consent cc
           on cc.organization_id = gl.organization_id
          and cc.athlete_id = gl.athlete_id
          and cc.parent_id = gl.parent_id
       ),
       athlete_consent_state as (
         select a.organization_id, a.athlete_id, a.full_name,
                exists (select 1 from pilot.guardian_links gl where gl.organization_id = a.organization_id and gl.athlete_id = a.athlete_id) as has_guardians,
                coalesce(bool_or(gg.unsigned), false) as any_guardian_unsigned
         from pilot.athletes a
         left join guardian_gap gg
           on gg.organization_id = a.organization_id
          and gg.athlete_id = a.athlete_id
         group by a.organization_id, a.athlete_id, a.full_name
       )
       select
         p.organization_id, p.publication_id, p.title, p.status as publication_status,
         p.athlete_id, acs.full_name as athlete_name,
         acs.has_guardians, acs.any_guardian_unsigned
       from pilot.video_publications p
       join athlete_consent_state acs
         on acs.organization_id = p.organization_id
        and acs.athlete_id = p.athlete_id
       where p.status not in ('archived', 'retracted')
         and (acs.has_guardians = false or acs.any_guardian_unsigned = true)
       order by p.organization_id, p.status, p.title`,
    );

    await client.query('COMMIT');
    return { publications: result.rows };
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
    report = await checkVideosMissingConsent(client);
  } finally {
    await client.end();
  }

  const { publications } = report;

  console.log('Videos missing guardian media consent');
  console.log('======================================');
  if (publications.length === 0) {
    console.log('(none)');
  }
  for (const row of publications) {
    const reason = !row.has_guardians ? 'no guardians on file' : 'a linked guardian has not signed (or withdrew)';
    console.log(
      `    org=${row.organization_id} publication_id=${JSON.stringify(row.publication_id)} `
      + `title=${JSON.stringify(row.title)} status=${row.publication_status} `
      + `athlete=${JSON.stringify(row.athlete_name)} (${reason})`,
    );
  }
  console.log('======================================');

  if (publications.length === 0) {
    console.log('PILOT VIDEOS MISSING CONSENT CHECK: CLEAN');
  } else {
    console.log(`PILOT VIDEOS MISSING CONSENT CHECK: GAPS FOUND (${publications.length})`);
    console.log(
      'Each publication above would be refused if an admin tried to approve it '
      + 'today (see the video-compliance console\'s guardian-consent gate). '
      + 'This is a standing report, not an action -- resolve by either the '
      + 'guardian granting consent, or linking a guardian if none is on file.',
    );
  }

  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { publications } = await run();
    // Exits non-zero when gaps exist, not on a script error -- a gate
    // result, not a crash, so CI shows it as a stop sign.
    process.exit(publications.length === 0 ? 0 : 1);
  } catch (error) {
    console.error('PILOT VIDEOS MISSING CONSENT CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
