import { GYM_TIME_ZONE, gymDayIso } from '../../lib/gymTime';
import { query } from './db';
import { ValidationError } from './errors';
import { FAMILY_MEMBER_CODES, SKILL_FAMILY_NAMES, type SkillFamilyId } from './skillFamilies';

// ONE ATHLETE'S DRILL EXPOSURE OVER A WINDOW, TOTALLED FROM RECORDS THAT ALREADY EXIST.
//
// Map item 6 (ELITE-BOXING app map, 2026-10-04): the drill library, assignments and attempt log
// are all recorded per athlete, and nothing totalled them. This module reads; it never writes.
//
// WHAT IS COUNTED, AND FROM WHERE.
//   Drill sessions  -- pilot.assignment_completions: one completion is one session of an assigned
//                      drill. Reps are the athlete's own reps_completed where recorded. Minutes are
//                      the ASSIGNMENT's planned duration_minutes, because no completion records
//                      minutes actually done; the field is named planned_minutes so nothing
//                      downstream can mistake it for a measurement.
//   Contact level   -- assignment -> pilot.drills -> reference_drill_id -> pilot.drill_library.
//   Skill family    -- drill_library.skill_id expanded through the static crosswalk in
//                      skillFamilies.ts. Only families with a decided crosswalk are named; any other
//                      code is reported as "family not mapped yet", never guessed into one.
//   Rounds          -- pilot.v_training_attempts_effective rows with metric_kind 'rounds', by
//                      attempt context. The effective value is used, so a coach correction wins and
//                      a disputed attempt (effective value NULL) is left out of the totals and
//                      counted on its own, the same way disputed completions are.
//
// WHAT IS NOT COUNTED, ON PURPOSE.
//   Session-script runs. A run records how many athletes were present (athletes_present is a
//   count) and never which ones, so per-athlete exposure from group sessions cannot be derived
//   from existing records without guessing. The payload says so (groupSessionsCounted: false)
//   rather than leaving a silent hole. Jason's choice between leaving it out and adding a
//   per-run roster is pending in the drill-exposure lane.
//   Disputed completions. They are counted separately so the coach can see they exist.
//
// NO SCORE, NO RANKING, NO LIMIT. One athlete, raw totals. There is no comparison to any other
// athlete and no "too much" line. Whether an athlete may be read at all is decided by the route
// (assertActorCanAccessAthlete). The athlete join below repeats the deleted-athlete rule so a
// deleted athlete's records never total, but it yields zeros rather than "not found": a caller
// that skips the access check must not present that as a real empty record.

export const MAX_WINDOW_DAYS = 366;
export const DEFAULT_WINDOW_DAYS = 28;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export interface ExposureWindow {
  from: string;
  to: string;
}

export interface ExposureBucket {
  key: string;
  label: string;
  sessions: number;
  reps: number;
  sessionsWithReps: number;
  plannedMinutes: number;
  sessionsWithPlannedMinutes: number;
}

export interface RoundsByContext {
  contextType: string;
  rounds: number;
  attempts: number;
}

export interface AthleteDrillExposure {
  athleteId: string;
  window: ExposureWindow;
  drillSessions: {
    total: ExposureBucket;
    byContactLevel: ExposureBucket[];
    bySkillFamily: ExposureBucket[];
    pendingVerification: number;
    disputedExcluded: number;
  };
  rounds: {
    total: number;
    attempts: number;
    byContext: RoundsByContext[];
    disputedExcluded: number;
  };
  groupSessionsCounted: false;
}

const CONTACT_LABELS: Record<string, string> = {
  none: 'No contact',
  light_technical: 'Light technical',
  conditioned: 'Conditioned',
  controlled_sparring: 'Controlled sparring',
  open_sparring: 'Open sparring',
};
const CONTACT_ORDER = ['none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring'];

const NO_DRILL_LINK = 'not_recorded';
const FAMILY_NOT_MAPPED = 'family_not_mapped';
const NO_SKILL = 'no_skill_recorded';

const CODE_TO_FAMILY: ReadonlyMap<string, SkillFamilyId> = new Map(
  (Object.entries(FAMILY_MEMBER_CODES) as [SkillFamilyId, readonly string[]][])
    .flatMap(([family, codes]) => codes.map((code) => [code, family] as const)),
);

function parseDay(value: string, name: string): number {
  if (!DATE_PATTERN.test(value)) throw new ValidationError(`${name} must be a date written YYYY-MM-DD.`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${name} is not a real date.`);
  }
  return ms;
}

/**
 * Both ends inclusive, as gym-local calendar days. Missing ends default to the last
 * DEFAULT_WINDOW_DAYS days ending today in the gym's time zone.
 */
export function resolveExposureWindow(
  input: { from?: string | null; to?: string | null },
  now: Date = new Date(),
): ExposureWindow {
  const to = input.to?.trim() || gymDayIso(now);
  if (!to) throw new ValidationError('Could not work out today’s date.');
  const toMs = parseDay(to, 'to');
  const from = input.from?.trim()
    || new Date(toMs - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const fromMs = parseDay(from, 'from');
  if (fromMs > toMs) throw new ValidationError('from must be on or before to.');
  if ((toMs - fromMs) / DAY_MS + 1 > MAX_WINDOW_DAYS) {
    throw new ValidationError(`The window can be at most ${MAX_WINDOW_DAYS} days.`);
  }
  return { from, to };
}

interface CompletionGroupRow {
  verification_status: string;
  contact_level: string | null;
  skill_id: string | null;
  sessions: string;
  reps: string | null;
  sessions_with_reps: string;
  planned_minutes: string | null;
  sessions_with_planned_minutes: string;
}

interface RoundsRow {
  context_type: string;
  rounds: string | null;
  attempts: string;
  disputed: string;
}

function emptyBucket(key: string, label: string): ExposureBucket {
  return { key, label, sessions: 0, reps: 0, sessionsWithReps: 0, plannedMinutes: 0, sessionsWithPlannedMinutes: 0 };
}

function addInto(bucket: ExposureBucket, row: CompletionGroupRow): void {
  bucket.sessions += Number(row.sessions);
  bucket.reps += Number(row.reps ?? 0);
  bucket.sessionsWithReps += Number(row.sessions_with_reps);
  bucket.plannedMinutes += Number(row.planned_minutes ?? 0);
  bucket.sessionsWithPlannedMinutes += Number(row.sessions_with_planned_minutes);
}

function contactKey(row: CompletionGroupRow): { key: string; label: string } {
  if (!row.contact_level) return { key: NO_DRILL_LINK, label: 'Contact level not recorded' };
  return { key: row.contact_level, label: CONTACT_LABELS[row.contact_level] ?? row.contact_level };
}

function familyKey(row: CompletionGroupRow): { key: string; label: string } {
  // contact_level is NOT NULL on drill_library, so NULL here means no library row was reached (a
  // hand-authored drill or a legacy assignment). That is a different gap from a library drill
  // with no skill code, and the two are kept apart.
  if (!row.contact_level) return { key: NO_DRILL_LINK, label: 'Drill not linked to the library' };
  if (!row.skill_id) return { key: NO_SKILL, label: 'No skill recorded' };
  const family = CODE_TO_FAMILY.get(row.skill_id);
  if (!family) return { key: FAMILY_NOT_MAPPED, label: 'Skill family not mapped yet' };
  return { key: family, label: `${family} ${SKILL_FAMILY_NAMES[family]}` };
}

function rankKey(key: string): number {
  const contact = CONTACT_ORDER.indexOf(key);
  if (contact >= 0) return contact;
  if (key.startsWith('SKILL-')) return Number(key.slice(6));
  return 1000;
}

export async function getAthleteDrillExposure(input: {
  organizationId: string;
  athleteId: string;
  window: ExposureWindow;
}): Promise<AthleteDrillExposure> {
  const { organizationId, athleteId, window } = input;
  const params = [organizationId, athleteId, window.from, window.to, GYM_TIME_ZONE];

  // Grouped in SQL, folded to families in TypeScript: the crosswalk is version-controlled code,
  // not a table, so the database cannot do that last step.
  const completionRows = await query<CompletionGroupRow>(
    `select c.verification_status,
            dl.contact_level,
            dl.skill_id,
            count(*)                                   as sessions,
            sum(c.reps_completed)                      as reps,
            count(c.reps_completed)                    as sessions_with_reps,
            sum(a.duration_minutes)                    as planned_minutes,
            count(a.duration_minutes)                  as sessions_with_planned_minutes
       from pilot.assignment_completions c
       join pilot.drill_assignments a
         on a.assignment_id = c.assignment_id
        and a.organization_id = c.organization_id
        and a.athlete_id = c.athlete_id
       join pilot.athletes ath
         on ath.organization_id = c.organization_id
        and ath.athlete_id = c.athlete_id
        and ath.deleted_at is null
       left join pilot.drills d
         on d.organization_id = a.organization_id and d.drill_id = a.drill_id
       left join pilot.drill_library dl
         on dl.organization_id = d.organization_id and dl.drill_id = d.reference_drill_id
      where c.organization_id = $1
        and c.athlete_id = $2
        and (c.completed_at at time zone $5)::date between $3::date and $4::date
      group by c.verification_status, dl.contact_level, dl.skill_id`,
    params,
  );

  const roundsRows = await query<RoundsRow>(
    `select v.context_type,
            sum(v.effective_achieved_value::numeric)                   as rounds,
            count(v.effective_achieved_value)                          as attempts,
            count(*) filter (where v.effective_achieved_value is null) as disputed
       from pilot.v_training_attempts_effective v
       join pilot.athletes ath
         on ath.organization_id = v.organization_id
        and ath.athlete_id = v.athlete_id
        and ath.deleted_at is null
      where v.organization_id = $1
        and v.athlete_id = $2
        and v.metric_kind = 'rounds'
        and (v.attempted_at at time zone $5)::date between $3::date and $4::date
      group by v.context_type
      order by v.context_type`,
    params,
  );

  const total = emptyBucket('total', 'All drill sessions');
  const byContact = new Map<string, ExposureBucket>();
  const byFamily = new Map<string, ExposureBucket>();
  let pendingVerification = 0;
  let disputedExcluded = 0;

  for (const row of completionRows) {
    if (row.verification_status === 'disputed') {
      disputedExcluded += Number(row.sessions);
      continue;
    }
    if (row.verification_status === 'pending') pendingVerification += Number(row.sessions);
    addInto(total, row);
    const contact = contactKey(row);
    if (!byContact.has(contact.key)) byContact.set(contact.key, emptyBucket(contact.key, contact.label));
    addInto(byContact.get(contact.key)!, row);
    const family = familyKey(row);
    if (!byFamily.has(family.key)) byFamily.set(family.key, emptyBucket(family.key, family.label));
    addInto(byFamily.get(family.key)!, row);
  }

  const sorted = (buckets: Map<string, ExposureBucket>) =>
    [...buckets.values()].sort((left, right) => rankKey(left.key) - rankKey(right.key)
      || left.key.localeCompare(right.key));

  const byContext = roundsRows
    .filter((row) => Number(row.attempts) > 0)
    .map((row) => ({
      contextType: row.context_type,
      rounds: Number(row.rounds ?? 0),
      attempts: Number(row.attempts),
    }));

  return {
    athleteId,
    window,
    drillSessions: {
      total,
      byContactLevel: sorted(byContact),
      bySkillFamily: sorted(byFamily),
      pendingVerification,
      disputedExcluded,
    },
    rounds: {
      total: byContext.reduce((sum, row) => sum + row.rounds, 0),
      attempts: byContext.reduce((sum, row) => sum + row.attempts, 0),
      byContext,
      disputedExcluded: roundsRows.reduce((sum, row) => sum + Number(row.disputed), 0),
    },
    groupSessionsCounted: false,
  };
}
