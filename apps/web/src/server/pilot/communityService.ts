import { listActivityLog, type ActivityLogRow } from './activityLog';

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

/** Community-service totals per person over the window, verified and
 * unverified kept apart. Sorted by most service first; entries newest
 * first within each person. */
export async function getCommunityServiceTotals(
  organizationId: string,
  filter: { personAccountId?: string; since?: string; until?: string } = {},
): Promise<ServiceTotals[]> {
  const rows = await listActivityLog(organizationId, {
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

  return [...byPerson.values()].sort(
    (a, b) => (b.verified_minutes + b.unverified_minutes) - (a.verified_minutes + a.unverified_minutes),
  );
}

/** Whole hours, floored, for display. Deliberately not rounded up: an
 * external reader of a service figure should never be handed minutes the
 * record cannot back. */
export function wholeHours(minutes: number): number {
  return Math.floor(minutes / 60);
}
