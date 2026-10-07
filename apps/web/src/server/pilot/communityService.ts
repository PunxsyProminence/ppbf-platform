import { accessibleAthleteIds, isOrganizationAdminRole, type ActorIdentity } from './access';
import { listActivityLog, type ActivityLogRow } from './activityLog';
import { query } from './db';

// Community service tracker (register module 128): a read over the
// community_service rows already in pilot.activity_log. No new table, no
// new write path -- service hours are recorded through the activity log
// like every other domain, and this module only reads them back grouped
// by person.
//
// VERIFICATION IS NOT SMOOTHED. community_service is a verifier-required
// domain: an unverified entry is real work that nobody has confirmed yet,
// and it is counted SEPARATELY from verified hours forever. Any external
// use of these numbers (a school, a court, a scholarship) needs the
// verified figure, so the two must never be added together silently.
//
// WHO SEES WHOSE HOURS. The rows are keyed by person_account_id, and a
// person's service record is theirs: an organization admin reads the whole
// gym, everyone else reads only the people whose athlete record they could
// have asked for one at a time (OD-2026-10-05-024 item 2: the coach of
// record, a live covering coach). The decision is access.ts's
// accessibleAthleteIds, not a rule of this module. A person with no
// athlete record at all (an adult volunteer) belongs to nobody's reach, so
// only the organization admin sees them.

export interface ServiceEntry {
  activity_id: string;
  person_account_id: string;
  activity_type: string;
  occurred_on: string;
  duration_minutes: number;
  what_was_worked_on: string;
  verified: boolean;
  verified_at: string | null;
  notes: string;
}

export interface ServiceTotals {
  person_account_id: string;
  verified_minutes: number;
  unverified_minutes: number;
  entry_count: number;
  entries: ServiceEntry[];
}

function toEntry(row: ActivityLogRow): ServiceEntry {
  return {
    activity_id: row.activity_id,
    person_account_id: row.person_account_id,
    activity_type: row.activity_type,
    occurred_on: row.occurred_on,
    duration_minutes: row.duration_minutes,
    what_was_worked_on: row.what_was_worked_on,
    verified: row.verified_by_account_id !== null,
    verified_at: row.verified_at,
    notes: row.notes,
  };
}

/**
 * The athlete record(s) each person's service rows are about. A row names
 * its athlete directly (activity_log.athlete_id, null for a non-athlete),
 * and the person's login names one too (accounts.athlete_id); both are
 * read because neither is guaranteed set on every row, and the reach check
 * must see every athlete a person's rows could be about. Ids only -- no
 * name or other athlete field is loaded before the caller is authorized.
 */
async function athleteIdsByPerson(
  organizationId: string,
  rows: readonly ActivityLogRow[],
): Promise<Map<string, Set<string>>> {
  const byPerson = new Map<string, Set<string>>();
  for (const row of rows) {
    let ids = byPerson.get(row.person_account_id);
    if (!ids) {
      ids = new Set();
      byPerson.set(row.person_account_id, ids);
    }
    if (row.athlete_id) ids.add(row.athlete_id);
  }
  if (byPerson.size === 0) return byPerson;

  const accounts = await query<{ account_id: string; athlete_id: string }>(
    `select account_id, athlete_id from pilot.accounts
     where organization_id = $1 and account_id = any($2::text[]) and athlete_id is not null`,
    [organizationId, [...byPerson.keys()]],
  );
  for (const account of accounts) {
    byPerson.get(account.account_id)?.add(account.athlete_id);
  }
  return byPerson;
}

/** Community-service totals per person over the window, verified and
 * unverified kept apart, limited to the people the actor may see. Sorted
 * by most service first; entries newest first within each person. */
export async function getCommunityServiceTotals(
  actor: ActorIdentity,
  filter: { personAccountId?: string; since?: string; until?: string } = {},
): Promise<ServiceTotals[]> {
  const rows = await listActivityLog(actor.organizationId, {
    activityDomain: 'community_service',
    personAccountId: filter.personAccountId,
    since: filter.since,
    until: filter.until,
  });

  const byPerson = new Map<string, ServiceTotals>();
  for (const row of rows) {
    const entry = toEntry(row);
    let totals = byPerson.get(row.person_account_id);
    if (!totals) {
      totals = {
        person_account_id: row.person_account_id,
        verified_minutes: 0,
        unverified_minutes: 0,
        entry_count: 0,
        entries: [],
      };
      byPerson.set(row.person_account_id, totals);
    }
    // Verified and unverified never merge into one number.
    if (entry.verified) totals.verified_minutes += row.duration_minutes;
    else totals.unverified_minutes += row.duration_minutes;
    totals.entry_count += 1;
    totals.entries.push(entry);
  }

  let people = [...byPerson.values()];
  if (people.length > 0 && !isOrganizationAdminRole(actor.role)) {
    // Same filter as the other per-person lists (athleteDevelopmentBlocks,
    // coachCards): the union of what the actor could have asked for one
    // athlete at a time, never a gym-wide read wearing a filter. A person
    // is shown only when EVERY athlete their rows are about is reachable;
    // a person whose rows name no athlete is shown to nobody here.
    const subjects = await athleteIdsByPerson(actor.organizationId, rows);
    const reachable = await accessibleAthleteIds(
      actor,
      [...subjects.values()].flatMap((ids) => [...ids]),
    );
    people = people.filter((person) => {
      const ids = subjects.get(person.person_account_id);
      return ids !== undefined && ids.size > 0 && [...ids].every((id) => reachable.has(id));
    });
  }

  return people.sort(
    (a, b) => (b.verified_minutes + b.unverified_minutes) - (a.verified_minutes + a.unverified_minutes),
  );
}

/** Whole hours, floored, for display. Deliberately not rounded up: an
 * external reader of a service figure should never be handed minutes the
 * record cannot back. */
export function wholeHours(minutes: number): number {
  return Math.floor(minutes / 60);
}
