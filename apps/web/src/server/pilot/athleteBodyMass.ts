import { assertActorCanAccessAthlete, type ActorIdentity } from './access';
import { type PilotAuditEvent, writePilotAuditEvent } from './audit';
import { queryOne, query } from './db';
import { ForbiddenError, NotFoundError, PilotError } from './errors';
import { calculateSevenDayWeightChange } from './formulas/engine';
import { deterministicKey } from './formulas/identity';
import { FormulaRepositoryError, saveFormulaObservation } from './formulas/repository';
import type { NumericObservation } from './formulas/types';
import { isMinor } from './wallDisplay';

// Body mass at the athlete check-in, and the seven-day fast-change flag
// (elite-boxing map item 5).
//
// ONE OBSERVATION, ONE FORMULA. Before this, weight entered only through the
// athlete sparring form as a `body_weight` formula observation, which is what
// MVP-12 (Seven-Day Weight Change, formulas/engine.ts) reads. A check-in weight
// is stored as that same observation kind, in kilograms like the sparring form
// stores it, so both entry points feed one history and one formula.
//
// WHO SEES IT (Jason 2026-10-04, answers "B everyone, youth limited" and "Yes,
// keep org admin"): every athlete may enter it. An adult's weight follows the
// rest of their check-in. A youth's weight -- and a missing date of birth is
// treated as youth -- reaches only the people assertActorCanAccessAthlete
// already admits for a child's private record: the athlete, their assigned or
// covering coach, a linked parent, and the organization admin. Any other coach
// in the gym reads the youth's check-in without it.
//
// THE FLAG (Jason 2026-10-04: ">5% in 7 days", then "B: any >5% within 7
// days"): raised when, up or down, by more than 5% of the earlier weight,
// either (1) the latest weigh-in differs from the one closest to seven days
// earlier (within a day either side -- MVP-12), or (2) any two weigh-ins in
// the seven days up to the latest one differ. The sentence names the larger.
// It is a prompt for the coach to talk to the athlete; nothing acts on it.

export const BODY_MASS_FLAG_PERCENT = 5;
export const BODY_MASS_WINDOW_DAYS = 7;
export const BODY_MASS_TOLERANCE_HOURS = 24;
export const BODY_MASS_POLICY_VERSION = 'check-in-body-mass-2026-10-04';
// Bounds on what a check-in will accept, in kilograms: roughly 44-550 lb.
// They refuse typing slips, not people.
export const BODY_MASS_KG_MIN = 20;
export const BODY_MASS_KG_MAX = 250;

export const BODY_MASS_UNITS = ['kg', 'lb'] as const;
export type BodyMassUnit = (typeof BODY_MASS_UNITS)[number];

const KG_PER_LB = 0.45359237;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
// How far back the read looks. A week plus the tolerance is all the flag
// needs; the rest lets "latest" show a weigh-in from earlier in the month.
const LOOKBACK_DAYS = 30;

export function toKilograms(value: number, unit: BodyMassUnit): number {
  const kilograms = unit === 'lb' ? value * KG_PER_LB : value;
  return Math.round(kilograms * 100) / 100;
}

export function toPounds(kilograms: number): number {
  return Math.round((kilograms / KG_PER_LB) * 10) / 10;
}

/** Returns why a body-mass entry is refused, or null. Leaving it out is legal. */
export function bodyMassInputError(value: unknown, unit: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof unit !== 'string' || !(BODY_MASS_UNITS as readonly string[]).includes(unit)) {
    return 'body_mass_unit must be "kg" or "lb".';
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'body_mass must be a number, or omitted.';
  }
  const kilograms = toKilograms(value, unit as BodyMassUnit);
  if (kilograms < BODY_MASS_KG_MIN || kilograms > BODY_MASS_KG_MAX) {
    return unit === 'lb'
      ? `body_mass must be from ${toPounds(BODY_MASS_KG_MIN)} to ${toPounds(BODY_MASS_KG_MAX)} lb, or omitted.`
      : `body_mass must be from ${BODY_MASS_KG_MIN} to ${BODY_MASS_KG_MAX} kg, or omitted.`;
  }
  return null;
}

/** Stores a check-in weight as the athlete's body_weight observation. Keyed by
 *  the check-in, so a retry of the same check-in cannot add a second weigh-in. */
export async function recordCheckInBodyMass(input: {
  organizationId: string;
  athleteId: string;
  checkInId: string;
  kilograms: number;
  observedAt: string;
  accountId: string;
}): Promise<void> {
  const idempotencyKey = `check-in:${input.checkInId}:body_weight`;
  await saveFormulaObservation({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    contextId: `check-in:${input.checkInId}`,
    kind: 'body_weight',
    value: input.kilograms,
    unit: 'kilograms',
    observedAt: input.observedAt,
    source: {
      type: 'manual',
      quality: 'moderate',
      referenceId: deterministicKey('check-in-body-mass', {
        organizationId: input.organizationId,
        accountId: input.accountId,
        idempotencyKey,
      }),
      qualityNotes: 'Athlete self-reported at check-in; not a gym scale reading.',
    },
    idempotencyKey,
    createdByAccountId: input.accountId,
  });
}

export interface BodyMassChange {
  percent: number;
  kilograms: number;
  prior_kilograms: number;
  prior_observed_at: string;
  later_kilograms: number;
  later_observed_at: string;
  days: number;
}

export interface BodyMassEntry {
  observation_id: string;
  kilograms: number;
  pounds: number;
  observed_at: string;
}

export interface BodyMassSummary {
  latest: BodyMassEntry | null;
  /** Current entries inside the correction window, newest first. Includes an
   *  out-of-range slip (700 for 70.0) the flag leaves out, since that is the
   *  entry most likely to need correcting. */
  correctable_entries: BodyMassEntry[];
  /** MVP-12: the latest weigh-in against the one closest to 7 days earlier. */
  change: BodyMassChange | null;
  /** The largest change between any two weigh-ins in the 7 days up to the
   *  latest one (Jason 2026-10-04, "B: any >5% within 7 days"). */
  largest_change_in_window: BodyMassChange | null;
  flagged: boolean;
  flag_text: string | null;
  threshold_percent: number;
  window_days: number;
}

interface BodyWeightRow {
  observation_id: string;
  numeric_value: string | number | null;
  unit: string;
  observed_at: string | Date;
}

function weighIn(
  row: BodyWeightRow,
  organizationId: string,
  athleteId: string,
): NumericObservation<'body_weight', 'kilograms'> | null {
  const raw = row.numeric_value == null ? null : Number(row.numeric_value);
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  if (row.unit !== 'kilograms' && row.unit !== 'pounds') return null;
  // The sparring form and the observations route accept any finite weight. A
  // slip there (700 for 70.0) would otherwise raise a +900% flag, so a
  // weigh-in outside what the check-in itself accepts is left out of the
  // comparison rather than shown.
  const kilograms = row.unit === 'pounds' ? toKilograms(raw, 'lb') : raw;
  if (kilograms < BODY_MASS_KG_MIN || kilograms > BODY_MASS_KG_MAX) return null;
  return {
    observationId: row.observation_id,
    organizationId,
    athleteId,
    contextId: row.observation_id,
    kind: 'body_weight',
    value: kilograms,
    unit: 'kilograms',
    observedAt: new Date(row.observed_at).toISOString(),
    source: { type: 'manual', quality: 'moderate', referenceId: row.observation_id },
  };
}

function spanText(milliseconds: number): string {
  const days = Math.round(milliseconds / DAY_MS);
  if (days < 1) return 'within a day';
  return days === 1 ? 'in 1 day' : `in ${days} days`;
}

/** The sentence Jason approved 2026-10-04 ("As-is, no disclaimer"). */
export function flagText(change: BodyMassChange): string {
  const direction = change.percent < 0 ? 'down' : 'up';
  const percent = Math.abs(change.percent).toFixed(1);
  const span = Date.parse(change.later_observed_at) - Date.parse(change.prior_observed_at);
  return `Weight ${direction} ${percent}% ${spanText(span)} `
    + `(${toPounds(change.prior_kilograms)} lb → ${toPounds(change.later_kilograms)} lb). Check in with the athlete.`;
}

type WeighIn = NumericObservation<'body_weight', 'kilograms'>;

function describeChange(prior: WeighIn, later: WeighIn, difference: number): { change: BodyMassChange; ratio: number } {
  // The 5% test uses the unrounded ratio; only the shown percent is rounded,
  // so 5.04% is flagged even though it reads "5.0%".
  const ratio = difference / prior.value!;
  return {
    ratio,
    change: {
      percent: Math.round(ratio * 1000) / 10,
      kilograms: Math.round(difference * 100) / 100,
      prior_kilograms: prior.value!,
      prior_observed_at: prior.observedAt,
      later_kilograms: later.value!,
      later_observed_at: later.observedAt,
      days: Math.round((Date.parse(later.observedAt) - Date.parse(prior.observedAt)) / DAY_MS),
    },
  };
}

/** The athlete's latest weigh-in and the seven-day change, from every
 *  body_weight observation (check-in and sparring form alike). */
export async function summarizeBodyMass(
  organizationId: string,
  athleteId: string,
  now: Date = new Date(),
): Promise<BodyMassSummary> {
  const rows = await query<BodyWeightRow>(
    `select o.observation_id, o.numeric_value, o.unit, o.observed_at
     from pilot.shadow_formula_observations o
     where o.organization_id = $1
       and o.athlete_id = $2
       and o.observation_kind = 'body_weight'
       and o.observed_at > $3::timestamptz
       and o.observed_at <= $4::timestamptz
       and not exists (
         select 1
         from pilot.shadow_formula_observations successor
         where successor.organization_id = o.organization_id
           and successor.supersedes_observation_id = o.observation_id
           and successor.observation_kind = 'body_weight'
       )
     order by o.observed_at asc, o.observation_id asc`,
    [
      organizationId,
      athleteId,
      new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString(),
      now.toISOString(),
    ],
  );
  const weighIns = rows
    .map((row) => weighIn(row, organizationId, athleteId))
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const correctable = rows
    .map((row) => {
      const raw = row.numeric_value == null ? null : Number(row.numeric_value);
      if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
      if (row.unit !== 'kilograms' && row.unit !== 'pounds') return null;
      const observedAt = new Date(row.observed_at).toISOString();
      if (!bodyMassCorrectable(observedAt, now)) return null;
      const kilograms = row.unit === 'pounds' ? toKilograms(raw, 'lb') : raw;
      return { observation_id: row.observation_id, kilograms, pounds: toPounds(kilograms), observed_at: observedAt };
    })
    .filter((entry): entry is BodyMassEntry => entry !== null)
    .reverse();

  const empty: BodyMassSummary = {
    latest: null,
    correctable_entries: correctable,
    change: null,
    largest_change_in_window: null,
    flagged: false,
    flag_text: null,
    threshold_percent: BODY_MASS_FLAG_PERCENT,
    window_days: BODY_MASS_WINDOW_DAYS,
  };
  const current = weighIns[weighIns.length - 1];
  if (!current) return empty;

  const latest = {
    observation_id: current.observationId,
    kilograms: current.value!,
    pounds: toPounds(current.value!),
    observed_at: current.observedAt,
  };
  const currentMs = Date.parse(current.observedAt);

  // 1. MVP-12, unchanged: the latest weigh-in against the one closest to seven
  //    days earlier, within a day either side.
  let sevenDay: ReturnType<typeof describeChange> | null = null;
  const target = currentMs - BODY_MASS_WINDOW_DAYS * DAY_MS;
  let prior: WeighIn | undefined;
  for (const candidate of weighIns) {
    const distance = Math.abs(Date.parse(candidate.observedAt) - target);
    if (distance > BODY_MASS_TOLERANCE_HOURS * HOUR_MS) continue;
    if (!prior || distance < Math.abs(Date.parse(prior.observedAt) - target)) prior = candidate;
  }
  if (prior) {
    const result = calculateSevenDayWeightChange({
      current,
      prior,
      policy: { targetDays: 7, toleranceHours: BODY_MASS_TOLERANCE_HOURS },
      policyVersion: BODY_MASS_POLICY_VERSION,
      computedAt: now.toISOString(),
    });
    if (result.value != null) sevenDay = describeChange(prior, current, result.value);
  }

  // 2. Jason's option B: the largest change between any two weigh-ins in the
  //    seven days up to the latest one, so a cut between irregular check-ins
  //    (Monday to Friday, with nothing the week before) is not missed.
  let largest: ReturnType<typeof describeChange> | null = null;
  const windowed = weighIns.filter((row) => Date.parse(row.observedAt) >= target);
  for (let a = 0; a < windowed.length; a += 1) {
    for (let b = a + 1; b < windowed.length; b += 1) {
      const candidate = describeChange(windowed[a], windowed[b], windowed[b].value! - windowed[a].value!);
      if (!largest || Math.abs(candidate.ratio) > Math.abs(largest.ratio)) largest = candidate;
    }
  }

  const over = [sevenDay, largest]
    .filter((item): item is NonNullable<typeof item> => item !== null
      && Math.abs(item.ratio) * 100 > BODY_MASS_FLAG_PERCENT)
    .sort((x, y) => Math.abs(y.ratio) - Math.abs(x.ratio));
  return {
    ...empty,
    latest,
    change: sevenDay?.change ?? null,
    largest_change_in_window: largest?.change ?? null,
    flagged: over.length > 0,
    flag_text: over.length > 0 ? flagText(over[0].change) : null,
  };
}

/** Is this athlete a youth (or without a recorded date of birth)? Null when
 *  the athlete is not a live row in the organization. */
export async function athleteIsYouth(
  organizationId: string,
  athleteId: string,
  now: Date = new Date(),
): Promise<boolean | null> {
  const row = await queryOne<{ dob: string | null }>(
    `select to_char(dob, 'YYYY-MM-DD') as dob
     from pilot.athletes
     where organization_id = $1 and athlete_id = $2 and deleted_at is null`,
    [organizationId, athleteId],
  );
  return row ? isMinor(row.dob, now) : null;
}

/**
 * May this viewer see this athlete's body mass?
 *
 * The caller has ALREADY decided the viewer may read the athlete's check-in
 * (for staff: same organization). For an adult that is enough. For a youth --
 * or an athlete whose date of birth is not recorded -- the viewer must also
 * pass assertActorCanAccessAthlete, which admits only the assigned or covering
 * coach, a linked parent, the organization admin and the athlete. A refusal by
 * that gate answers no; a database error reading the athlete row ends the
 * request with an error. Neither returns a weight.
 */
export async function bodyMassVisibleTo(
  viewer: ActorIdentity,
  organizationId: string,
  athleteId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const youth = await athleteIsYouth(organizationId, athleteId, now);
  if (youth === null) return false;
  if (!youth) return true;
  try {
    await assertActorCanAccessAthlete(viewer, athleteId);
    return true;
  } catch {
    return false;
  }
}

// CORRECTING A MISTYPED WEIGHT (Jason 2026-10-04, "Athlete or their coach").
//
// A correction never edits or deletes the entry it fixes. It writes a new
// body_weight observation that supersedes the old one (the formula store's own
// supersedes_observation_id, one successor per entry), at the old entry's
// observed_at so the history keeps its order. summarizeBodyMass reads only
// entries nothing supersedes, so the flag is computed from corrected values;
// the original stays in the table, on record and out of the flag.
//
// WHO: the athlete, for their own record, or a coach assigned to or covering
// that athlete -- the two arms of assertActorCanAccessAthlete Jason named.
// Everyone else is refused, including a coach who only shares the gym, a
// parent, the organization admin and the platform owner.
//
// WHEN: an entry observed in the last BODY_MASS_CORRECTION_DAYS days -- the
// recommended 7, plus the day of tolerance MVP-12 allows when it picks the
// weigh-in "7 days earlier" (BODY_MASS_TOLERANCE_HOURS). Without that day an
// 8-day-old entry could raise the flag and not be correctable. The window is
// counted from the original entry's time, so correcting a correction does not
// extend it.
//
// LEFT OUT FROM BOTH SIDES: the generic observations route refuses to supersede
// a body_weight entry, and summarizeBodyMass counts only a body_weight
// successor as replacing one, so no other path can make a weight disappear.

export const BODY_MASS_CORRECTION_DAYS = BODY_MASS_WINDOW_DAYS + BODY_MASS_TOLERANCE_HOURS / 24;

/** Is an entry observed at this time still inside the correction window? */
export function bodyMassCorrectable(observedAt: string, now: Date = new Date()): boolean {
  const observedMs = Date.parse(observedAt);
  return Number.isFinite(observedMs)
    && observedMs >= now.getTime() - BODY_MASS_CORRECTION_DAYS * DAY_MS;
}

/** May this actor correct this athlete's body mass? A refusal by the access
 *  gate (or a failure reaching it) answers no. */
export async function canCorrectBodyMass(actor: ActorIdentity, athleteId: string): Promise<boolean> {
  if (actor.role !== 'athlete' && actor.role !== 'coach') return false;
  try {
    await assertActorCanAccessAthlete(actor, athleteId);
    return true;
  } catch {
    return false;
  }
}

/** Replaces one current body_weight entry with a corrected value. The caller
 *  has validated the new value with bodyMassInputError. */
export async function correctBodyMass(
  actor: ActorIdentity,
  input: { athleteId: string; observationId: string; kilograms: number },
  now: Date = new Date(),
): Promise<{ observation_id: string; supersedes_observation_id: string }> {
  if (!(await canCorrectBodyMass(actor, input.athleteId))) {
    throw new ForbiddenError('Only the athlete or their own coach can correct a body mass entry.');
  }
  const organizationId = actor.organizationId;
  const original = await queryOne<{ context_id: string; observed_at: string | Date }>(
    `select o.context_id, o.observed_at
     from pilot.shadow_formula_observations o
     where o.organization_id = $1
       and o.athlete_id = $2
       and o.observation_id = $3
       and o.observation_kind = 'body_weight'`,
    [organizationId, input.athleteId, input.observationId],
  );
  if (!original) throw new NotFoundError('That body mass entry was not found.');
  const observedAt = new Date(original.observed_at).toISOString();
  if (!bodyMassCorrectable(observedAt, now)) {
    throw new PilotError(
      409,
      `Only body mass entries from the last ${BODY_MASS_CORRECTION_DAYS} days can be corrected.`,
      'BODY_MASS_CORRECTION_WINDOW',
    );
  }

  const idempotencyKey = `body-mass-correction:${input.observationId}`;
  let saved;
  try {
    saved = await saveFormulaObservation({
      organizationId,
      athleteId: input.athleteId,
      contextId: original.context_id,
      kind: 'body_weight',
      value: input.kilograms,
      unit: 'kilograms',
      observedAt,
      source: {
        type: 'manual',
        quality: 'moderate',
        referenceId: deterministicKey('body-mass-correction', {
          organizationId,
          observationId: input.observationId,
        }),
        qualityNotes: actor.role === 'athlete'
          ? 'Corrected by the athlete.'
          : 'Corrected by the athlete’s coach.',
      },
      idempotencyKey,
      supersedesObservationId: input.observationId,
      createdByAccountId: actor.accountId,
    });
  } catch (error) {
    if (
      error instanceof FormulaRepositoryError
      && (error.code === 'SUPERSEDED_OBSERVATION' || error.code === 'IDEMPOTENCY_CONFLICT')
    ) {
      throw new PilotError(
        409,
        'That entry was already corrected. Reload and correct the newer entry.',
        'BODY_MASS_ALREADY_CORRECTED',
      );
    }
    throw error;
  }

  await writePilotAuditEvent(bodyMassCorrectionAuditEvent({
    actor,
    organizationId,
    athleteId: input.athleteId,
    observationId: saved.observationId,
    supersedesObservationId: input.observationId,
  }));
  return { observation_id: saved.observationId, supersedes_observation_id: input.observationId };
}

/**
 * The audit row a body-mass correction writes. Exported so the SHADOW feed
 * suite (shadowEventAthleteScope.pg.test.ts) can prove that THIS event, not a
 * hand-written likeness of it, reaches pilot.audit_events and nothing else.
 *
 * The weights themselves stay out of the audit row; the observations hold
 * them.
 *
 * shadow_mirror: false -- writePilotAuditEvent otherwise mirrors the row into
 * pilot.shadow_events, and listShadowEvents ties that mirror to the athlete
 * through details.athlete_id, so the athlete and their guardians would read
 * "body mass corrected, <time>" in /api/pilot/shadow/events. A child's weight
 * record is health data (OD-2026-10-04-029: the athlete or their coach), and
 * whether the family feed carries it is not decided; athleteMinorLimits.ts
 * holds the same line for a child's limits. The audit table keeps the record.
 */
export function bodyMassCorrectionAuditEvent(input: {
  actor: Pick<ActorIdentity, 'accountId' | 'role'>;
  organizationId: string;
  athleteId: string;
  observationId: string;
  supersedesObservationId: string;
}): PilotAuditEvent {
  return {
    event_type: 'update',
    actor_account_id: input.actor.accountId,
    actor_role: input.actor.role,
    organization_id: input.organizationId,
    entity_type: 'athlete_body_mass',
    entity_id: input.observationId,
    details: { athlete_id: input.athleteId, supersedes_observation_id: input.supersedesObservationId },
    shadow_mirror: false,
  };
}
