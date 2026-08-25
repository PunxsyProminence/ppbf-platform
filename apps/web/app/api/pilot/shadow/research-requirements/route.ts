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
  getShadowResearchRequirementById,
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

type SubjectBearingRow = Pick<ShadowResearchRequirementRow, 'subject_id' | 'metadata'>;

// The metadata keys that name an athlete, in the same priority order the
// subject resolution uses. Named once so the read scope, the create gate and
// the resolve gate cannot end up disagreeing about which keys count.
const SUBJECT_NAMING_METADATA_KEYS = ['subject_id', 'athlete_id'] as const;

function namedAthleteId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Every athlete id a row NAMES, in priority order, deduplicated.
 *
 * subjectAthleteIdOf below answers "who is this row about" and takes the first
 * of these. This one answers the different question the WRITE paths need:
 * "which athletes does this row touch at all". They differ when the fields
 * disagree -- subject_id says one child and metadata.athlete_id another -- and
 * on a write every one of them has to be authorized, because whichever the
 * reader later believes, the row will have been filed against a child.
 */
function namedAthleteIdsOf(row: SubjectBearingRow): string[] {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const candidates = [
    namedAthleteId(row.subject_id),
    ...SUBJECT_NAMING_METADATA_KEYS.map((key) => namedAthleteId(metadata[key])),
  ].filter((athleteId): athleteId is string => athleteId !== null);
  return Array.from(new Set(candidates));
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
function subjectAthleteIdOf(row: SubjectBearingRow): string | null {
  return namedAthleteIdsOf(row)[0] ?? null;
}

/**
 * The single refusal for "no such requirement for you".
 *
 * One response for an id that does not exist, an id in another organization,
 * and an id whose subject this actor may not reach. research_requirement_id
 * is a bigserial, so telling those three apart is exactly what an enumerating
 * caller wants; http.ts's hiddenNotFound() exists for the same reason. The
 * body keeps the shape this route already returned for a refused parent, so
 * the existing client path is unchanged.
 */
function requirementNotFound(): NextResponse {
  return NextResponse.json({ ok: false, error: 'Requirement not found' }, { status: 404 });
}

/**
 * Would this caller-supplied resolve metadata change which athlete the stored
 * row is about?
 *
 * Tested on KEY PRESENCE, not just on value, because both directions are
 * harmful: naming a different child moves the row (and its free-text notes)
 * into another family's view, while naming null or a blank unbinds the row
 * into org-wide data that volunteer and staff accounts may read. Restating
 * the subject the row already has is a no-op and stays allowed, so a client
 * that echoes the row back is not broken by this.
 */
function metadataWouldRepointSubject(
  metadata: Record<string, unknown> | undefined,
  currentSubjectAthleteId: string | null,
): boolean {
  if (!metadata) {
    return false;
  }

  return SUBJECT_NAMING_METADATA_KEYS.some(
    (key) => key in metadata && namedAthleteId(metadata[key]) !== currentSubjectAthleteId,
  );
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
          return requirementNotFound();
        }
      }

      // THE STORED ROW, not the request body, decides who this is about.
      //
      // Until now `athleteScope` was set for `role === 'parent'` and for
      // nobody else, so for every other admitted role the UPDATE's athlete
      // predicate collapsed to a no-op and the only bound left was the
      // organization. research_requirement_id is a bigserial, so an id is
      // reached by counting rather than by being leaked: a coach with no
      // assignment at all, an athlete, a volunteer or a staff account could
      // POST an enumerated id and mark ANY child's requirement handled --
      // including the intake approve/reject/promote follow-ups written by
      // app/api/pilot/intake/review-action/route.ts. The record then says a
      // safeguarding-adjacent item about a child was dealt with, when nobody
      // entitled to deal with it did. That is an integrity failure, and it
      // survives the read fix above precisely because it never needed the
      // read.
      const stored = await getShadowResearchRequirementById(
        principal.organizationId,
        body.research_requirement_id,
      );

      if (!stored) {
        return requirementNotFound();
      }

      const subjectAthleteId = subjectAthleteIdOf(stored);

      if (subjectAthleteId === null) {
        // A row that names no athlete is org-wide operational work (a
        // capability-coverage gap, an upload classification, a learning-loop
        // gap) and stays closable by the in-organization roles this route
        // admits. Parents are the exception, and only to preserve exactly
        // what they could do before: their athleteIds scope has always
        // matched on subject_id, which never matches a subject-less row, and
        // the list they read is scoped the same way. Widening a guardian to
        // the gym's doctrine backlog is not this fix's business.
        if (principal.role === 'parent') {
          return requirementNotFound();
        }
      } else {
        // The one central relationship gate, evaluated against the STORED
        // subject: assignment of record, an active and unexpired
        // coach_coverage grant (so a lapsed grant, or one cut short with
        // revokeCoachCoverage, stops admitting the substitute here the moment
        // it stops admitting them anywhere else), a guardian's own
        // dependents, an athlete's own record -- and nothing at all for
        // volunteer, staff or board.
        try {
          await assertActorCanAccessAthlete(principal, subjectAthleteId);
        } catch (error) {
          // Refused as "not found", identical to a genuinely absent id. With
          // sequential ids, a distinct 403 would turn this route into an
          // enumeration oracle telling an attacker exactly which ids exist
          // and which name a child -- the reason http.ts carries
          // hiddenNotFound() at all. Only an authorization refusal is
          // translated; anything else still propagates.
          if (error instanceof Error && error.message.startsWith('Forbidden')) {
            return requirementNotFound();
          }
          throw error;
        }
      }

      // Only now, after the caller is known to be entitled to this row.
      // `metadata` is merged into the stored row (metadata || $3::jsonb), and
      // subject_id/athlete_id inside it are two of the three fields the
      // subject resolution reads. So an unguarded resolve could REPOINT the
      // row on its way out: pass {athlete_id: 'other-child'} and a legacy row
      // -- one whose subject_id column is NULL because the migration's
      // backfill never read metadata.athlete_id -- leaves the family it
      // belongs to and lands, notes and all, in another family's view; pass
      // {athlete_id: null} and it unbinds entirely, becoming org-wide data
      // every volunteer and staff account may read. Resolving a requirement
      // is closing it, not re-filing it against a different child.
      //
      // Ordered after the gate on purpose: an unauthorized caller must get
      // the same 404 whatever they sent, or the distinct 400 tells them the
      // row exists and what its subject is not.
      if (metadataWouldRepointSubject(body.metadata, subjectAthleteId)) {
        return NextResponse.json(
          { ok: false, error: 'resolve metadata cannot change which athlete a requirement is about' },
          { status: 400 },
        );
      }

      // Authorize-and-write as ONE statement: the subject just authorized is
      // carried into the UPDATE's WHERE, so a row whose subject changed
      // between the read above and this write matches nothing and is left
      // alone. A check-then-write with a gap between them is the TOCTOU shape
      // #624, #630 and #648 already closed elsewhere in this codebase.
      const resolved = await resolveShadowResearchRequirement({
        organizationId: principal.organizationId,
        researchRequirementId: body.research_requirement_id,
        resolvedByAccountId: principal.accountId,
        resolvedByRole: principal.role,
        metadata: body.metadata ?? {},
        athleteIds: athleteScope,
        expectedSubjectAthleteId: subjectAthleteId,
      });

      if (!resolved) {
        return requirementNotFound();
      }

      return NextResponse.json({ ok: true, resolved });
    }

    if (body.source_event_name && body.source_entity_type && body.source_entity_id && body.research_requirement && body.knowledge_gap) {
      // A subject_id makes this requirement athlete-scoped -- the same
      // write-time boundary /shadow/library/documents already enforces for
      // subject-scoped evidence. A blank string is treated as absent rather
      // than as a subject.
      const subjectId = (body.subject_id as string | null | undefined)?.trim() || null;

      // ...but the column is not the only field that names a child. The
      // subject resolution falls back to metadata.subject_id and
      // metadata.athlete_id because the writers that predate the subject_id
      // column name their athlete only there, and `metadata` is caller-
      // supplied on this route. Gating on the column alone let any admitted
      // role file a requirement -- free-text research_requirement and
      // knowledge_gap of their choosing -- against a child they have no
      // relationship with, simply by putting the athlete id in metadata and
      // leaving subject_id out. Every athlete this row will name has to be
      // one the actor can reach, whichever field names it.
      for (const athleteId of namedAthleteIdsOf({ subject_id: subjectId, metadata: body.metadata ?? {} })) {
        await assertActorCanAccessAthlete(principal, athleteId);
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