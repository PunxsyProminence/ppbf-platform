// Read-only report of guardians split across two pilot.parents rows.
//
// WHY THIS EXISTS. #281 taught the roster import to write a guardian without creating a login: a
// content-hashed parent_id, account_id left NULL, and one pilot.guardian_links row per sibling on
// the roster. Inviting that guardian afterwards did not find the row -- the invite looked for
// `account_id = $account or parent_id = 'par-' || $account`, and an imported row satisfies neither
// -- so it inserted a SECOND pilot.parents row for the same human. The account attached to the new
// row; the sibling links stayed on the first.
//
// Nothing errored, and nothing shows it. Every parent read path resolves children through
// pilot.parents joined on account_id and then pilot.guardian_links, so the orphaned row is simply
// unreachable. The guardian signs in, the page renders healthy, and they see whichever child was
// named in their invite -- with no indication the others exist.
//
// The write path is fixed. This exists because the fix changed no existing rows: any database where
// the import has run AND a guardian has been invited since #281 merged already carries these pairs,
// and there is no error anywhere for an operator to notice.
//
// SELECT ONLY, inside an explicit READ ONLY transaction, so Postgres itself refuses any write this
// file could attempt. Safe to run against production, and belongs in check-database.yml beside the
// other read-only checks rather than inside a seeding workflow.
//
// REMEDIATION IS DELIBERATELY NOT AUTOMATED. Merging two guardian records means re-pointing
// guardian_links onto the claimed row and deleting the orphan, and the pairs this finds are not all
// the same case: two unclaimed rows sharing an address mean the roster file disagreed with itself,
// which is a human's call about which family is which, not a script's. This reports the blast radius
// and the exact ids needed to act.
//
// WHAT IT DELIBERATELY DOES NOT PRINT. Emails are masked, and athletes are identified by athlete_id
// only -- never by name, dob or contact details. The ids are the remediation key, so they print; a
// roster of families is not needed to fix this and a check that returns more than its purpose
// requires is one people are right to be nervous about running.

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

// Masked the same way as the stranded-guardian check, and for the same reason: this goes to a CI job
// summary. First character plus domain is enough to recognize a person, not enough to republish the
// address. parent_id and account_id print verbatim -- they are what an operator acts on.
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) {
    return email ?? '(none)';
  }
  const [local, ...domainParts] = email.split('@');
  const domain = domainParts.join('@');
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export async function checkDuplicateGuardians(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    // Grouped on the NORMALIZED address, because that is the key the importer deduplicates on and
    // the key the invite now claims by. A row with no email is excluded rather than grouped as
    // ''--  two guardians who both lack an address are not evidence of anything, and lumping them
    // together would manufacture findings.
    //
    // hidden_athlete_ids is the finding that matters. Everything else is context: it is the set of
    // athletes reachable ONLY through an unclaimed row, which is exactly the set of children the
    // guardian cannot see. A group where that set is empty is reported as informational (the split
    // is real but currently costs the family nothing), so the two are never conflated.
    const groupsResult = await client.query(
      `with normalized as (
         select
           p.organization_id,
           p.parent_id,
           p.account_id,
           nullif(lower(trim(coalesce(p.email, ''))), '') as email_key,
           p.email as email_raw
         from pilot.parents p
       ),
       links as (
         select organization_id, parent_id, array_agg(distinct athlete_id order by athlete_id) as athlete_ids
         from pilot.guardian_links
         group by organization_id, parent_id
       ),
       rows_with_links as (
         select
           n.organization_id,
           n.email_key,
           n.parent_id,
           n.account_id,
           n.email_raw,
           coalesce(l.athlete_ids, array[]::text[]) as athlete_ids
         from normalized n
         left join links l
           on l.organization_id = n.organization_id
          and l.parent_id = n.parent_id
         where n.email_key is not null
       ),
       grouped as (
         select
           organization_id,
           email_key,
           -- DISTINCT parent_id, not count(*): the subquery below expands one row per athlete, so a
           -- single guardian record with two children would otherwise count as two records and
           -- report every healthy two-sibling family as a duplicate.
           count(distinct parent_id) as record_count,
           count(distinct parent_id) filter (where account_id is not null) as claimed_count,
           count(distinct parent_id) filter (where account_id is null) as unclaimed_count,
           min(email_raw) as email_sample,
           array_agg(distinct account_id) filter (where account_id is not null) as account_ids,
           array_agg(distinct parent_id) as parent_ids,
           coalesce(
             array_agg(distinct athlete) filter (where athlete is not null and is_claimed),
             array[]::text[]
           ) as visible_athlete_ids,
           coalesce(
             array_agg(distinct athlete) filter (where athlete is not null and not is_claimed),
             array[]::text[]
           ) as unclaimed_athlete_ids
         from (
           select
             r.organization_id,
             r.email_key,
             r.parent_id,
             r.account_id,
             r.email_raw,
             r.athlete_ids,
             (r.account_id is not null) as is_claimed,
             athlete
           from rows_with_links r
           left join unnest(r.athlete_ids) as athlete on true
         ) expanded
         group by organization_id, email_key
         having count(distinct parent_id) > 1
       )
       select
         organization_id,
         email_key,
         email_sample,
         record_count::int,
         claimed_count::int,
         unclaimed_count::int,
         coalesce(account_ids, array[]::text[]) as account_ids,
         parent_ids,
         visible_athlete_ids,
         -- Set difference, not just "links on unclaimed rows": a sibling linked to BOTH rows is
         -- still reachable, so reporting it as hidden would overstate the harm.
         array(
           select unnest(unclaimed_athlete_ids)
           except
           select unnest(visible_athlete_ids)
         ) as hidden_athlete_ids
       from grouped
       order by organization_id asc, email_key asc`,
    );

    const groups = groupsResult.rows.map((row) => ({
      organization_id: row.organization_id,
      email: maskEmail(row.email_sample),
      record_count: row.record_count,
      claimed_count: row.claimed_count,
      unclaimed_count: row.unclaimed_count,
      account_ids: row.account_ids ?? [],
      parent_ids: row.parent_ids ?? [],
      visible_athlete_ids: row.visible_athlete_ids ?? [],
      hidden_athlete_ids: row.hidden_athlete_ids ?? [],
    }));

    // Split on consequence, not on shape. A group that hides a child is a family currently being
    // shown less than they have; a group that hides none is a tidiness problem.
    const hidingChildren = groups.filter((group) => group.hidden_athlete_ids.length > 0);
    const splitOnly = groups.filter((group) => group.hidden_athlete_ids.length === 0);

    return {
      groups,
      hidingChildren,
      splitOnly,
      hiddenAthleteCount: hidingChildren.reduce((total, group) => total + group.hidden_athlete_ids.length, 0),
    };
  } finally {
    // COMMIT on a READ ONLY transaction wrote nothing by construction; it only releases the
    // snapshot. ROLLBACK would be equally correct and is used here to make that explicit.
    await client.query('ROLLBACK');
  }
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();

  try {
    const report = await checkDuplicateGuardians(client);

    if (report.groups.length === 0) {
      console.log('No guardian is split across two pilot.parents rows. Nothing to reconcile.');
      return report;
    }

    if (report.hidingChildren.length > 0) {
      console.log(
        `${report.hidingChildren.length} guardian(s) cannot see ${report.hiddenAthleteCount} of their children, `
        + 'because the links sit on a pilot.parents row their account is not attached to:',
      );
      for (const group of report.hidingChildren) {
        console.log(
          `  ${group.organization_id}  ${group.email}`
          + `\n    account_id(s):  ${group.account_ids.join(', ') || '(none claimed)'}`
          + `\n    parent_id(s):   ${group.parent_ids.join(', ')}`
          + `\n    visible:        ${group.visible_athlete_ids.join(', ') || '(none)'}`
          + `\n    HIDDEN:         ${group.hidden_athlete_ids.join(', ')}`,
        );
      }
    }

    if (report.splitOnly.length > 0) {
      console.log(
        `\n${report.splitOnly.length} guardian(s) are split across rows without currently hiding a child:`,
      );
      for (const group of report.splitOnly) {
        console.log(
          `  ${group.organization_id}  ${group.email}  parent_id(s): ${group.parent_ids.join(', ')}`,
        );
      }
    }

    console.log(
      '\nThis script changed nothing. Merging a pair means re-pointing pilot.guardian_links onto the'
      + '\nclaimed parent_id and deleting the orphan; a group with two UNCLAIMED rows means the roster'
      + '\nfile disagreed with itself and needs a human to decide which family is which.',
    );

    return report;
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { hidingChildren } = await run();
    // Non-zero ONLY when a child is currently unreachable. A guardian split across two rows that
    // hides nobody is untidy, not broken, and failing check-database for it would train people to
    // ignore this check -- which is how the finding that does matter gets missed. It still prints.
    process.exit(hidingChildren.length === 0 ? 0 : 1);
  } catch (error) {
    console.error('PILOT DUPLICATE GUARDIAN CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
