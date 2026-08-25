import { NextResponse, type NextRequest } from 'next/server';

import {
  accessibleAthleteIds,
  assertActorCanAccessAthlete,
  isOrganizationAdminRole,
  requireRole,
  type ActorIdentity,
} from '@/src/server/pilot/access';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  createShadowResearchRequirement,
  listShadowResearchRequirements,
  resolveShadowResearchRequirement,
  type ShadowResearchRequirementRow,
} from '@/src/server/pilot/shadowResearch';
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

/**
 * The athlete a requirement row is ABOUT, or null when it is about no one.
 *
 * `subject_id` is the authority -- the dedicated column added by
 * pilot_slice_postgres_research_requirement_subject_migration.sql precisely so
 * that "which child is this row about" stops being guessed. The two metadata
 * fallbacks are NOT the discredited 3-field heuristic that migration replaced:
 * that heuristic also read `evidence_label` and `source_entity_id`, which at
 * almost every creation site hold something that is not an athlete id at all
 * (a capability key, an intake-case id, a learning-loop message id). These two
 * keys are different -- each is written by exactly one family of writers that
 * held the athlete id at write time and put it there:
 *
 *   metadata.subject_id  shadowLibrary.ts ensureClaimResearchRequirement
 *   metadata.athlete_id  the three intake review writers in
 *                        app/api/pilot/intake/review-action/route.ts
 *
 * metadata.athlete_id matters most, because the migration's backfill does not
 * read it (its candidate list is metadata.subject_id, evidence_label,
 * source_entity_id). Every intake-review row written before that migration's
 * application companion therefore carries the athlete only in metadata, with
 * subject_id NULL -- and those are the rows holding a reviewer's free-text
 * note on approving or rejecting a child's intake case. Scoping on the column
 * alone would leave exactly the most sensitive rows uncovered.
 *
 * Fails closed: anything non-string or blank reads as "names no athlete",
 * which keeps genuinely org-wide rows (capability-coverage gaps, upload
 * classifications, learning-loop gaps) visible to every role allowed here.
 */
function subjectAthleteIdOf(row: ShadowResearchRequirementRow): string | null {
  const named = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return named(row.subject_id) ?? named(metadata.subject_id) ?? named(metadata.athlete_id);
}

/**
 * Athlete-scope a page of requirements to what this actor may actually reach.
 *
 * Same shape as the coach audit read (#623): a row that names an athlete is
 * kept only if the actor can reach that athlete through the ONE central
 * relationship gate (accessibleAthleteIds -- assignment of record UNION an
 * active, unexpired coach_coverage grant, a guardian's own dependents, an
 * athlete's own record, and nothing at all for volunteer/staff/platform_owner);
 * a row that names no athlete is org-wide operational data and is kept.
 *
 * Organization admins administer the whole gym's records, so their reach and
 * the organization predicate the query already carries are the same set --
 * they are never post-filtered, and never consult the relationship gate.
 *
 * Evaluated on every read, so a coverage grant that has lapsed or been cut
 * short with revokeCoachCoverage stops admitting the substitute here the
 * moment it stops admitting them anywhere else.
 */
async function scopeToReachableSubjects(
  actor: ActorIdentity,
  rows: ShadowResearchRequirementRow[],
): Promise<ShadowResearchRequirementRow[]> {
  if (isOrganizationAdminRole(actor.role)) {
    return rows;
  }

  const namedAthleteIds = rows
    .map((row) => subjectAthleteIdOf(row))
    .filter((athleteId): athleteId is string => athleteId !== null);

  if (namedAthleteIds.length === 0) {
    return rows;
  }

  const reachable = await accessibleAthleteIds(actor, namedAthleteIds);
  return rows.filter((row) => {
    const athleteId = subjectAthleteIdOf(row);
    return athleteId === null || reachable.has(athleteId);
  });
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

    // The organization predicate above is NOT the access boundary for most of
    // the roles this route admits. SHADOW_PROJECTION_READ_ROLES is every seat
    // in the organization plus platform_owner, and only the parent branch was
    // ever scoped -- so a coach read every child's intake-review requirement
    // regardless of assignment, an athlete read every other athlete's, a
    // volunteer or staff account read all of them, and platform_owner (which
    // assertActorCanAccessAthlete refuses outright for any athlete record, and
    // which shadowRoleSets.ts documents must never reach an organization's
    // athlete depth) read them across every gym it can sign into.
    //
    // The parent branch's SQL scope above is deliberately left in place: it
    // returns ONLY subject-bearing rows for that guardian's own children, and
    // widening a parent to the org-wide rows is not this fix's business. This
    // filter then applies to every role uniformly, parents included.
    const scoped = await scopeToReachableSubjects(principal, items);

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, items: scoped });
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