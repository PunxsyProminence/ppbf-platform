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
