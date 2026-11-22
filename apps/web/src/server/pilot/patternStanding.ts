import { listBehaviourReadingsForEvaluation } from './behaviourObservations';
import { listActiveLearningPolicies } from './learningPolicies';
import { evaluateStoredPatternStanding, standingBars, type StoredPatternStanding } from './patterns/fromStore';

// PATTERN-1b (PunxsyProminence/ppbf-platform#2082): one athlete's standing on
// one behaviour, from the stored reports and the gym's bars in force, through
// the tier engine (patterns/tiers.ts). Read only: it writes nothing and decides
// nothing. No route or screen calls it yet (Q6 A; labels at a dated review
// point are a later build). It does not check who is asking: a caller must be
// staff of this gym with access to the athlete, as for the reports themselves
// (privacyTiers.ts, behaviour_observations).
//
// With no pattern bar in force, or an unreadable bar, it returns the reason
// and reads no report.

export async function evaluatePatternStanding(input: {
  organizationId: string;
  athleteId: string;
  behaviourKey: string;
  asOf?: string;
}): Promise<StoredPatternStanding> {
  const asOf = input.asOf ?? new Date().toISOString();
  const activePolicies = await listActiveLearningPolicies(input.organizationId);
  const gymReadings = standingBars(activePolicies).notEvaluated === null
    ? await listBehaviourReadingsForEvaluation(input.organizationId, input.behaviourKey)
    : [];
  return evaluateStoredPatternStanding({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,
    asOf,
    activePolicies,
    gymReadings,
  });
}
