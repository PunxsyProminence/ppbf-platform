import { assertActorCanAccessAthlete, type ActorIdentity } from './access';
import { queryOne, query } from './db';
import { calculateSevenDayWeightChange } from './formulas/engine';
import { deterministicKey } from './formulas/identity';
import { saveFormulaObservation } from './formulas/repository';
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
// THE FLAG (Jason 2026-10-04: ">5% in 7 days"): the latest weigh-in against
// the one closest to seven days earlier, within a day either side. More than
// 5% of the earlier weight, up or down, raises it. It is a prompt for the
// coach to talk to the athlete; nothing acts on it.

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

export interface BodyMassSummary {
  latest: { kilograms: number; pounds: number; observed_at: string } | null;
  change: {
    percent: number;
    kilograms: number;
    prior_kilograms: number;
    prior_observed_at: string;
    days: number;
  } | null;
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

export function flagText(change: NonNullable<BodyMassSummary['change']>, latestKg: number): string {
  const direction = change.percent < 0 ? 'down' : 'up';
  const percent = Math.abs(change.percent).toFixed(1);
  return `Weight ${direction} ${percent}% in ${change.days} days `
    + `(${toPounds(change.prior_kilograms)} lb → ${toPounds(latestKg)} lb). Check in with the athlete.`;
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

  const empty: BodyMassSummary = {
    latest: null,
    change: null,
    flagged: false,
    flag_text: null,
    threshold_percent: BODY_MASS_FLAG_PERCENT,
    window_days: BODY_MASS_WINDOW_DAYS,
  };
  const current = weighIns[weighIns.length - 1];
  if (!current) return empty;

  const latest = {
    kilograms: current.value!,
    pounds: toPounds(current.value!),
    observed_at: current.observedAt,
  };
  const target = Date.parse(current.observedAt) - BODY_MASS_WINDOW_DAYS * DAY_MS;
  let prior: (typeof weighIns)[number] | undefined;
  for (const candidate of weighIns) {
    const distance = Math.abs(Date.parse(candidate.observedAt) - target);
    if (distance > BODY_MASS_TOLERANCE_HOURS * HOUR_MS) continue;
    if (!prior || distance < Math.abs(Date.parse(prior.observedAt) - target)) prior = candidate;
  }
  if (!prior) return { ...empty, latest };

  const result = calculateSevenDayWeightChange({
    current,
    prior,
    policy: { targetDays: 7, toleranceHours: BODY_MASS_TOLERANCE_HOURS },
    policyVersion: BODY_MASS_POLICY_VERSION,
    computedAt: now.toISOString(),
  });
  if (result.value == null) return { ...empty, latest };

  // The 5% test uses the unrounded ratio; only the shown percent is rounded,
  // so 5.04% is flagged even though it reads "5.0%".
  const ratio = result.value / prior.value!;
  const change = {
    percent: Math.round(ratio * 1000) / 10,
    kilograms: Math.round(result.value * 100) / 100,
    prior_kilograms: prior.value!,
    prior_observed_at: prior.observedAt,
    days: Math.round((Date.parse(current.observedAt) - Date.parse(prior.observedAt)) / DAY_MS),
  };
  const flagged = Math.abs(ratio) * 100 > BODY_MASS_FLAG_PERCENT;
  return {
    ...empty,
    latest,
    change,
    flagged,
    flag_text: flagged ? flagText(change, latest.kilograms) : null,
  };
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
