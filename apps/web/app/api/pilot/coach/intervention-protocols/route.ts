import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  exposureShapeError,
  createProtocol,
  listProtocols,
  reviseProtocol,
  retireProtocol,
  type ProtocolContentInput,
} from '@/src/server/pilot/interventionProtocols';

export const runtime = 'nodejs';

// Intervention protocols (module 026 slice 1). Staff surface: coaches and
// admins author and read intent. Nothing here executes anything -- a
// protocol is a stated hypothesis and plan, and recording one changes no
// athlete's training by itself (execution is slice 2, behind its own human
// acts). Athlete-specific protocols never auto-generalize.
//
// An athlete-specific protocol names the athlete and states a hypothesis
// about them, so writing one is authorized per athlete
// (assertActorCanAccessAthlete) and the list returns only the
// athlete-specific rows the caller may reach. Protocols with no athlete are
// gym doctrine and stay visible to every staff reader.

const PROTOCOL_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function parseContent(body: Record<string, unknown>): ProtocolContentInput {
  const required = (key: string): string => {
    const value = body[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new ValidationError(`Missing ${key}.`);
    }
    return value.trim();
  };
  const exposure = body.intended_exposure as Record<string, number> | undefined;
  const exposureError = exposureShapeError(exposure);
  if (exposureError) throw new ValidationError(exposureError);

  return {
    title: required('title'),
    targetProblem: required('target_problem'),
    hypothesis: required('hypothesis'),
    interventionDescription: required('intervention_description'),
    intendedTaskContext: typeof body.intended_task_context === 'string' ? body.intended_task_context : undefined,
    intendedExposure: exposure,
    expectedOutcome: required('expected_outcome'),
    contradictingEvidence: typeof body.contradicting_evidence === 'string' ? body.contradicting_evidence : undefined,
    alternativeExplanations: typeof body.alternative_explanations === 'string' ? body.alternative_explanations : undefined,
    evaluationPlan: typeof body.evaluation_plan === 'string' ? body.evaluation_plan : undefined,
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PROTOCOL_ROLES]);

    const rows = await listProtocols(principal.organizationId);
    const named = rows.map((row) => row.athlete_id).filter((id): id is string => id !== null);
    const allowed = await accessibleAthleteIds(principal, named);
    const items = rows.filter((row) => row.athlete_id === null || allowed.has(row.athlete_id));
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PROTOCOL_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const content = parseContent(body);
    const athleteId = typeof body.athlete_id === 'string' && body.athlete_id.trim() !== ''
      ? body.athlete_id.trim()
      : null;
    if (athleteId) await assertActorCanAccessAthlete(principal, athleteId);

    const item = await createProtocol({
      ...content,
      organizationId: principal.organizationId,
      athleteId,
      createdByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'intervention_protocol',
      entity_id: item.protocol_id,
      details: { lineage_id: item.lineage_id, version: item.version, athlete_id: item.athlete_id },
    });
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PROTOCOL_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const protocolId = typeof body.protocol_id === 'string' ? body.protocol_id.trim() : '';
    if (!protocolId) throw new ValidationError('Missing protocol_id.');

    // One act per call: retire, or revise (which is a full re-statement of
    // content -- a version is not a diff).
    if (body.action === 'retire') {
      const item = await retireProtocol(principal.organizationId, protocolId);
      if (!item) return hiddenNotFound();
      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'intervention_protocol',
        entity_id: item.protocol_id,
        details: { action: 'retire', lineage_id: item.lineage_id, version: item.version },
      });
      return NextResponse.json({ item });
    }
    if (body.action === 'revise') {
      const content = parseContent(body);
      const item = await reviseProtocol({
        ...content,
        organizationId: principal.organizationId,
        protocolId,
        revisedByAccountId: principal.accountId,
      });
      if (!item) return hiddenNotFound();
      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'intervention_protocol',
        entity_id: item.protocol_id,
        details: { action: 'revise', lineage_id: item.lineage_id, version: item.version, supersedes: protocolId },
      });
      return NextResponse.json({ item });
    }
    throw new ValidationError("action must be 'retire' or 'revise'.");
  } catch (error) {
    return jsonError(error);
  }
}
