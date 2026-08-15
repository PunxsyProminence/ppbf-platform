import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  SHADOW_LIBRARY_CURATOR_ROLES,
  SHADOW_PROJECTION_READ_ROLES,
} from '@/src/server/pilot/shadowRoleSets';
import {
  createResearchSubmission,
  deriveAnswerState,
  documentExistsInOrg,
  getRequirementStatusInOrg,
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

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PROJECTION_READ_ROLES]);

    const rawId = request.nextUrl.searchParams.get('research_requirement_id');
    const requirementId = Number(rawId);
    if (!rawId || !Number.isInteger(requirementId) || requirementId <= 0) {
      throw new ValidationError('research_requirement_id must be a positive integer.');
    }

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

    if (!Number.isInteger(body.research_requirement_id) || (body.research_requirement_id as number) <= 0) {
      throw new ValidationError('research_requirement_id must be a positive integer.');
    }
    // Normalized once, used everywhere below: a blank document_id means "no
    // document", never an empty-string FK value headed for a 500.
    const sourceId = body.source_id?.trim() ?? '';
    const documentId = body.document_id?.trim() || null;
    if (!sourceId) {
      throw new ValidationError('Missing source_id.');
    }

    // Org isolation: FKs prove existence, not tenancy. "Doesn't exist" and
    // "exists in another organization" collapse into one hidden not-found.
    const requirementId = body.research_requirement_id as number;
    if ((await getRequirementStatusInOrg(principal.organizationId, requirementId)) === null) {
      return hiddenNotFound();
    }
    if (!(await sourceExistsInOrg(principal.organizationId, sourceId))) {
      return hiddenNotFound();
    }
    if (documentId !== null && !(await documentExistsInOrg(principal.organizationId, documentId))) {
      return hiddenNotFound();
    }

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
