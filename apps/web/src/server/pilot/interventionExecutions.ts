import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { getProtocol } from './interventionProtocols';

// Intervention executions (register module 026 slice 2) -- what ACTUALLY
// happened when a protocol was run. A human decision is not evidence an
// intervention was executed; a decision can exist with zero executions,
// and one protocol/decision can span many. The planned_* columns are a
// snapshot taken at start time and no function here ever writes them
// again -- deviations are recorded beside the plan, never painted over it.
//
// Adherence is an explicit state (never a fake percentage) because
// "intervention looked ineffective" and "intervention was never really
// delivered" must stay distinguishable forever. Corrections are
// supersession with a stated reason -- history is never rewritten.

export const ADHERENCE_STATES = [
  'delivered_as_planned', 'delivered_with_deviations',
  'under_delivered', 'not_delivered', 'unknown',
] as const;

export const TRAINED_CONTEXTS = ['unknown', 'controlled', 'constrained_live', 'live'] as const;

export type AdherenceState = (typeof ADHERENCE_STATES)[number];
export type TrainedContext = (typeof TRAINED_CONTEXTS)[number];
export type ExecutionStatus = 'in_progress' | 'completed' | 'stopped' | 'superseded';

/** Returns the reason an adherence value is refused, or null. Absence is
 * legal -- it stays 'unknown', which is the honest default. */
export function adherenceError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(ADHERENCE_STATES as readonly string[]).includes(value)) {
    return `adherence must be one of: ${ADHERENCE_STATES.join(', ')}.`;
  }
  return null;
}

/** Returns the reason a trained-context value is refused, or null. Context
 * is a small factual vocabulary -- there is no difficulty score. */
export function trainedContextError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(TRAINED_CONTEXTS as readonly string[]).includes(value)) {
    return `trained_context must be one of: ${TRAINED_CONTEXTS.join(', ')}.`;
  }
  return null;
}

export interface InterventionExecutionRow {
  organization_id: string;
  execution_id: string;
  lineage_id: string;
  version: number;
  supersedes_execution_id: string | null;
  athlete_id: string;
  athlete_name: string | null;
  decision_id: string | null;
  protocol_id: string;
  protocol_version: number;
  protocol_title: string | null;
  session_run_id: string | null;
  recorded_by_account_id: string;
  planned_start: string | null;
  actual_start: string | null;
  actual_end: string | null;
  status: ExecutionStatus;
  planned_exposure: Record<string, number>;
  planned_task_context: string;
  actual_exposure: Record<string, number>;
  trained_context: TrainedContext;
  task_constraint: string;
  partner_context: string;
  adherence: AdherenceState;
  deviations: string;
  deviation_reason: string;
  stop_change_reason: string;
  notes: string;
  correction_reason: string;
  created_at: string;
}

const FIELDS = `e.organization_id, e.execution_id, e.lineage_id, e.version,
  e.supersedes_execution_id, e.athlete_id, a.full_name as athlete_name,
  e.decision_id, e.protocol_id, e.protocol_version, p.title as protocol_title,
  e.session_run_id, e.recorded_by_account_id,
  e.planned_start, e.actual_start, e.actual_end, e.status,
  e.planned_exposure, e.planned_task_context, e.actual_exposure,
  e.trained_context, e.task_constraint, e.partner_context, e.adherence,
  e.deviations, e.deviation_reason, e.stop_change_reason, e.notes,
  e.correction_reason, e.created_at`;

const FROM = `from pilot.intervention_executions e
  left join pilot.athletes a
    on a.organization_id = e.organization_id and a.athlete_id = e.athlete_id
  left join pilot.intervention_protocols p
    on p.organization_id = e.organization_id and p.protocol_id = e.protocol_id`;

export interface ExecutionFactsInput {
  actualExposure?: Record<string, number>;
  trainedContext?: TrainedContext;
  taskConstraint?: string;
  partnerContext?: string;
  adherence?: AdherenceState;
  deviations?: string;
  deviationReason?: string;
  notes?: string;
  actualStart?: string;
}

/** Starts an execution against an ACTIVE protocol head, snapshotting the
 * protocol's intended exposure and task context as the plan. The decision
 * link, when given, must belong to the same org AND athlete -- anything
 * else is a hidden not-found, indistinguishable from nonexistence. */
export async function startExecution(input: {
  organizationId: string;
  athleteId: string;
  protocolId: string;
  decisionId?: string | null;
  sessionRunId?: string | null;
  plannedStart?: string | null;
  actualStart?: string | null;
  recordedByAccountId: string;
}): Promise<InterventionExecutionRow | null> {
  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  const protocol = await getProtocol(input.organizationId, input.protocolId);
  if (!protocol || protocol.status !== 'active') return null;
  // A protocol designed for one athlete never silently applies to another.
  if (protocol.athlete_id && protocol.athlete_id !== input.athleteId) return null;

  if (input.decisionId) {
    const decision = await queryOne<{ decision_id: string }>(
      `select decision_id from pilot.shadow_decisions
       where decision_id = $1 and organization_id = $2 and athlete_id = $3`,
      [input.decisionId, input.organizationId, input.athleteId],
    );
    if (!decision) return null;
  }

  const executionId = randomUUID();
  await queryOne(
    `insert into pilot.intervention_executions
       (organization_id, execution_id, lineage_id, version, athlete_id, decision_id,
        protocol_id, protocol_version, session_run_id, recorded_by_account_id,
        planned_start, actual_start, planned_exposure, planned_task_context)
     values ($1, $2, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     returning execution_id`,
    [
      input.organizationId,
      executionId,
      input.athleteId,
      input.decisionId ?? null,
      input.protocolId,
      protocol.version,
      input.sessionRunId ?? null,
      input.recordedByAccountId,
      input.plannedStart ?? null,
      input.actualStart ?? null,
      JSON.stringify(protocol.intended_exposure ?? {}),
      protocol.intended_task_context ?? '',
    ],
  );

  return getExecution(input.organizationId, executionId);
}

export async function getExecution(organizationId: string, executionId: string): Promise<InterventionExecutionRow | null> {
  return queryOne<InterventionExecutionRow>(
    `select ${FIELDS} ${FROM}
     where e.organization_id = $1 and e.execution_id = $2`,
    [organizationId, executionId],
  );
}

/** Current records only (superseded corrections are history), newest
 * first; optionally narrowed to one athlete. */
export async function listExecutions(organizationId: string, athleteId?: string): Promise<InterventionExecutionRow[]> {
  if (athleteId) {
    return query<InterventionExecutionRow>(
      `select ${FIELDS} ${FROM}
       where e.organization_id = $1 and e.athlete_id = $2 and e.status <> 'superseded'
       order by e.created_at desc`,
      [organizationId, athleteId],
    );
  }
  return query<InterventionExecutionRow>(
    `select ${FIELDS} ${FROM}
     where e.organization_id = $1 and e.status <> 'superseded'
     order by e.created_at desc`,
    [organizationId],
  );
}

/** Updates ACTUAL facts on an in-progress execution. The planned_* columns
 * are deliberately absent from this statement -- the plan is a snapshot,
 * and deviating from it never edits it. */
export async function recordExecutionFacts(input: ExecutionFactsInput & {
  organizationId: string;
  executionId: string;
}): Promise<InterventionExecutionRow | null> {
  const row = await queryOne<{ execution_id: string }>(
    `update pilot.intervention_executions set
       actual_exposure = coalesce($3::jsonb, actual_exposure),
       trained_context = coalesce($4, trained_context),
       task_constraint = coalesce($5, task_constraint),
       partner_context = coalesce($6, partner_context),
       adherence = coalesce($7, adherence),
       deviations = coalesce($8, deviations),
       deviation_reason = coalesce($9, deviation_reason),
       notes = coalesce($10, notes),
       actual_start = coalesce($11, actual_start),
       updated_at = now()
     where organization_id = $1 and execution_id = $2 and status = 'in_progress'
     returning execution_id`,
    [
      input.organizationId,
      input.executionId,
      input.actualExposure === undefined ? null : JSON.stringify(input.actualExposure),
      input.trainedContext ?? null,
      input.taskConstraint ?? null,
      input.partnerContext ?? null,
      input.adherence ?? null,
      input.deviations ?? null,
      input.deviationReason ?? null,
      input.notes ?? null,
      input.actualStart ?? null,
    ],
  );
  if (!row) return null;
  return getExecution(input.organizationId, input.executionId);
}

/** Closes an in-progress execution as completed or stopped. A stop
 * requires its reason (also a database constraint). Final facts may be
 * recorded in the same act. */
export async function closeExecution(input: ExecutionFactsInput & {
  organizationId: string;
  executionId: string;
  outcome: 'completed' | 'stopped';
  stopChangeReason?: string;
  actualEnd?: string | null;
}): Promise<InterventionExecutionRow | null> {
  const updated = await recordExecutionFacts(input);
  if (!updated) return null;

  const row = await queryOne<{ execution_id: string }>(
    `update pilot.intervention_executions set
       status = $3,
       stop_change_reason = coalesce($4, stop_change_reason),
       actual_end = coalesce($5, actual_end, now()),
       updated_at = now()
     where organization_id = $1 and execution_id = $2 and status = 'in_progress'
     returning execution_id`,
    [
      input.organizationId,
      input.executionId,
      input.outcome,
      input.stopChangeReason ?? null,
      input.actualEnd ?? null,
    ],
  );
  if (!row) return null;
  return getExecution(input.organizationId, input.executionId);
}

/** Correction is supersession: a NEW version row with a stated reason; the
 * original keeps its values forever and is stamped superseded. Actual
 * facts are re-stated; identity, links, and the planned snapshot are
 * carried from the original untouched. */
export async function correctExecution(input: ExecutionFactsInput & {
  organizationId: string;
  executionId: string;
  correctionReason: string;
  outcome?: 'in_progress' | 'completed' | 'stopped';
  stopChangeReason?: string;
  actualEnd?: string | null;
  correctedByAccountId: string;
}): Promise<InterventionExecutionRow | null> {
  const current = await getExecution(input.organizationId, input.executionId);
  if (!current || current.status === 'superseded') return null;

  const finalStatus = input.outcome ?? current.status;
  const newId = randomUUID();
  await queryOne(
    `insert into pilot.intervention_executions
       (organization_id, execution_id, lineage_id, version, supersedes_execution_id,
        athlete_id, decision_id, protocol_id, protocol_version, session_run_id,
        recorded_by_account_id, planned_start, actual_start, actual_end, status,
        planned_exposure, planned_task_context, actual_exposure, trained_context,
        task_constraint, partner_context, adherence, deviations, deviation_reason,
        stop_change_reason, notes, correction_reason)
     select organization_id, $3, lineage_id, version + 1, execution_id,
            athlete_id, decision_id, protocol_id, protocol_version, session_run_id,
            $4, planned_start, coalesce($5, actual_start), coalesce($6, actual_end), 'superseded',
            planned_exposure, planned_task_context,
            coalesce($7::jsonb, actual_exposure), coalesce($8, trained_context),
            coalesce($9, task_constraint), coalesce($10, partner_context),
            coalesce($11, adherence), coalesce($12, deviations), coalesce($13, deviation_reason),
            coalesce($14, stop_change_reason), coalesce($15, notes), $16
     from pilot.intervention_executions
     where organization_id = $1 and execution_id = $2
     returning execution_id`,
    [
      input.organizationId,
      input.executionId,
      newId,
      input.correctedByAccountId,
      input.actualStart ?? null,
      input.actualEnd ?? null,
      input.actualExposure === undefined ? null : JSON.stringify(input.actualExposure),
      input.trainedContext ?? null,
      input.taskConstraint ?? null,
      input.partnerContext ?? null,
      input.adherence ?? null,
      input.deviations ?? null,
      input.deviationReason ?? null,
      input.stopChangeReason ?? null,
      input.notes ?? null,
      input.correctionReason,
    ],
  );

  // Two steps under the one-current-record unique index: the correction is
  // born superseded, the original flips, then the correction takes the
  // lineage's final status. A crash between steps never leaves two current
  // records for one lineage.
  await queryOne(
    `update pilot.intervention_executions set status = 'superseded', updated_at = now()
     where organization_id = $1 and execution_id = $2 returning execution_id`,
    [input.organizationId, input.executionId],
  );
  await queryOne(
    `update pilot.intervention_executions set status = $3, updated_at = now()
     where organization_id = $1 and execution_id = $2 returning execution_id`,
    [input.organizationId, newId, finalStatus],
  );

  return getExecution(input.organizationId, newId);
}
