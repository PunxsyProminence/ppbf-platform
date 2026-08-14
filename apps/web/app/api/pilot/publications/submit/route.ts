import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { getPublicationForPublish, submitPublicationForReview } from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

// A lost audit row is a gap an operator can close by re-dispatching, not a
// reason to tell the coach their (already-committed) submit failed -- same
// doctrine as the compliance console's auditComplianceEvent and
// training-holds' auditHoldEvent. Without this, an audit-table hiccup after
// the CAS commit turns into a 500, the coach retries, and the retry's 409
// blames a phantom concurrent change.
async function auditSubmitEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'publication-submit-audit-write-failed',
      action: event.details && typeof event.details === 'object' ? (event.details as { action?: unknown }).action : undefined,
      ...(code ? { code } : {}),
    });
  }
}

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

    // jsonError maps status by message prefix; a bare request.json() throw
    // (SyntaxError) matches no prefix and would surface a malformed body as
    // a 500. Same defensive shape as the compliance console.
    const body = (await request.json().catch(() => null)) as { publication_id?: unknown } | null;
    const publicationId = typeof body?.publication_id === 'string' ? body.publication_id.trim() : '';

    if (!publicationId) {
      throw new Error('Missing required fields');
    }

    const publication = await getPublicationForPublish(principal.organizationId, publicationId);

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

    // Creation gated on a released ('ready') video session, but the session
    // can move back out of that state afterwards (scan review can quarantine
    // or block it). Entering the review queue is this route's act, so it
    // re-checks: footage the platform is refusing to play has no business
    // in front of a reviewer.
    const videoSession = await getVideoSessionById(principal.organizationId, publication.video_session_id);
    if (!videoSession || videoSession.status !== 'ready') {
      return NextResponse.json(
        { error: 'The video behind this publication is not in a released state, so it cannot go to review.' },
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
    await auditSubmitEvent({
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
