import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  adherenceError,
  closeExecution,
  correctExecution,
  getExecution,
  listExecutions,
  recordExecutionFacts,
  startExecution,
  trainedContextError,
  type AdherenceState,
  type ExecutionFactsInput,
  type TrainedContext,
} from '@/src/server/pilot/interventionExecutions';
import { exposureShapeError } from '@/src/server/pilot/interventionProtocols';

export const runtime = 'nodejs';

// Intervention executions (module 026 slice 2). Staff surface: what was
// ACTUALLY delivered against a protocol -- adherence, deviations, stop
// reasons. Recording an execution asserts only that work happened; it
// carries no verdict about whether the intervention worked (that is slice
// 3's human review). Planned facts are snapshotted at start and no request
// through this route can modify them afterwards.
//
// Being staff is not being THIS athlete's staff: every athlete_id here goes
// through assertActorCanAccessAthlete, the same central gate the attempts
// ledger uses, and an unfiltered read is scoped to the athletes the caller
// may reach rather than the organization's whole ledger.

const EXECUTION_ROLES = ['coach', 'organization_admin', 'admin'] as const;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function parseFacts(body: Record<string, unknown>): ExecutionFactsInput {
  const exposure = body.actual_exposure as Record<string, number> | undefined;
  const exposureError = exposureShapeError(exposure);
  if (exposureError) throw new ValidationError(exposureError.replace('intended_exposure', 'actual_exposure'));
  const adherenceProblem = adherenceError(body.adherence);
  if (adherenceProblem) throw new ValidationError(adherenceProblem);
  const contextProblem = trainedContextError(body.trained_context);
  if (contextProblem) throw new ValidationError(contextProblem);
  // The database refuses unnamed deviations too; refusing here gives the
  // coach the reason instead of a 500.
  if (body.adherence === 'delivered_with_deviations' && !optionalString(body.deviations)?.trim()) {
    throw new ValidationError("adherence 'delivered_with_deviations' requires naming the deviations.");
  }
  return {
    actualExposure: exposure,
    trainedContext: optionalString(body.trained_context) as TrainedContext | undefined,
    taskConstraint: optionalString(body.task_constraint),
    partnerContext: optionalString(body.partner_context),
    adherence: optionalString(body.adherence) as AdherenceState | undefined,
    deviations: optionalString(body.deviations),
    deviationReason: optionalString(body.deviation_reason),
    notes: optionalString(body.notes),
    actualStart: optionalString(body.actual_start),
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...EXECUTION_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() || undefined;
    if (athleteId) await assertActorCanAccessAthlete(principal, athleteId);

    let items = await listExecutions(principal.organizationId, athleteId);
    if (!athleteId) {
      const allowed = await accessibleAthleteIds(principal, items.map((item) => item.athlete_id));
      items = items.filter((item) => allowed.has(item.athlete_id));
    }
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...EXECUTION_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const athleteId = optionalString(body.athlete_id)?.trim();
    const protocolId = optionalString(body.protocol_id)?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);
    if (!protocolId) throw new ValidationError('Missing protocol_id.');

    const item = await startExecution({
      organizationId: principal.organizationId,
      athleteId,
      protocolId,
      decisionId: optionalString(body.decision_id)?.trim() || null,
      sessionRunId: optionalString(body.session_run_id)?.trim() || null,
      plannedStart: optionalString(body.planned_start) || null,
      actualStart: optionalString(body.actual_start) || null,
      recordedByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'intervention_execution',
      entity_id: item.execution_id,
      details: {
        protocol_id: item.protocol_id,
        protocol_version: item.protocol_version,
        athlete_id: item.athlete_id,
        decision_id: item.decision_id,
      },
    });
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...EXECUTION_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const executionId = optionalString(body.execution_id)?.trim();
    if (!executionId) throw new ValidationError('Missing execution_id.');

    // GET and POST both gate on the athlete (lines 73, 95); PATCH did not, so
    // any coach could record/close/correct ANY execution in the org -- an
    // intervention record for a child they have no relationship to -- by
    // naming its execution_id. record/close key their UPDATE on
    // (org, execution_id) with no athlete predicate, and correct supersedes by
    // lineage, so the org scope alone was the only barrier. Resolve the
    // execution's athlete and run it through the same central gate before any
    // action. A hidden-not-found (not a 403) for an id in another org keeps
    // this from being an existence oracle, matching the reads.
    const target = await getExecution(principal.organizationId, executionId);
    if (!target) return hiddenNotFound();
    await assertActorCanAccessAthlete(principal, target.athlete_id);

    // One act per call: record facts, close, or correct.
    if (body.action === 'record') {
      const item = await recordExecutionFacts({
        ...parseFacts(body),
        organizationId: principal.organizationId,
        executionId,
      });
      if (!item) return hiddenNotFound();
      await auditUpdate(principal, item.execution_id, { action: 'record' });
      return NextResponse.json({ item });
    }

    if (body.action === 'close') {
      const outcome = body.outcome;
      if (outcome !== 'completed' && outcome !== 'stopped') {
        throw new ValidationError("outcome must be 'completed' or 'stopped'.");
      }
      const stopChangeReason = optionalString(body.stop_change_reason);
      if (outcome === 'stopped' && !stopChangeReason?.trim()) {
        throw new ValidationError('Stopping an execution requires stop_change_reason.');
      }
      const item = await closeExecution({
        ...parseFacts(body),
        organizationId: principal.organizationId,
        executionId,
        outcome,
        stopChangeReason,
        actualEnd: optionalString(body.actual_end) || null,
      });
      if (!item) return hiddenNotFound();
      await auditUpdate(principal, item.execution_id, { action: 'close', outcome, adherence: item.adherence });
      return NextResponse.json({ item });
    }

    if (body.action === 'correct') {
      const correctionReason = optionalString(body.correction_reason)?.trim();
      if (!correctionReason) {
        throw new ValidationError('A correction requires correction_reason -- unexplained rewrites are refused.');
      }
      const outcome = optionalString(body.outcome);
      if (outcome !== undefined && !['in_progress', 'completed', 'stopped'].includes(outcome)) {
        throw new ValidationError("outcome must be 'in_progress', 'completed', or 'stopped'.");
      }
      const item = await correctExecution({
        ...parseFacts(body),
        organizationId: principal.organizationId,
        executionId,
        correctionReason,
        outcome: outcome as 'in_progress' | 'completed' | 'stopped' | undefined,
        stopChangeReason: optionalString(body.stop_change_reason),
        actualEnd: optionalString(body.actual_end) || null,
        correctedByAccountId: principal.accountId,
      });
      if (!item) return hiddenNotFound();
      await auditUpdate(principal, item.execution_id, {
        action: 'correct',
        lineage_id: item.lineage_id,
        version: item.version,
        supersedes: executionId,
        correction_reason: correctionReason,
      });
      return NextResponse.json({ item });
    }

    throw new ValidationError("action must be 'record', 'close', or 'correct'.");
  } catch (error) {
    return jsonError(error);
  }
}

async function auditUpdate(
  principal: PilotPrincipal,
  executionId: string,
  details: Record<string, unknown>,
) {
  await writePilotAuditEvent({
    event_type: 'update',
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: 'intervention_execution',
    entity_id: executionId,
    details,
  });
}
