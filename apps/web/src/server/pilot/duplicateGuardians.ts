import { query } from './db';

// Duplicate-guardian detection for the admin console (register module 134).
// The same finding pilot-check-duplicate-guardians.mjs computes in CI,
// org-scoped for the console: guardians split across two pilot.parents rows
// (the #281 import-then-invite split), where the harm is the set of children
// reachable ONLY through the unclaimed row -- the ones the signed-in
// guardian cannot see.
//
// Privacy posture inherited from the script verbatim: emails are MASKED
// server-side (first character plus domain -- enough to recognize, not
// enough to republish), athletes are ids only, and remediation is
// DELIBERATELY not automated -- merging two guardian records is a human's
// call about which family is which. This module reports blast radius and
// the exact ids needed to act, nothing more.

export interface DuplicateGuardianGroup {
  email: string;
  record_count: number;
  claimed_count: number;
  unclaimed_count: number;
  account_ids: string[];
  parent_ids: string[];
  hidden_athlete_ids: string[];
}

export function maskEmail(email: string | null): string {
  if (typeof email !== 'string' || !email.includes('@')) {
    return email ?? '(none)';
  }
  const [local, ...domainParts] = email.split('@');
  const domain = domainParts.join('@');
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export async function findDuplicateGuardianGroups(organizationId: string): Promise<DuplicateGuardianGroup[]> {
  // The CI script's query, scoped to one organization. Grouped on the
  // NORMALIZED address; rows with no email are excluded rather than grouped
  // as '' -- two guardians who both lack an address are not evidence of
  // anything. hidden_athlete_ids is a set difference: a sibling linked to
  // BOTH rows is still reachable, so reporting it as hidden would overstate
  // the harm.
  const rows = await query<{
    email_sample: string;
    record_count: number;
    claimed_count: number;
    unclaimed_count: number;
    account_ids: string[] | null;
    parent_ids: string[];
    hidden_athlete_ids: string[];
  }>(
    `with normalized as (
       select
         p.parent_id,
         p.account_id,
         nullif(lower(trim(coalesce(p.email, ''))), '') as email_key,
         p.email as email_raw
       from pilot.parents p
       where p.organization_id = $1
     ),
     links as (
       select parent_id, array_agg(distinct athlete_id order by athlete_id) as athlete_ids
       from pilot.guardian_links
       where organization_id = $1
       group by parent_id
     ),
     rows_with_links as (
       select
         n.email_key, n.parent_id, n.account_id, n.email_raw,
         coalesce(l.athlete_ids, array[]::text[]) as athlete_ids
       from normalized n
       left join links l on l.parent_id = n.parent_id
       where n.email_key is not null
     ),
     grouped as (
       select
         email_key,
         count(distinct parent_id)::int as record_count,
         count(distinct parent_id) filter (where account_id is not null)::int as claimed_count,
         count(distinct parent_id) filter (where account_id is null)::int as unclaimed_count,
         min(email_raw) as email_sample,
         array_agg(distinct account_id) filter (where account_id is not null) as account_ids,
         array_agg(distinct parent_id) as parent_ids,
         coalesce(array_agg(distinct athlete) filter (where athlete is not null and is_claimed), array[]::text[]) as visible_athlete_ids,
         coalesce(array_agg(distinct athlete) filter (where athlete is not null and not is_claimed), array[]::text[]) as unclaimed_athlete_ids
       from (
         select r.email_key, r.parent_id, r.account_id, r.email_raw,
                (r.account_id is not null) as is_claimed, athlete
         from rows_with_links r
         left join unnest(r.athlete_ids) as athlete on true
       ) expanded
       group by email_key
       having count(distinct parent_id) > 1
     )
     select
       email_sample, record_count, claimed_count, unclaimed_count,
       coalesce(account_ids, array[]::text[]) as account_ids,
       parent_ids,
       array(
         select unnest(unclaimed_athlete_ids)
         except
         select unnest(visible_athlete_ids)
       ) as hidden_athlete_ids
     from grouped
     order by email_key asc`,
    [organizationId],
  );

  return rows.map((row) => ({
    email: maskEmail(row.email_sample),
    record_count: row.record_count,
    claimed_count: row.claimed_count,
    unclaimed_count: row.unclaimed_count,
    account_ids: row.account_ids ?? [],
    parent_ids: row.parent_ids,
    hidden_athlete_ids: row.hidden_athlete_ids,
  }));
}
