import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPublicationForPublish, submitPublicationForReview } from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The missing middle of the publication workflow: creation leaves a row in
// 'draft', and the admin compliance console lists only 'pending_review', so
// until this route existed nothing a coach could reach ever put a
// publication in front of a reviewer. Submitting is deliberately its own
// act rather than a side effect of creation -- 'draft' is the pre-submit
// state the rest of the workflow already models (a rejected publication is
// terminal; the coach creates a new one).
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach']);

    const body = (await request.json()) as { publication_id?: string };

    if (!body.publication_id) {
      throw new Error('Missing required fields');
    }

    const publication = await getPublicationForPublish(principal.organizationId, body.publication_id);

    // No publication of that id in the caller's organization. Indistinguishable
    // from "does not exist" on purpose: the response must not confirm that
    // another gym holds this publication_id.
    if (!publication) {
      return hiddenNotFound();
    }

    // Same ownership rule as publishing: the coach who created the
    // publication, or an organization admin. Another coach submitting
    // somebody else's draft would put footage in front of a reviewer that
    // its owner may still have been rethinking.
    if (!isOrganizationAdminRole(principal.role) && publication.submitted_by_account_id !== principal.accountId) {
      return NextResponse.json(
        { error: 'Only the coach who created this publication, or an organization admin, can submit it for review.' },
        { status: 403 },
      );
    }

    if (publication.status !== 'draft') {
      return NextResponse.json(
        {
          error: 'Only a draft can be submitted for review.',
          status: publication.status,
        },
        { status: 409 },
      );
    }

    // The CAS inside re-checks 'draft', so a submit racing an admin decision
    // (or its own double-click) applies nothing rather than re-queueing a
    // publication somebody already decided.
    const applied = await submitPublicationForReview(principal.organizationId, publication.publication_id);
    if (!applied) {
      return NextResponse.json(
        { error: 'This publication changed while it was being submitted. Reload and try again.' },
        { status: 409 },
      );
    }

    // Entering the compliance queue is the act that asks an admin to look at
    // a minor's training footage, so it carries the same attribution the
    // decision and the publish steps already do.
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_publication',
      entity_id: publication.publication_id,
      details: {
        action: 'publication_submit_for_review',
        video_session_id: publication.video_session_id,
        submitted_by_account_id: publication.submitted_by_account_id,
      },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, publication_id: publication.publication_id, status: 'pending_review' });
  } catch (error) {
    return jsonError(error);
  }
}
