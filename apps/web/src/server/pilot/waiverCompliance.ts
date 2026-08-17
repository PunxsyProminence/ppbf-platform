import { query } from './db';

/**
 * Capability #151: an org-wide compliance rollup over pilot.waivers.
 *
 * admin/consent/page.tsx already lets an admin/coach look up ONE athlete's
 * waivers, across all types, one athlete at a time -- but nothing answers
 * "which athletes are missing a signed general/medical_release/photo_media/
 * travel waiver" across the roster. This is a pure read: pilot.waivers is
 * append-only (a new row supersedes the last one for the same athlete +
 * waiver_type), and TRACKED_WAIVER_TYPES mirrors the exact vocabulary
 * admin/consent/page.tsx's own intake form already uses -- not a new
 * taxonomy.
 *
 * pilot.waivers has no expiry column (no `expires_at`, and `consent_version`
 * is never compared against a "current" version) -- so "lifecycle tracker"
 * here means current-status visibility, not expiry tracking. Adding expiry
 * semantics is a schema decision this module does not make.
 */
export const TRACKED_WAIVER_TYPES = ['general', 'medical_release', 'photo_media', 'travel'] as const;
export type TrackedWaiverType = (typeof TRACKED_WAIVER_TYPES)[number];

export type WaiverStatus = 'signed' | 'declined' | 'withdrawn' | 'missing';

export interface AthleteWaiverStatus {
  athleteId: string;
  athleteName: string;
  activeFlag: boolean;
  waivers: Record<TrackedWaiverType, WaiverStatus>;
}

interface WaiverStatusRow {
  athlete_id: string;
  full_name: string;
  active_flag: boolean;
  waiver_type: TrackedWaiverType | null;
  status: string | null;
}

export async function getOrganizationWaiverStatus(organizationId: string): Promise<AthleteWaiverStatus[]> {
  const rows = await query<WaiverStatusRow>(
    `select
       a.athlete_id,
       a.full_name,
       a.active_flag,
       w.waiver_type,
       w.status
     from pilot.athletes a
     left join lateral (
       select distinct on (waiver_type) waiver_type, status
       from pilot.waivers
       where organization_id = a.organization_id
         and athlete_id = a.athlete_id
         and waiver_type = any($2::text[])
       order by waiver_type, created_at desc
     ) w on true
     where a.organization_id = $1
     order by a.full_name, a.athlete_id`,
    [organizationId, TRACKED_WAIVER_TYPES],
  );

  const byAthlete = new Map<string, AthleteWaiverStatus>();
  for (const row of rows) {
    let entry = byAthlete.get(row.athlete_id);
    if (!entry) {
      entry = {
        athleteId: row.athlete_id,
        athleteName: row.full_name,
        activeFlag: row.active_flag,
        waivers: Object.fromEntries(TRACKED_WAIVER_TYPES.map((type) => [type, 'missing'])) as Record<TrackedWaiverType, WaiverStatus>,
      };
      byAthlete.set(row.athlete_id, entry);
    }
    if (row.waiver_type && row.status) {
      entry.waivers[row.waiver_type] = row.status as WaiverStatus;
    }
  }

  return Array.from(byAthlete.values());
}

/**
 * One athlete, one tracked waiver type -- the narrow counterpart to the
 * org-wide rollup above.
 *
 * getOrganizationWaiverStatus answers "who on this roster is missing what",
 * which is the right shape for /admin/waiver-status and the wrong shape for a
 * gate. A gate needs one athlete's one status, and must not read (or hold in
 * memory, or risk logging) every other child's consent state to get it. So
 * this is a narrowing, not a second source of truth: same append-only reading
 * as the rollup -- pilot.waivers never updates in place, so the newest row for
 * that athlete and type is the current one -- and the same treatment of
 * absence. No row at all is 'missing', which is a status, never "fine".
 *
 * Deliberately NOT tolerant of a missing pilot.waivers relation, unlike the
 * 42P01 guards in trainingHolds.ts and access.ts. Those degrade to a
 * pre-migration behaviour that is SAFE (no hold, no coverage grant). Degrading
 * a consent lookup would mean "we could not find out whether a guardian
 * consented, so proceed", and for the document that authorises taking a minor
 * off-site that is the one direction it must never fail in. A database fault
 * here becomes a 500 and the caller's write does not happen.
 */
export async function getAthleteWaiverStatus(
  organizationId: string,
  athleteId: string,
  waiverType: TrackedWaiverType,
): Promise<WaiverStatus> {
  const rows = await query<{ status: string }>(
    `select status
     from pilot.waivers
     where organization_id = $1
       and athlete_id = $2
       and waiver_type = $3
     order by created_at desc
     limit 1`,
    [organizationId, athleteId, waiverType],
  );

  return (rows[0]?.status as WaiverStatus | undefined) ?? 'missing';
}
