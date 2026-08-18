import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { createShadowResearchRequirement, listShadowResearchRequirements, resolveShadowResearchRequirement } from '@/src/server/pilot/shadowResearch';
import { ORGANIZATION_MEMBER_ROLES, SHADOW_PROJECTION_READ_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Shared by GET (list) and POST resolve -- a parent may only see or resolve
// requirements tied to their own linked athletes, never any family in the
// org. Returns [] (not undefined) when the parent has no linked athletes at
// all, so callers can short-circuit instead of querying with an unbounded
// filter.
async function resolveParentAthleteScope(organizationId: string, accountId: string): Promise<string[]> {
  return guardianAthleteIds(organizationId, accountId);
}

async function handleList(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PROJECTION_READ_ROLES]);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_research_requirements'] });

    let athleteScope: string[] | undefined;

    if (principal.role === 'parent') {
      athleteScope = await resolveParentAthleteScope(principal.organizationId, principal.accountId);
      if (athleteScope.length === 0) {
        return NextResponse.json({ ok: true, organization_id: principal.organizationId, items: [] });
      }
    }

    const items = await listShadowResearchRequirements(principal.organizationId, {
      athleteIds: athleteScope,
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(request: NextRequest) {
  return handleList(request);
}

// Creating and resolving research requirements is an in-organization authoring
// act, so platform_owner is deliberately excluded here even though it can read
// the list above. Omega observes knowledge gaps; it does not author them.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ORGANIZATION_MEMBER_ROLES]);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_research_requirements'] });

    const body = (await request.json().catch(() => ({}))) as {
      action?: 'create' | 'resolve';
      research_requirement_id?: number;
      source_event_name?: string;
      source_entity_type?: string;
      source_entity_id?: string;
      research_requirement?: string;
      knowledge_gap?: string;
      evidence_label?: string | null;
      source_status?: string;
      source_confidence_tier?: 'SUFFICIENT_FOR_LOW_RISK_ACTION' | 'SUFFICIENT_FOR_REVIEW' | 'LIMITED' | 'CONFLICTED' | 'INSUFFICIENT' | 'NOT_APPLICABLE';
      source_verification_state?: 'verified' | 'partially_verified' | 'unverified' | 'unknown';
      metadata?: Record<string, unknown>;
      subject_id?: unknown;
    };

    if (body.subject_id !== undefined && body.subject_id !== null && typeof body.subject_id !== 'string') {
      return NextResponse.json({ ok: false, error: 'subject_id must be a string' }, { status: 400 });
    }

    if (body.action === 'resolve') {
      if (!body.research_requirement_id) {
        return NextResponse.json({ ok: false, error: 'missing research_requirement_id' }, { status: 400 });
      }

      // A parent may only resolve requirements tied to their own linked
      // athletes -- without this, any parent in the org could resolve any
      // other family's open requirement (list scoping alone doesn't stop a
      // direct POST with a guessed/enumerated id).
      let athleteScope: string[] | undefined;
      if (principal.role === 'parent') {
        athleteScope = await resolveParentAthleteScope(principal.organizationId, principal.accountId);
        if (athleteScope.length === 0) {
          return NextResponse.json({ ok: false, error: 'Requirement not found' }, { status: 404 });
        }
      }

      const resolved = await resolveShadowResearchRequirement({
        organizationId: principal.organizationId,
        researchRequirementId: body.research_requirement_id,
        resolvedByAccountId: principal.accountId,
        resolvedByRole: principal.role,
        metadata: body.metadata ?? {},
        athleteIds: athleteScope,
      });

      if (!resolved) {
        return NextResponse.json({ ok: false, error: 'Requirement not found' }, { status: 404 });
      }

      return NextResponse.json({ ok: true, resolved });
    }

    if (body.source_event_name && body.source_entity_type && body.source_entity_id && body.research_requirement && body.knowledge_gap) {
      // A subject_id makes this requirement athlete-scoped -- the same
      // write-time boundary /shadow/library/documents already enforces for
      // subject-scoped evidence. A blank string is treated as absent rather
      // than as a subject.
      const subjectId = (body.subject_id as string | null | undefined)?.trim() || null;
      if (subjectId) {
        await assertActorCanAccessAthlete(principal, subjectId);
      }

      const id = await createShadowResearchRequirement({
        organizationId: principal.organizationId,
        sourceEventName: body.source_event_name,
        sourceEntityType: body.source_entity_type,
        sourceEntityId: body.source_entity_id,
        researchRequirement: body.research_requirement,
        knowledgeGap: body.knowledge_gap,
        evidenceLabel: body.evidence_label ?? null,
        subjectId,
        sourceStatus: body.source_status ?? 'observed',
        sourceConfidenceTier: body.source_confidence_tier ?? 'SUFFICIENT_FOR_REVIEW',
        sourceVerificationState: body.source_verification_state ?? 'unknown',
        createdByAccountId: principal.accountId,
        createdByRole: principal.role,
        metadata: body.metadata ?? {},
      });

      return NextResponse.json({ ok: true, research_requirement_id: id });
    }

    return NextResponse.json({ ok: false, error: 'missing research requirement fields' }, { status: 400 });
  } catch (error) {
    return jsonError(error);
  }
}