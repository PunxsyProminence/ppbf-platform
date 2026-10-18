import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { ForbiddenError, ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { parseLibraryShelf, resolveLibraryShelf } from '@/src/server/pilot/libraryShelf';
import { researchSubmissionsForReader } from '@/src/server/pilot/researchFamilyView';
import {
  getShadowResearchRequirementById,
  mayReadSubjectlessResearchRow,
  subjectAthleteIdOf,
  type ShadowResearchRequirementRow,
} from '@/src/server/pilot/shadowResearch';
import { roleEquals } from '@/src/server/pilot/roleAlias';
import {
  SHADOW_LIBRARY_CURATOR_ROLES,
  SHADOW_PROJECTION_READ_ROLES,
  SHADOW_SOURCE_ATTACH_ROLES,
} from '@/src/server/pilot/shadowRoleSets';
import {
  createResearchSubmission,
  deriveAnswerState,
  documentExistsInOrg,
  getAnswerStates,
  getRequirementStatusInOrg,
  getRequirementStatusesInOrg,
  isApplicabilityState,
  listSubmissionsForRequirement,
  reviewResearchSubmission,
  sourceExistsInOrg,
} from '@/src/server/pilot/shadowResearchSubmissions';

export const runtime = 'nodejs';

// The research-lifecycle link record (issue #345, slice 1).
//
// Read is projection-wide (same set as the research requirements the
// submissions hang off). Reviewing applicability is a CURATOR act -- the same
// authority that registers and approves library evidence. Writing a link
// (attaching an existing source) is open to coaches as well
// (OD-2026-10-08-005 A-Q13, ruling 6: "a coach may attach a source"): the
// link lands 'unreviewed' and answers nothing until a curator reviews it, so
// attaching is never approval. A coach attaches only to a requirement they
// may read, and attaches a source, not a document.
//
// Nothing in this route can resolve a requirement: there is no code path
// from here to shadow_research_requirements.status.
//
// Every method takes an optional `shelf` ('gym' default, or 'platform'; a
// query parameter on GET, a body field on POST and PATCH), resolved to an
// organization id by libraryShelf.ts like the sources, documents and chunks
// routes (#1115). Filing a source against a requirement and reviewing that
// link are Library writes: the platform owner does them on the platform
// shelf and no longer on a gym's (OD-2026-10-02-015 D3). Until 2026-10-03
// this route took principal.organizationId directly, so the platform owner
// could still write a gym's submissions through it. The existence checks
// below read the SAME resolved shelf as the write, so a platform-shelf
// submission can only name a platform-shelf requirement, source and document.

/**
 * MAY THIS ACTOR READ THE SUBMISSIONS ON THIS REQUIREMENT?
 *
 * A requirement row can NAME a child -- subject_id, or metadata.athlete_id --
 * and the submissions hanging off it carry `submission_note` and
 * `review_note`, which are a reviewer's free text about that child's intake
 * case. The sibling route (research-requirements) has scoped its reads to
 * reachable subjects since #623; this one scoped on organization_id alone.
 *
 * So a guardian could name any research_requirement_id -- a bigserial, and
 * the batch parameter below accepts 200 at a time -- and read staff notes on
 * a requirement about somebody else's child. That is the gap this closes.
 *
 * Same rule as the sibling: a row naming an athlete is readable only by an
 * actor who can reach that athlete through the one central relationship gate;
 * a row naming nobody is the gym's research backlog -- often a member's own
 * Library question -- and is readable by staff and by whoever filed it
 * (mayReadSubjectlessResearchRow; CL-A3, Jason 2026-10-06 "Staff only").
 * Organization admins administer the whole gym, so the organization predicate
 * the queries already carry is their reach.
 *
 * Answers the stored requirement when the actor may read it, null when not:
 * the read shapes what it returns by that row (an asker's question, F-054).
 */
async function readableRequirement(
  actor: { accountId: string; role: PilotRole; organizationId: string; athleteId: string | null },
  requirementId: number,
  onPlatformShelf: boolean,
): Promise<ShadowResearchRequirementRow | null> {
  // The row is read for the organization admin too: a marked-deleted asker's
  // question is unreachable by id for everyone (getShadowResearchRequirementById
  // answers null for it, F-054), and an id that names nothing is refused the
  // same way a missing row always was (hiddenNotFound).
  const requirement = await getShadowResearchRequirementById(actor.organizationId, requirementId);
  if (!requirement) {
    return null;
  }

  if (isOrganizationAdminRole(actor.role)) {
    return requirement;
  }

  const subjectAthleteId = subjectAthleteIdOf(requirement);
  if (subjectAthleteId === null) {
    // The platform shelf is the platform owner's own Library, where it is the
    // curator (OD-2026-10-02-015 D3); resolveLibraryShelf has already refused
    // that shelf to everyone else, and no gym member's words are on it.
    return onPlatformShelf || mayReadSubjectlessResearchRow(actor, requirement) ? requirement : null;
  }

  const reachable = await accessibleAthleteIds(actor, [subjectAthleteId]);
  return reachable.has(subjectAthleteId) ? requirement : null;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PROJECTION_READ_ROLES]);
    const shelfParam = request.nextUrl.searchParams.get('shelf');
    const organizationId = resolveLibraryShelf(principal, shelfParam, 'read');
    const onPlatformShelf = parseLibraryShelf(shelfParam) === 'platform';
    const actor = { ...principal, organizationId };

    // Batch mode: ?research_requirement_ids=1,2,3 answers only the computed
    // ladder for each id, so the workspace list needs one request, not N.
    // Ids outside the organization are silently absent -- indistinguishable
    // from ids that do not exist.
    const rawIds = request.nextUrl.searchParams.get('research_requirement_ids');
    if (rawIds !== null) {
      const ids = rawIds.split(',').map((value) => Number(value.trim()));
      if (ids.length === 0 || ids.length > 200 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new ValidationError('research_requirement_ids must be 1-200 comma-separated positive integers.');
      }
      /* Scoped BEFORE the status read, so an unreachable id is simply absent
         from the answer rather than confirmed to exist. The batch shape is
         what made this urgent: 200 ids per request is an enumeration oracle
         if existence leaks. */
      const readable: number[] = [];
      for (const id of ids) {
        if (await readableRequirement(actor, id, onPlatformShelf)) {
          readable.push(id);
        }
      }
      const statuses = await getRequirementStatusesInOrg(organizationId, readable);
      const states = await getAnswerStates(organizationId, statuses);
      return NextResponse.json({
        answer_states: Object.fromEntries([...states.entries()].map(([id, state]) => [String(id), state])),
      });
    }

    const rawId = request.nextUrl.searchParams.get('research_requirement_id');
    const requirementId = Number(rawId);
    if (!rawId || !Number.isInteger(requirementId) || requirementId <= 0) {
      throw new ValidationError('research_requirement_id must be a positive integer.');
    }

    /* One refusal for "does not exist", "another organization" and "a child
       you may not reach". research_requirement_id is a bigserial, so telling
       those apart is exactly what an enumerating caller wants. */
    const requirement = await readableRequirement(actor, requirementId, onPlatformShelf);
    if (!requirement) return hiddenNotFound();

    const status = await getRequirementStatusInOrg(organizationId, requirementId);
    if (status === null) return hiddenNotFound();

    const items = await listSubmissionsForRequirement(organizationId, requirementId);
    // The ladder is computed from the stored rows; what the reader is sent
    // of them is the named family fields unless they are research staff or
    // the platform shelf's curator (#1475 Part F, researchFamilyView.ts), and
    // a coach gets no note on an asker's question (F-054).
    return NextResponse.json({
      items: researchSubmissionsForReader(principal, items, onPlatformShelf, requirement),
      answer_state: deriveAnswerState(status, items),
    });
  } catch (error) {
    return jsonError(error);
  }
}

// Audit CL-C24: an unreadable or non-object body is the caller's malformed
// request, a 400 -- not an unhandled throw that surfaced as a 500.
async function readJsonObject<T>(request: NextRequest): Promise<T> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return body as T;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_SOURCE_ATTACH_ROLES]);
    const isCurator = SHADOW_LIBRARY_CURATOR_ROLES.some((role) => roleEquals(principal.role, role));

    const body = await readJsonObject<{
      research_requirement_id?: number;
      source_id?: string;
      document_id?: string | null;
      provenance?: Record<string, unknown>;
      submission_note?: string;
      shelf?: unknown;
    }>(request);
    const organizationId = resolveLibraryShelf(principal, body.shelf, 'write');

    // Normalized once, used everywhere below: a blank document_id means "no
    // document", never an empty-string FK value headed for a 500.
    const requirementId = Number(body.research_requirement_id);
    if (!Number.isInteger(requirementId) || requirementId <= 0) {
      throw new ValidationError('research_requirement_id must be a positive integer.');
    }

    const sourceId = body.source_id?.trim();
    if (!sourceId) {
      throw new ValidationError('Missing source_id.');
    }

    const documentId =
      typeof body.document_id === 'string' && body.document_id.trim() !== ''
        ? body.document_id.trim()
        : null;

    // A document can be about one athlete; linking one stays with the
    // curators, who administer the whole shelf. A coach attaches the source.
    if (!isCurator && documentId !== null) {
      throw new ForbiddenError('A coach attaches a source; linking a document stays with the Library curators.');
    }

    // Org isolation: FKs prove existence, not tenancy. "Doesn't exist" and
    // "exists in another organization" collapse into one hidden not-found.
    if ((await getRequirementStatusInOrg(organizationId, requirementId)) === null) {
      return hiddenNotFound();
    }
    // A coach attaches only to a requirement they may read: one about a child
    // they cannot reach is the same not-found as one that does not exist.
    if (!isCurator && !(await readableRequirement({ ...principal, organizationId }, requirementId, false))) {
      return hiddenNotFound();
    }
    if (!(await sourceExistsInOrg(organizationId, sourceId))) {
      return hiddenNotFound();
    }
    if (documentId && !(await documentExistsInOrg(organizationId, documentId))) {
      return hiddenNotFound();
    }

    const item = await createResearchSubmission({
      organizationId,
      researchRequirementId: requirementId,
      sourceId,
      documentId,
      provenance: body.provenance,
      submissionNote: body.submission_note,
      submittedByAccountId: principal.accountId,
    });

    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RESEARCH_SUBMISSION_DUPLICATE_LINK')) {
      return NextResponse.json(
        { ok: false, error: 'This source is already submitted against this requirement. A duplicate link is not corroboration.' },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const body = await readJsonObject<{
      submission_id?: string;
      applicability_state?: string;
      review_note?: string;
      shelf?: unknown;
    }>(request);
    const organizationId = resolveLibraryShelf(principal, body.shelf, 'write');

    if (!body.submission_id?.trim()) {
      throw new ValidationError('Missing submission_id.');
    }
    if (!isApplicabilityState(body.applicability_state) || body.applicability_state === 'unreviewed') {
      // Un-reviewing is not a verdict; a review that happened stays attributed.
      throw new ValidationError('applicability_state must be a review verdict.');
    }

    const item = await reviewResearchSubmission({
      organizationId,
      submissionId: body.submission_id,
      applicabilityState: body.applicability_state,
      reviewNote: body.review_note,
      reviewedByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
