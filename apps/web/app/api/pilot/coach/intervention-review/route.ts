import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  evidenceRoleError,
  getActiveReview,
  getDecisionTexts,
  getEvidenceLinkOwner,
  hypothesisResultError,
  learningSignalError,
  linkEvidence,
  listEvidence,
  performanceResultError,
  removeEvidence,
  reviewOutcome,
  sourceKindError,
  type EvidenceRole,
  type EvidenceSourceKind,
  type HypothesisResult,
  type LearningSignal,
  type PerformanceResult,
} from '@/src/server/pilot/interventionEvidence';
import { getExecution, listExecutions } from '@/src/server/pilot/interventionExecutions';

export const runtime = 'nodejs';

// Intervention review (module 026 slice 3). The loop-closing staff
// surface: DECISION -> PLANNED -> ACTUAL -> WHAT HAPPENED -> WHAT WE
// LEARNED. Everything here is a recorded human judgment -- no verdict is
// computed, no causal claim is made, and the failure-learning rules
// (a miss cannot validate success; confounded evidence strengthens
// nothing) are enforced by the module and the database beneath it.
//
// The read is per-athlete authorized, not merely staff-authorized: a
// supplied athlete_id goes through assertActorCanAccessAthlete, and an
// unfiltered read returns only executions whose athlete the caller may
// reach -- these rows carry the decision narrative and its linked evidence.
//
// Every WRITE here is authorized the same way, on the athlete the target row
// is STORED against rather than on anything the caller supplied: the POST
// resolves its execution's athlete, and the PATCH resolves the athlete behind
// the evidence link it is asked to strike. A staff role reaches this surface;
// it does not by itself reach a given child's record on it.

const REVIEW_ROLES = ['coach', 'organization_admin', 'admin'] as const;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() || undefined;
    if (athleteId) await assertActorCanAccessAthlete(principal, athleteId);

    let executions = await listExecutions(principal.organizationId, athleteId);
    if (!athleteId) {
      const allowed = await accessibleAthleteIds(principal, executions.map((item) => item.athlete_id));
      executions = executions.filter((item) => allowed.has(item.athlete_id));
    }
    const decisionTexts = new Map(
      (await getDecisionTexts(principal.organizationId, executions.map((e) => e.execution_id)))
        .map((row) => [row.execution_id, row.decision_text]),
    );
    const items = await Promise.all(executions.map(async (execution) => ({
      execution,
      decision_text: decisionTexts.get(execution.execution_id) ?? null,
      evidence: await listEvidence(principal.organizationId, execution.execution_id),
      review: await getActiveReview(principal.organizationId, execution.execution_id),
    })));
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const executionId = optionalString(body.execution_id)?.trim();
    if (!executionId) throw new ValidationError('Missing execution_id.');

    // The GET is per-athlete authorized (line 53); this POST was not, so any
    // coach could link evidence to, or file an outcome review on, ANY
    // execution in the org -- attaching a source or a recorded judgment to an
    // intervention for a child they have no relationship to -- by naming its
    // execution_id. linkEvidence/reviewOutcome key on (org, execution_id)
    // only. Resolve the execution's athlete and run it through the same
    // central gate the read uses, before either action. hidden-not-found for
    // an id outside the org matches the read and avoids an existence oracle.
    const target = await getExecution(principal.organizationId, executionId);
    if (!target) return hiddenNotFound();
    await assertActorCanAccessAthlete(principal, target.athlete_id);

    if (body.action === 'link_evidence') {
      const roleProblem = evidenceRoleError(body.evidence_role);
      if (roleProblem) throw new ValidationError(roleProblem);
      const kindProblem = sourceKindError(body.source_kind);
      if (kindProblem) throw new ValidationError(kindProblem);
      const sourceId = optionalString(body.source_id)?.trim();
      if (!sourceId) throw new ValidationError('Missing source_id.');

      const item = await linkEvidence({
        organizationId: principal.organizationId,
        executionId,
        evidenceRole: body.evidence_role as EvidenceRole,
        sourceKind: body.source_kind as EvidenceSourceKind,
        sourceId,
        note: optionalString(body.note),
        linkedByAccountId: principal.accountId,
      });
      if (!item) return hiddenNotFound();
      await audit(principal, 'create', 'intervention_evidence_link', item.link_id, {
        execution_id: executionId,
        evidence_role: item.evidence_role,
        source_kind: item.source_kind,
        source_id: item.source_id,
      });
      return NextResponse.json({ item });
    }

    if (body.action === 'review_outcome') {
      for (const problem of [
        performanceResultError(body.performance_result),
        hypothesisResultError(body.hypothesis_result),
        learningSignalError(body.learning_signal),
      ]) {
        if (problem) throw new ValidationError(problem);
      }
      const performanceNotes = optionalString(body.performance_notes)?.trim();
      if (!performanceNotes) {
        throw new ValidationError('performance_notes is required -- what happened, in human words.');
      }

      const item = await reviewOutcome({
        organizationId: principal.organizationId,
        executionId,
        performanceResult: body.performance_result as PerformanceResult,
        performanceNotes,
        hypothesisResult: body.hypothesis_result as HypothesisResult,
        learningSignal: body.learning_signal as LearningSignal,
        learningNotes: optionalString(body.learning_notes),
        reviewedByAccountId: principal.accountId,
      });
      if (!item) return hiddenNotFound();
      await audit(principal, 'create', 'intervention_outcome_review', item.review_id, {
        execution_id: executionId,
        performance_result: item.performance_result,
        hypothesis_result: item.hypothesis_result,
        learning_signal: item.learning_signal,
        supersedes_review_id: item.supersedes_review_id,
      });
      return NextResponse.json({ item });
    }

    throw new ValidationError("action must be 'link_evidence' or 'review_outcome'.");
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    if (body.action !== 'remove_evidence') {
      throw new ValidationError("action must be 'remove_evidence'.");
    }
    const linkId = optionalString(body.link_id)?.trim();
    if (!linkId) throw new ValidationError('Missing link_id.');
    const removedReason = optionalString(body.removed_reason)?.trim();
    if (!removedReason) {
      throw new ValidationError('Removing evidence requires removed_reason -- links are stamped, never erased.');
    }

    // The GET is per-athlete authorized and the POST above was given the same
    // gate; this PATCH never had one. removeEvidence keyed on (org, link_id)
    // alone, so any coach in the organization could strike a link off an
    // intervention belonging to a child they have no standing on -- including
    // a 'counterevidence' or 'adverse_response' link, the record that a child
    // responded badly -- simply by naming its link_id. The id needs no
    // guessing: the GET hands out link_ids for every athlete a coach may
    // reach at the time, so a substitute whose coach_coverage grant has since
    // expired (or been revoked early) kept the ability to remove what they
    // saw while it was live. Expiry stopped bounding this write.
    //
    // Resolve the link's STORED owner -- the athlete of its stored execution,
    // never a caller-supplied one -- and run it through the same central gate
    // the read uses. hidden-not-found for a link outside the org matches the
    // POST and avoids an existence oracle; the gate's own 403 propagates,
    // exactly as it does on the POST.
    const owner = await getEvidenceLinkOwner(principal.organizationId, linkId);
    if (!owner) return hiddenNotFound();
    await assertActorCanAccessAthlete(principal, owner.athlete_id);

    const item = await removeEvidence({
      organizationId: principal.organizationId,
      linkId,
      removedReason,
      // Compare-and-set on the execution just authorized, so the check and
      // the write are one statement rather than two with a gap between them.
      expectedExecutionId: owner.execution_id,
    });
    if (!item) return hiddenNotFound();
    await audit(principal, 'update', 'intervention_evidence_link', item.link_id, {
      action: 'remove_evidence',
      removed_reason: removedReason,
    });
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

async function audit(
  principal: PilotPrincipal,
  eventType: 'create' | 'update',
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
) {
  await writePilotAuditEvent({
    event_type: eventType,
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: entityType,
    entity_id: entityId,
    details,
  });
}
