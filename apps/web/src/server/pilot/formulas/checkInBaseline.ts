/**
 * Personal baseline (MVP-09) from the daily check-in.
 *
 * Jason 2026-10-17 (OD-2026-10-17-020): sleep, energy and soreness from the
 * daily check-in, each compared with the athlete's own last 28 days, starting
 * once they have 7 check-ins; "provisional" until about 14; an SD floor
 * ("Yes, all three (Rec.)"). Floors relayed by Overwatch: 0.5 point for the
 * 1-5 ratings, 0.5 h for sleep.
 *
 * WHAT IT WRITES. One `numeric` observation per answered item, keyed by the
 * check-in (idempotent: a retried check-in writes nothing new). The check-in
 * row stays the source; pilot.athlete_check_ins is insert-once per day and
 * never updated, so this copy cannot drift from it. metricKey is the check-in
 * column name, the convention lane L58's new items follow (Overwatch,
 * 2026-10-17): a new item is one line in CHECK_IN_BASELINE_METRICS.
 *
 * WHAT IT DOES NOT DO. No flag, no alert, no recommendation (Overwatch QD4;
 * the recommendation producer belongs to ChatGPT). It stores per-item results
 * and nothing reads them as a verdict. Parents do not read MVP-09 results
 * (Overwatch QD2): check-in values have no parent surface, so a baseline
 * derived from them must not open one.
 */

import { deterministicKey } from './identity';
import {
  getActiveObservationsOfKindInWindow,
  saveFormulaObservation,
} from './repository';
import { runStoredMvpFormula } from './runner';
import type { FormulaResult, FormulaUnit } from './types';

export const CHECK_IN_BASELINE_POLICY_VERSION = 'check-in-baseline-2026-10-17';

/**
 * The context every check-in observation is filed under (`check-in:<id>`, also
 * used by athleteBodyMass.ts). A baseline value counts only from here: the
 * generic observations route refuses `numeric` writes into these contexts, so
 * nothing but the check-in itself can put a number into an athlete's baseline.
 */
export const CHECK_IN_CONTEXT_PREFIX = 'check-in:';
export const CHECK_IN_BASELINE_WINDOW_DAYS = 28;
export const CHECK_IN_BASELINE_MINIMUM_HISTORY = 7;
export const CHECK_IN_BASELINE_ADEQUATE_HISTORY = 14;

export const CHECK_IN_BASELINE_METRICS = Object.freeze([
  Object.freeze({ metricKey: 'sleep_hours' as const, unit: 'hours' as FormulaUnit, sdFloor: 0.5 }),
  Object.freeze({ metricKey: 'energy' as const, unit: 'rating_1_5' as FormulaUnit, sdFloor: 0.5 }),
  Object.freeze({ metricKey: 'soreness' as const, unit: 'rating_1_5' as FormulaUnit, sdFloor: 0.5 }),
]);

export type CheckInBaselineMetricKey = (typeof CHECK_IN_BASELINE_METRICS)[number]['metricKey'];

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Writes the answered items as observations and runs MVP-09 for each, over
 * that athlete's same-item values in the 28 days up to this check-in.
 * Returns the persisted results. Blank items write and run nothing.
 */
export async function recordCheckInBaselines(input: {
  organizationId: string;
  athleteId: string;
  checkInId: string;
  observedAt: string;
  accountId: string;
  values: Readonly<Partial<Record<CheckInBaselineMetricKey, number | null>>>;
}): Promise<readonly FormulaResult[]> {
  const results: FormulaResult[] = [];
  for (const metric of CHECK_IN_BASELINE_METRICS) {
    const raw = input.values[metric.metricKey];
    const value = raw == null ? null : Number(raw);
    if (value == null || !Number.isFinite(value)) continue;

    const idempotencyKey = `check-in:${input.checkInId}:${metric.metricKey}`;
    const current = await saveFormulaObservation({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
      contextId: `${CHECK_IN_CONTEXT_PREFIX}${input.checkInId}`,
      kind: 'numeric',
      value,
      unit: metric.unit,
      dimensions: { metricKey: metric.metricKey },
      observedAt: input.observedAt,
      source: {
        type: 'manual',
        quality: 'moderate',
        referenceId: deterministicKey('check-in-baseline', {
          organizationId: input.organizationId,
          accountId: input.accountId,
          idempotencyKey,
        }),
        qualityNotes: 'Athlete self-reported at check-in.',
      },
      idempotencyKey,
      createdByAccountId: input.accountId,
    });

    const currentMs = Date.parse(current.observedAt);
    const window = await getActiveObservationsOfKindInWindow({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
      kind: 'numeric',
      observedAfter: new Date(currentMs - CHECK_IN_BASELINE_WINDOW_DAYS * DAY_MS).toISOString(),
      observedAtOrBefore: current.observedAt,
    });
    const history = window.filter((observation) => (
      observation.observationId !== current.observationId
      && observation.contextId.startsWith(CHECK_IN_CONTEXT_PREFIX)
      && observation.dimensions?.metricKey === metric.metricKey
      && observation.unit === metric.unit
      && Date.parse(observation.observedAt) < currentMs
    ));

    const output = await runStoredMvpFormula({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
      formulaId: 'MVP-09',
      observationIds: [...history.map((observation) => observation.observationId), current.observationId],
      parameters: {
        metricKey: metric.metricKey,
        windowDays: CHECK_IN_BASELINE_WINDOW_DAYS,
        minimumHistory: CHECK_IN_BASELINE_MINIMUM_HISTORY,
        adequateHistory: CHECK_IN_BASELINE_ADEQUATE_HISTORY,
        sdFloor: metric.sdFloor,
      },
      policyVersion: CHECK_IN_BASELINE_POLICY_VERSION,
    });
    results.push(...output.results);
  }
  return Object.freeze(results);
}
