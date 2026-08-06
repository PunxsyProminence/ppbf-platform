import type { ObservationKind } from './formulas/types';
import { getSafetyGateDefinition, recordSafetyGateEvaluation } from './safetyGateMatrix';
import { getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
import { findNearMissByTriggerContext, flagNearMiss } from './shadowNearMisses';
import type { ShadowNearMissSeverity } from './shadowNearMisses';

/** The gate_key this module is registered under in pilot.safety_gates. */
const GATE_KEY = 'contact_medical_clearance';

/** The metadata marker this gate's near misses are written and deduped by. */
const NEAR_MISS_TRIGGER = 'contact_observation_without_medical_clearance';

/** Used only if the gate row itself is missing (pre-migration organization). */
const DEFAULT_LESSON =
  "Ask your coach or gym admin to set an explicit 'cleared' medical administrative status "
  + 'on file for this athlete before contact continues.';

/**
 * The observation kinds that mean an athlete physically took contact.
 *
 * Deliberately narrow. `punch_attempted` and `punch_landed` are excluded: those
 * are equally true of bag and mitt work, so treating them as contact would flag
 * ordinary conditioning. What is left is contact by definition -- a contact
 * level, rounds of contact, and punches absorbed, which cannot happen without a
 * partner.
 */
export const CONTACT_OBSERVATION_KINDS: readonly ObservationKind[] = [
  'contact_level',
  'contact_rounds',
  'punch_absorbed',
];

const CONTACT_KIND_SET: ReadonlySet<string> = new Set(CONTACT_OBSERVATION_KINDS);

/**
 * True when this observation records contact that actually occurred.
 *
 * A value of zero is not contact -- it is the athlete or coach recording that
 * there was none ("None" is the 0 position on the contact-level slider), which is
 * useful data and must not trip a safety flag. Null is the "no reading" case and
 * is likewise not evidence of contact.
 */
export function isContactObservation(kind: string, value: number | null): boolean {
  return CONTACT_KIND_SET.has(kind) && value !== null && value > 0;
}

/**
 * Severity for contact logged without a current clearance.
 *
 * 'not_cleared' and 'restricted' are affirmative medical decisions that this
 * athlete should not be taking contact, so contact happening anyway is the most
 * serious version of this and is critical. 'pending' and a missing record mean
 * nobody has decided yet -- still a real gap that needs a human to look, but a
 * process failure rather than a known contraindication being overridden.
 */
function severityForStatus(status: string): ShadowNearMissSeverity {
  return status === 'not_cleared' || status === 'restricted' ? 'critical' : 'high';
}

function describe(status: string, kind: string, value: number, athleteId: string): string {
  const situation = status === 'no_record'
    ? 'has no medical administrative status on file'
    : `has medical administrative status '${status}', not 'cleared'`;

  return `Contact was logged for athlete ${athleteId}, who ${situation}. `
    + `Observation '${kind}' recorded a value of ${value}. The observation was kept -- `
    + 'it is evidence of what happened and must not be discarded -- but the contact '
    + 'occurred without a current clearance on file and needs review.';
}

export interface ContactClearanceOutcome {
  /** True when a near miss was raised for this observation. */
  readonly flagged: boolean;
  /** The status that caused the flag, for the caller's response body. */
  readonly medicalStatus?: string;
  readonly severity?: ShadowNearMissSeverity;
  /**
   * The gate's requirement_text -- what earns clearance -- present only
   * when flagged. The "teaching moment" doctrine: a stop names what's
   * missing and where to fix it, not just that it happened. Falls back to
   * a plain-language default if the gate row is missing (pre-migration
   * organization), so a flag is never explained by nothing at all.
   */
  readonly lesson?: string;
}

/**
 * Raises a near miss when a contact observation arrives for an athlete without a
 * current medical clearance.
 *
 * WHY THIS DOES NOT REFUSE THE WRITE. The obvious reading of the safety rule --
 * "sparring requires medical clearance", as packages/execution/safetyGate.ts puts
 * it -- suggests rejecting the request. That is the wrong control at this point in
 * the system. This route records contact that has ALREADY happened; refusing the
 * write does not un-spar the athlete, it destroys the only record that it
 * occurred, and it teaches whoever is logging to leave the contact fields blank
 * next time. Under-reporting is the failure mode that actually hurts an athlete.
 * So the observation is kept and a near miss is raised, which is visible to
 * coaches on the decision-loop surface.
 *
 * Fails toward alerting: callers invoke this BEFORE persisting the observation,
 * so a database problem while flagging aborts the whole request rather than
 * silently storing contact nobody was told about. A retry is safe because the
 * observation write is idempotency-keyed. The cost of that ordering is a possible
 * near miss for an observation that then failed to save -- an over-alert, which is
 * the right direction to be wrong in.
 *
 * Registered in the Safety Gate Matrix (safetyGateMatrix.ts) under
 * GATE_KEY = 'contact_medical_clearance', as a 'flag' gate -- see
 * pilot_slice_postgres_safety_gate_matrix_migration.sql for why enforcement
 * is a first-class property rather than assumed. Every evaluation this
 * function performs (pass or flag) is recorded through that shared
 * substrate, in addition to -- not instead of -- the near-miss this
 * function has always raised on a flag. An organization can deactivate the
 * gate row (`active_flag = false`) to turn off this specific check without
 * a code change; that is a per-org configuration decision, not an override
 * of an individual evaluation's outcome -- no such override exists.
 */
export async function flagContactWithoutClearance(input: {
  organizationId: string;
  athleteId: string;
  kind: string;
  value: number | null;
  actorAccountId: string;
  actorRole: string;
  contextId: string;
  observedAt: string;
}): Promise<ContactClearanceOutcome> {
  if (!isContactObservation(input.kind, input.value)) {
    return { flagged: false };
  }

  const gate = await getSafetyGateDefinition(input.organizationId, GATE_KEY);
  if (gate && !gate.active_flag) {
    return { flagged: false };
  }

  // Fail closed, matching assertMedicalStatusAllowsRecommendation: only an
  // explicit 'cleared' record counts. Absence of a clearance decision is not a
  // clearance decision.
  const record = await getLatestMedicalAdministrativeStatus(input.organizationId, input.athleteId);
  const value = input.value as number;

  if (record?.status === 'cleared') {
    // pilot.safety_gate_evaluations has a foreign key to (organization_id,
    // gate_key) in pilot.safety_gates -- a pre-migration organization with
    // no gate row would fail that constraint and abort the whole
    // observation request. Recording is therefore best-effort, gated on the
    // row actually existing; the underlying flagging/near-miss behavior
    // below does not depend on it and must never be blocked by it.
    if (gate) {
      await recordSafetyGateEvaluation({
        organizationId: input.organizationId,
        gateKey: GATE_KEY,
        athleteId: input.athleteId,
        outcome: 'passed',
        evaluatedByAccountId: input.actorAccountId,
        evaluatedByRole: input.actorRole,
        contextId: input.contextId,
        metadata: { observation_kind: input.kind, observation_value: value },
        evaluatedAt: input.observedAt,
      });
    }
    return { flagged: false };
  }

  const status = record?.status ?? 'no_record';
  const severity = severityForStatus(status);
  const lesson = gate?.requirement_text ?? DEFAULT_LESSON;

  // One near miss (and thus one escalation) per SESSION, not per contact
  // observation: a single sparring submission posts contact_level,
  // contact_rounds, and punch_absorbed as separate requests, each of which
  // lands here. Without this check, one uncleared session filed three
  // near-identical near misses and three open escalations -- and three rows
  // with the same trigger then read as a "repeated pattern" to the detector,
  // which is supposed to mean repeated SESSIONS. The evaluation record below
  // is still written per observation: that table is the audit trail of what
  // was checked, not the alert surface.
  const alreadyFlagged = await findNearMissByTriggerContext(
    input.organizationId,
    input.athleteId,
    NEAR_MISS_TRIGGER,
    input.contextId,
  );

  if (!alreadyFlagged) {
    await flagNearMiss({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
      description: describe(status, input.kind, value, input.athleteId),
      severity,
      detectedBy: 'system',
      detectedByAccountId: input.actorAccountId,
      detectedByRole: input.actorRole,
      metadata: {
        trigger: NEAR_MISS_TRIGGER,
        observation_kind: input.kind,
        observation_value: value,
        medical_status: status,
        context_id: input.contextId,
        observed_at: input.observedAt,
      },
    });
  }

  // Same FK constraint as the passed path above -- best-effort, gated on the
  // gate row existing, never a reason to fail a request that already
  // succeeded at raising the near miss that actually matters.
  if (gate) {
    await recordSafetyGateEvaluation({
      organizationId: input.organizationId,
      gateKey: GATE_KEY,
      athleteId: input.athleteId,
      outcome: 'flagged',
      reason: describe(status, input.kind, value, input.athleteId),
      evaluatedByAccountId: input.actorAccountId,
      evaluatedByRole: input.actorRole,
      contextId: input.contextId,
      metadata: {
        observation_kind: input.kind,
        observation_value: value,
        medical_status: status,
      },
      evaluatedAt: input.observedAt,
    });
  }

  return { flagged: true, medicalStatus: status, severity, lesson };
}
