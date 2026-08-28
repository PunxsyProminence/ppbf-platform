import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  getShadowResearchRequirementById,
  subjectAthleteIdOf,
} from '@/src/server/pilot/shadowResearch';
import {
  SHADOW_LIBRARY_CURATOR_ROLES,
  SHADOW_PROJECTION_READ_ROLES,
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
// submissions hang off). Writing a link and reviewing applicability are
// CURATOR acts -- the same authority that registers and approves library
// evidence, because attaching a source to a question is evidence curation,
// not general submission. When general-research intake (issue #345 workflow
// 3) arrives, widening the submitter set is its own decision.
//
// Nothing in this route can resolve a requirement: there is no code path
// from here to shadow_research_requirements.status.

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
 * a row naming nobody is org-wide operational data and stays readable.
 * Organization admins administer the whole gym, so the organization predicate
 * the queries already carry is their reach.
 */
async function mayReadRequirement(
  actor: { accountId: string; role: PilotRole; organizationId: string; athleteId: string | null },
  requirementId: number,
): Promise<boolean> {
  if (isOrganizationAdminRole(actor.role)) {
    return true;
  }

  const requirement = await getShadowResearchRequirementById(actor.organizationId, requirementId);
  if (!requirement) {
    return false;
  }

  const subjectAthleteId = subjectAthleteIdOf(requirement);
  if (subjectAthleteId === null) {
    return true;
  }

  const reachable = await accessibleAthleteIds(actor, [subjectAthleteId]);
  return reachable.has(subjectAthleteId);
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PROJECTION_READ_ROLES]);

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
        if (await mayReadRequirement(principal, id)) {
          readable.push(id);
        }
      }
      const statuses = await getRequirementStatusesInOrg(principal.organizationId, readable);
      const states = await getAnswerStates(principal.organizationId, statuses);
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
    if (!(await mayReadRequirement(principal, requirementId))) return hiddenNotFound();

    const status = await getRequirementStatusInOrg(principal.organizationId, requirementId);
    if (status === null) return hiddenNotFound();

    const items = await listSubmissionsForRequirement(principal.organizationId, requirementId);
    return NextResponse.json({
      items,
      answer_state: deriveAnswerState(status, items),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const body = (await request.json()) as {
      research_requirement_id?: number;
      source_id?: string;
      document_id?: string | null;
      provenance?: Record<string, unknown>;
      submission_note?: string;
    };

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

    // Org isolation: FKs prove existence, not tenancy. "Doesn't exist" and
    // "exists in another organization" collapse into one hidden not-found.
    if ((await getRequirementStatusInOrg(principal.organizationId, requirementId)) === null) {
      return hiddenNotFound();
    }
    if (!(await sourceExistsInOrg(principal.organizationId, sourceId))) {
      return hiddenNotFound();
    }
    if (documentId && !(await documentExistsInOrg(principal.organizationId, documentId))) {
      return hiddenNotFound();
    }

    const item = await createResearchSubmission({
      organizationId: principal.organizationId,
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

    const body = (await request.json()) as {
      submission_id?: string;
      applicability_state?: string;
      review_note?: string;
    };

    if (!body.submission_id?.trim()) {
      throw new ValidationError('Missing submission_id.');
    }
    if (!isApplicabilityState(body.applicability_state) || body.applicability_state === 'unreviewed') {
      // Un-reviewing is not a verdict; a review that happened stays attributed.
      throw new ValidationError('applicability_state must be a review verdict.');
    }

    const item = await reviewResearchSubmission({
      organizationId: principal.organizationId,
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
