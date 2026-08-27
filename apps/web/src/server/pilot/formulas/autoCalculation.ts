/**
 * Auto-orchestration: the observation that completes a formula's input set
 * causes that formula to run.
 *
 * THE GAP THIS CLOSES. `pilot.shadow_formula_results` had exactly one writer:
 * a human POSTing to /api/pilot/shadow/formulas/results with the observation
 * ids already worked out. Nothing in the product does that. The sparring
 * page's Deep-Track form posts a complete, matched set of observations on
 * every submission and no calculation has ever followed one, so the table it
 * feeds stayed empty while the form's own comment promised "the formula engine
 * actually being able to compute Accuracy, Connect Differential...".
 *
 * WHAT THIS IS NOT. It is not a scheduler, a queue, a debounce, or a rules
 * engine. It reads one context, matches it against
 * FORMULA_INPUT_REQUIREMENTS, and calls the existing runStoredMvpFormula for
 * each complete match. Every guarantee it relies on already existed:
 *
 *   - Idempotency. `calculationKey` is a sha256 over formula identity, scope
 *     and ordered input observation ids and EXCLUDES computedAt; the insert is
 *     `on conflict (organization_id, calculation_key) do nothing` followed by a
 *     re-read. Running the same detection twice writes nothing the second time
 *     and returns the first run's row. That is what makes the concurrency below
 *     safe rather than merely unlikely.
 *   - Supersession. getActiveObservationsForContext filters superseded rows
 *     with the same predicate the manual path uses.
 *   - Missing inputs. A null value is never substituted with zero anywhere in
 *     this module; the engine turns it into an explicit `insufficient` result.
 *
 * WHY THERE IS NO DEBOUNCE. app/athlete/dashboard/sparring/page.tsx fires
 * every observation of a submission concurrently through Promise.allSettled,
 * so this runs several times for one session, against a context that is still
 * filling up. An exact-match detector needs no settling timer to cope with
 * that: a partial context matches nothing and produces nothing, and whichever
 * request commits the last observation of a set is the one that fires. If two
 * of them race and both fire, they compute the same calculationKey and the
 * second is a no-op insert. A timer would add a window in which a result is
 * owed and absent, in exchange for nothing.
 */

import { getActiveObservationsForContext } from './repository';
import {
  FORMULA_INPUT_REQUIREMENTS,
  runStoredMvpFormula,
  type FormulaInputRequirement,
} from './runner';
import type { PilotRole } from '../contracts';
import type {
  FormulaResult,
  NumericObservation,
  ObservationKind,
} from './types';

/**
 * Roles that may cause a stored calculation to be written.
 *
 * This mirrors the allow-list on POST /api/pilot/shadow/formulas/results
 * (app/api/pilot/shadow/formulas/results/route.ts:99) exactly, and it exists as
 * its own named constant rather than an import so that widening one does not
 * silently widen the other. autoCalculation.test.ts asserts the two agree.
 *
 * The asymmetry is real and deliberate: an athlete may POST an observation and
 * may READ results, but may not ask for a calculation to be run. Letting
 * auto-orchestration run on an athlete's own POST would hand them, through a
 * side effect, precisely the capability the manual route refuses them. That is
 * an owner decision about where the boundary belongs, not one this module is
 * entitled to make, so it takes the narrower reading and leaves the question
 * visible.
 */
export const STORED_CALCULATION_TRIGGER_ROLES: readonly PilotRole[] = Object.freeze([
  'coach',
  'organization_admin',
  'admin',
]);

export function canTriggerStoredCalculation(role: PilotRole): boolean {
  return STORED_CALCULATION_TRIGGER_ROLES.includes(role);
}

export interface DetectedFormulaCalculation {
  readonly formulaId: FormulaInputRequirement['formulaId'];
  readonly observationIds: readonly string[];
}

/** The switch's own reading of a dimension: absent and non-string are ''. */
function dimensionString(observation: NumericObservation, key: string): string {
  const value = observation.dimensions?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function groupKeyFor(
  observation: NumericObservation,
  requirement: FormulaInputRequirement,
): string {
  // The NUL separator calculateStoredFormula's own MVP-03 groupKey uses, for
  // the same reason: contextId and punchType are both caller-supplied text, and
  // any separator either could contain would let two distinct groups collide.
  return requirement.groupByDimensionKey === null
    ? observation.contextId
    : `${observation.contextId}\u0000${dimensionString(observation, requirement.groupByDimensionKey)}`;
}

function groupSatisfies(
  members: readonly NumericObservation[],
  requirement: FormulaInputRequirement,
): boolean {
  for (const [kind, count] of Object.entries(requirement.kinds) as [ObservationKind, number][]) {
    if (members.filter((member) => member.kind === kind).length !== count) return false;
  }
  return members.every((member) => (
    member.unit === requirement.units[member.kind]
    && requirement.requiredDimensionKeys.every((key) => dimensionString(member, key) !== '')
  ));
}

/**
 * Pure. No I/O, no clock, no randomness: the same observations in any order
 * produce the same list.
 *
 * Exact match only. A group holding two `punch_landed` observations does not
 * satisfy MVP-04 and never resolves to "pick one" -- there is no rule in this
 * codebase for which of them the athlete meant, and inventing one here would
 * publish a differential computed against an arbitrary half of the evidence.
 * Returning nothing is the honest answer, and the manual /results path remains
 * available for a coach who knows which pair is which.
 *
 * What it does NOT filter on is just as deliberate. A null value passes
 * straight through, because the engine turns it into an `insufficient` result
 * that the manual path persists -- and two paths that disagree about the same
 * observations would be worse than either. Source quality is not consulted for
 * the same reason: every observation this application produces is `moderate`
 * manual input, the engine already records that as a FALLBACK_SOURCE_USED
 * warning on the result, and a quality floor here would be a threshold nobody
 * has set.
 */
export function detectSatisfiedFormulaInputs(
  observations: readonly NumericObservation[],
): readonly DetectedFormulaCalculation[] {
  const detected: DetectedFormulaCalculation[] = [];

  for (const requirement of FORMULA_INPUT_REQUIREMENTS) {
    const kinds = new Set(Object.keys(requirement.kinds) as ObservationKind[]);
    const groups = new Map<string, NumericObservation[]>();
    for (const observation of observations) {
      if (!kinds.has(observation.kind)) continue;
      const key = groupKeyFor(observation, requirement);
      const members = groups.get(key) ?? [];
      members.push(observation);
      groups.set(key, members);
    }

    for (const key of [...groups.keys()].sort()) {
      const members = groups.get(key)!;
      if (!groupSatisfies(members, requirement)) continue;
      detected.push(Object.freeze({
        formulaId: requirement.formulaId,
        observationIds: Object.freeze(
          members.map((member) => member.observationId).sort(),
        ),
      }));
    }
  }

  return Object.freeze(detected);
}

/**
 * Reads one context, runs every complete set it holds, returns what was
 * persisted.
 *
 * Thin on purpose. It opens no transaction and writes nothing itself:
 * runStoredMvpFormula owns the persistence path, unchanged, so a result
 * produced here is byte-identical to one a coach produces by hand from the
 * same observations -- same calculationKey, same provenance, same validation
 * state.
 *
 * FAILURE COUPLING, stated because it is a real consequence and an owner
 * decision rather than an oversight: this is called after the observation has
 * committed, and it does not swallow errors. A failure here therefore fails a
 * request whose observation is already stored. That is the same coupling
 * recalculateForSupersededObservation has carried at the same call site since
 * it was written, and swallowing the error instead would mean an orchestration
 * that silently stops orchestrating -- which is the failure this module exists
 * to end, arriving by a different route. What is genuinely different is blast
 * radius: the supersession path runs only when a caller deliberately corrects
 * a record, and this one runs on every observation POST. Whether that trade is
 * the right one is the owner's call.
 */
export async function autoCalculateForObservationContext(input: {
  organizationId: string;
  athleteId: string;
  contextId: string;
}): Promise<readonly FormulaResult[]> {
  const observations = await getActiveObservationsForContext(input);
  const detected = detectSatisfiedFormulaInputs(observations);

  const results: FormulaResult[] = [];
  for (const calculation of detected) {
    const output = await runStoredMvpFormula({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
      formulaId: calculation.formulaId,
      observationIds: calculation.observationIds,
    });
    results.push(...output.results);
  }
  return Object.freeze(results);
}
