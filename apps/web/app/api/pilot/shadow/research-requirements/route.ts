import { NextResponse, type NextRequest } from 'next/server';

import {
  accessibleAthleteIds,
  assertActorCanAccessAthlete,
  isOrganizationAdminRole,
  requireRole,
  type ActorIdentity,
} from '@/src/server/pilot/access';
import { deletedAthleteIdsAmong } from '@/src/server/pilot/deletedAthletes';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  createShadowResearchRequirement,
  CAPABILITY_GAP_SOURCE_ENTITY_TYPE,
  CAPABILITY_GAP_SOURCE_EVENT_NAME,
  COVERED_AFTER_RESOLUTION_KEY,
  getShadowResearchRequirementById,
  listShadowResearchRequirements,
  namedAthleteId,
  namedAthleteIdsOf,
  resolveShadowResearchRequirement,
  subjectAthleteIdOf,
  SUBJECT_NAMING_METADATA_KEYS,
  type ShadowResearchRequirementRow,
} from '@/src/server/pilot/shadowResearch';

// Requirement kinds only the server writes: the capability-coverage check's gap
// tickets and the Library claim path's. The research-bridge export reads the
// first, so a caller who could file one could send their own text out of the
// platform under it (CL-C5).
const SERVER_WRITTEN_EVENT_NAMES = new Set([CAPABILITY_GAP_SOURCE_EVENT_NAME, 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED']);
const SERVER_WRITTEN_ENTITY_TYPES = new Set([CAPABILITY_GAP_SOURCE_ENTITY_TYPE, 'shadow_library_claim']);
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

/* subjectAthleteIdOf / namedAthleteIdsOf now live in shadowResearch.ts.
   They moved because the research-submissions route needed the same answer and
   could not import it from here -- and, scoping on organization_id alone in
   its absence, let a guardian read staff notes on another child's
   requirement. One copy, two routes. */

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
 * Who sees and closes the gym's research questions and needs: the rows that
 * name no athlete.
 *
 * Those rows carry the asker's own words -- a Library question goes in as
 * metadata.question and knowledge_gap, a negative feedback note from the
 * learning loop as knowledge_gap and metadata.note -- and they were readable
 * by every role this route admits, so one family's question was readable by
 * every other family (CL-A3). They were also closable by every member but a
 * parent, and a person's resolution of a capability-gap ticket parks it until
 * that capability grades covered (CL-C14).
 *
 * RULING (Jason 2026-10-06, CL-A3): "Staff only" -- coaches and organization
 * admins see the gym's research questions and needs; everyone else sees only
 * their own. Closing one is the staff's call, so a member who can see their
 * own question still cannot close it.
 */
function isResearchStaff(role: ActorIdentity['role']): boolean {
  return role === 'coach' || isOrganizationAdminRole(role);
}

function mayReadSubjectlessRow(actor: ActorIdentity, row: ShadowResearchRequirementRow): boolean {
  return isResearchStaff(actor.role) || row.created_by_account_id === actor.accountId;
}

/**
 * Metadata keys the capability-coverage check writes and reads back.
 * `resolution` = 'capability_covered' marks a closure as the check's own, so it
 * may reopen the row; COVERED_AFTER_RESOLUTION_KEY says coverage happened since
 * a person closed it, which also lets it reopen. A caller writing either
 * steers how the check later treats the row; the other two are its closure
 * and reopen record. resolved_by_* are not listed: the write overwrites them.
 */
const COVERAGE_CHECK_METADATA_KEYS = [
  'resolution',
  COVERED_AFTER_RESOLUTION_KEY,
  'resolved_matched_sources',
  'reopened_after_resolution_at',
] as const;

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
 *
 * A value that is not cleanly a string or null (see subjectValueIsUnambiguous)
 * counts as a repoint whatever it is: TypeScript would read it as "names no
 * athlete" while the SQL that decides the write and the coverage check reads
 * it as a subject.
 */
function metadataWouldRepointSubject(
  metadata: Record<string, unknown> | undefined,
  currentSubjectAthleteId: string | null,
): boolean {
  if (!metadata) {
    return false;
  }

  return SUBJECT_NAMING_METADATA_KEYS.some(
    (key) =>
      key in metadata &&
      (!subjectValueIsUnambiguous(metadata[key]) || namedAthleteId(metadata[key]) !== currentSubjectAthleteId),
  );
}

/**
 * Do TypeScript and SQL agree on whether this metadata value names an athlete?
 *
 * namedAthleteId reads a non-string, or a string String.trim empties, as "no
 * athlete". The SQL subject resolution (resolveShadowResearchRequirement's
 * predicate, and namesNoAthleteSql behind the capability-coverage check) reads
 * `metadata->>'athlete_id'` through btrim, which renders 5 as '5' and strips
 * only spaces, so 5, true, {} or "\t" name an athlete there. A row carrying one
 * is shown as subject-less here and treated as about someone by the database:
 * a coverage ticket closed with {athlete_id: 5} is never reopened again, and a
 * row created with it can never be resolved. Only null and strings with no
 * surrounding whitespace read the same both ways.
 */
function subjectValueIsUnambiguous(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim() === value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Athlete-scope a page of requirements to what this actor may actually reach.
 *
 * Same shape as the coach audit read (#623): a row that names an athlete is
 * kept only if the actor can reach that athlete through the ONE central
 * relationship gate (accessibleAthleteIds -- assignment of record UNION an
 * active, unexpired coach_coverage grant, a guardian's own dependents, an
 * athlete's own record, and nothing at all for volunteer/staff/platform_owner);
 * a row that names no athlete is the gym's research backlog and is kept for
 * staff, and for anyone else only if they filed it (mayReadSubjectlessRow).
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
    // The whole gym -- except a deleted athlete, whose requirements are
    // marked deleted with them (scope B). Every other role already loses
    // them through accessibleAthleteIds below.
    const deleted = await deletedAthleteIdsAmong(
      actor.organizationId,
      rows
        .map((row) => subjectAthleteIdOf(row))
        .filter((athleteId): athleteId is string => athleteId !== null),
    );
    return rows.filter((row) => {
      const athleteId = subjectAthleteIdOf(row);
      return athleteId === null || !deleted.has(athleteId);
    });
  }

  const namedAthleteIds = rows
    .map((row) => subjectAthleteIdOf(row))
    .filter((athleteId): athleteId is string => athleteId !== null);

  const reachable = namedAthleteIds.length > 0
    ? await accessibleAthleteIds(actor, namedAthleteIds)
    : new Set<string>();
  return rows.filter((row) => {
    const athleteId = subjectAthleteIdOf(row);
    return athleteId === null ? mayReadSubjectlessRow(actor, row) : reachable.has(athleteId);
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

    // Both branches merge `metadata` into a jsonb row and test keys with `in`,
    // which throws on a string or number (a 500, not a 400). Checked before
    // any row is read, so it says nothing about whether one exists.
    if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
      return NextResponse.json({ ok: false, error: 'metadata must be an object' }, { status: 400 });
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
        // A row that names no athlete is the gym's research backlog (a
        // capability-coverage gap, an upload classification, a Library
        // question, a learning-loop gap). Only staff close it (CL-C14,
        // isResearchStaff). Anyone else who cannot see it gets the same 404
        // as a missing id; one who can see it because they filed it is told
        // plainly that closing it is not theirs. Parents keep the 404 they
        // always got: their list is scoped by subject_id, so they never see a
        // subject-less row, even their own.
        if (!isResearchStaff(principal.role)) {
          if (principal.role === 'parent' || !mayReadSubjectlessRow(principal, stored)) {
            return requirementNotFound();
          }
          return NextResponse.json(
            { ok: false, error: 'Forbidden: only coaches and organization admins close research requirements' },
            { status: 403 },
          );
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

      // CL-C14: the coverage check's own markers are the server's to write.
      // Only resolved_by_* were protected (the write puts them last); a
      // caller could still set resolution = 'capability_covered' or
      // covered_after_resolution_at and so decide whether the check later
      // reopens the row or leaves it closed. Same placement as above: after
      // the gate, so an unentitled caller still gets the plain 404.
      const metadata = body.metadata ?? {};
      const reservedKey = COVERAGE_CHECK_METADATA_KEYS.find((key) => key in metadata);
      if (reservedKey) {
        return NextResponse.json(
          { ok: false, error: `resolve metadata cannot set ${reservedKey}; the coverage check writes it` },
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
      if (SERVER_WRITTEN_EVENT_NAMES.has(body.source_event_name) || SERVER_WRITTEN_ENTITY_TYPES.has(body.source_entity_type)) {
        return NextResponse.json(
          { ok: false, error: 'this kind of research requirement is written only by SHADOW itself' },
          { status: 400 },
        );
      }

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
      // one the actor can reach, whichever field names it -- and the field has
      // to name it the same way to TypeScript and to SQL, or the gate below
      // is skipped for a row the database treats as about someone.
      const createMetadata = body.metadata ?? {};
      if (SUBJECT_NAMING_METADATA_KEYS.some((key) => key in createMetadata && !subjectValueIsUnambiguous(createMetadata[key]))) {
        return NextResponse.json(
          { ok: false, error: 'metadata subject_id and athlete_id must be a trimmed string or null' },
          { status: 400 },
        );
      }

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