import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

/**
 * Shared substrate for athlete-safety gates (capabilities #3 / #43).
 *
 * A gate's `enforcement` is 'block' or 'flag', never assumed by a caller.
 * 'block' refuses the action outright; 'flag' allows it and raises a near
 * miss (or equivalent) for human review. contactClearanceGate.ts is the
 * first gate wired through this module, and it is a 'flag' gate on
 * purpose -- see its own file for why refusing the write would be the
 * wrong control. A future gate (e.g. a pre-action sparring-registration
 * check) can be a 'block' gate without this module changing shape.
 *
 * Every evaluation this module records carries the outcome, not only
 * refusals -- the plan's "teaching moment" doctrine wants an audit trail of
 * "was this athlete evaluated," not only "was this athlete stopped."
 *
 * No override path exists here, deliberately: per SHADOW_AUTHORITY_MODEL.md
 * and the video-scan-policy precedent ("never overturns what it refused"),
 * only the underlying condition a gate reads (e.g. medical status) can
 * change its outcome. A coach/admin override parameter is not something to
 * add later -- it is something this module must keep refusing to have.
 */

export type SafetyGateEnforcement = 'block' | 'flag';
export type SafetyGateOutcome = 'passed' | 'blocked' | 'flagged';

export interface SafetyGateDefinition {
  gate_id: string;
  gate_key: string;
  name: string;
  category: string;
  enforcement: SafetyGateEnforcement;
  requirement_text: string;
  active_flag: boolean;
}

export interface SafetyGateEvaluationRow {
  evaluation_id: string;
  gate_key: string;
  athlete_id: string;
  outcome: SafetyGateOutcome;
  reason: string;
  evaluated_by_account_id: string;
  evaluated_by_role: string;
  context_id: string;
  metadata: Record<string, unknown>;
  evaluated_at: string;
}

/** The gate row for one organization, or null if that gym never got seeded (pre-migration edge case). */
export async function getSafetyGateDefinition(
  organizationId: string,
  gateKey: string,
): Promise<SafetyGateDefinition | null> {
  return queryOne<SafetyGateDefinition>(
    `select gate_id, gate_key, name, category, enforcement, requirement_text, active_flag
     from pilot.safety_gates
     where organization_id = $1 and gate_key = $2`,
    [organizationId, gateKey],
  );
}

export async function listSafetyGateDefinitions(organizationId: string): Promise<SafetyGateDefinition[]> {
  return query<SafetyGateDefinition>(
    `select gate_id, gate_key, name, category, enforcement, requirement_text, active_flag
     from pilot.safety_gates
     where organization_id = $1
     order by name`,
    [organizationId],
  );
}

/**
 * Records one gate evaluation. Called for both passing and non-passing
 * outcomes -- see the module doc comment for why a passes-only table would
 * not answer "when was this athlete last checked."
 */
export async function recordSafetyGateEvaluation(input: {
  organizationId: string;
  gateKey: string;
  athleteId: string;
  outcome: SafetyGateOutcome;
  reason?: string;
  evaluatedByAccountId: string;
  evaluatedByRole: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
  evaluatedAt: string;
}): Promise<SafetyGateEvaluationRow> {
  const evaluationId = randomUUID();
  await query(
    `insert into pilot.safety_gate_evaluations (
       organization_id, evaluation_id, gate_key, athlete_id,
       outcome, reason, evaluated_by_account_id, evaluated_by_role,
       context_id, metadata, evaluated_at
     ) values (
       $1,$2,$3,$4,
       $5,$6,$7,$8,
       $9,$10::jsonb,$11
     )`,
    [
      input.organizationId,
      evaluationId,
      input.gateKey,
      input.athleteId,
      input.outcome,
      input.reason ?? '',
      input.evaluatedByAccountId,
      input.evaluatedByRole,
      input.contextId ?? '',
      JSON.stringify(input.metadata ?? {}),
      input.evaluatedAt,
    ],
  );

  return {
    evaluation_id: evaluationId,
    gate_key: input.gateKey,
    athlete_id: input.athleteId,
    outcome: input.outcome,
    reason: input.reason ?? '',
    evaluated_by_account_id: input.evaluatedByAccountId,
    evaluated_by_role: input.evaluatedByRole,
    context_id: input.contextId ?? '',
    metadata: input.metadata ?? {},
    evaluated_at: input.evaluatedAt,
  };
}

/**
 * Most recent evaluations for one athlete across every gate, newest first --
 * the read path a future athlete-facing "why was I flagged" or coach
 * dashboard reads from.
 */
export async function listSafetyGateEvaluationsForAthlete(
  organizationId: string,
  athleteId: string,
  limit = 50,
): Promise<SafetyGateEvaluationRow[]> {
  return query<SafetyGateEvaluationRow>(
    `select evaluation_id, gate_key, athlete_id, outcome, reason,
            evaluated_by_account_id, evaluated_by_role, context_id, metadata,
            evaluated_at::text
     from pilot.safety_gate_evaluations
     where organization_id = $1 and athlete_id = $2
     order by evaluated_at desc
     limit $3`,
    [organizationId, athleteId, limit],
  );
}
