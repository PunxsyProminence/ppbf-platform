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

/**
 * The status vocabulary, as a runtime list rather than a bare union, so
 * normalizeWaiverStatus below can check a value against it at run time. Same
 * shape as TRACKED_WAIVER_TYPES above -- the type is derived FROM the list, so
 * a status added to one cannot go missing from the other.
 */
export const WAIVER_STATUSES = ['signed', 'declined', 'withdrawn', 'missing'] as const;
export type WaiverStatus = (typeof WAIVER_STATUSES)[number];

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
       -- A withdrawn athlete does not need a waiver, and listing them keeps a
       -- permanent red row on a worklist nobody can ever clear.
       and a.deleted_at is null
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
      /* NORMALISED, not cast. This used to be `row.status as WaiverStatus` --
         the same unchecked assertion normalizeWaiverStatus was written to
         replace, left behind in the rollup when the gate below was fixed.

         The two read the same column, so they must agree about it. They did
         not: a waiver stored as ' Signed ' passed the gate (which normalises,
         deliberately, so a family is not punished for a data-entry artifact)
         while this function handed the admin worklist the raw string, which
         page.tsx renders as 'Missing'. The same waiver was simultaneously
         valid for competition and reported absent on the worklist whose job
         is to surface absent waivers -- so staff would chase a family for a
         document already on file and working.

         pilot.waivers.status carries no CHECK constraint and
         /api/pilot/intake/domain-upsert accepts any client-supplied string
         for it, so this is reachable rather than theoretical. */
      entry.waivers[row.waiver_type] = normalizeWaiverStatus(row.status);
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

  return normalizeWaiverStatus(rows[0]?.status);
}

/**
 * Turns whatever `pilot.waivers.status` actually holds into the vocabulary
 * this module promises.
 *
 * The column is `status text not null` with NO check constraint
 * (infra/azure/pilot_slice_postgres.sql), so nothing at the database level
 * stops ' Signed ' or 'SIGNED' being stored, and other readers in this
 * codebase already normalize before comparing (wallDisplay.ts trims and
 * lowercases waiver vocabulary in two places). Casting the raw column to
 * WaiverStatus, which is what this function used to do, was a type assertion
 * with nothing behind it -- the same unchecked-`as` shape that let a
 * non-numeric readiness score reach a NOT NULL column earlier today.
 *
 * The two directions are deliberately not symmetric, because this feeds a
 * safety gate:
 *
 *   * A RECOGNISED value survives case and padding. ' Signed ' is a guardian
 *     who signed; refusing to take a child to a competition over whitespace
 *     punishes the family for a data-entry artifact.
 *   * An UNRECOGNISED value becomes 'missing', never 'signed'. 'pending',
 *     'partial', an empty string or a typo are not consent, and 'missing' is
 *     the value that makes competitionSafetyGates refuse. Unknown input
 *     fails closed.
 */
/**
 * The trim-and-lowercase half of the rule above, on its own so the consent
 * path can hold the same line without a second copy of the expression.
 *
 * Exported deliberately rather than duplicated: guardianConsent.ts reads the
 * SAME COLUMN and used to compare it raw, so ' Signed ' was a signature to
 * this module's gate and not-consent to that one. Two readings of one value
 * is the exact defect the docblock above was written about; a shared function
 * is what stops it recurring by drift.
 *
 * It deliberately does NOT map onto WAIVER_STATUSES. That mapping is this
 * module's promise about its own vocabulary; the consent path has a narrower
 * one ('signed' or not) and does not want an unrecognised value silently
 * renamed to 'missing' on the way past.
 */
export function normalizeWaiverStatusText(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

function normalizeWaiverStatus(raw: string | null | undefined): WaiverStatus {
  const value = normalizeWaiverStatusText(raw);
  return (WAIVER_STATUSES as readonly string[]).includes(value)
    ? (value as WaiverStatus)
    : 'missing';
}
