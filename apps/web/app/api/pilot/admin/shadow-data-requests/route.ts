import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  completeShadowDataDeletionRequest,
  denyShadowDataDeletionRequest,
  listShadowDataDeletionRequests,
  type ShadowDataDeletionRequestStatus,
} from '@/src/server/pilot/shadowConversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The queue for SHADOW conversation-history deletion requests.
 *
 * POST /api/pilot/shadow/data has written into
 * pilot.shadow_data_deletion_requests since the SHADOW runtime slice, and
 * answered `fulfillment: 'manual_review_required'` while nothing anywhere read
 * that table except its own idempotency check. This is the review.
 *
 * ORGANIZATION ADMIN ONLY, and gated twice on purpose. requireRole here is the
 * declaration a reader and routeGateDeclaration.convention.test.ts can both
 * see; requireOrganizationAdmin inside each shadowConversations function is
 * what actually holds if this route is ever refactored or a second caller
 * appears. Neither is decoration for the other.
 */
const ACTIONABLE_STATUSES: readonly ShadowDataDeletionRequestStatus[] = [
  'pending',
  'approved',
  'completed',
  'denied',
];

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const requested = new URL(request.url).searchParams.get('status');
    // An unrecognised status is a 400 rather than a silent full listing. A
    // typo'd filter that quietly widens the queue is how an admin ends up
    // acting on a row they did not mean to see.
    if (requested && !ACTIONABLE_STATUSES.includes(requested as ShadowDataDeletionRequestStatus)) {
      return NextResponse.json({ ok: false, error: 'Unsupported status filter.' }, { status: 400 });
    }

    const items = await listShadowDataDeletionRequests(
      principal,
      (requested as ShadowDataDeletionRequestStatus | null) ?? undefined,
    );
    return NextResponse.json({ ok: true, items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const body = (await request.json().catch(() => null)) as {
      request_id?: unknown;
      action?: unknown;
    } | null;
    const requestId = typeof body?.request_id === 'string' ? body.request_id.trim() : '';
    const action = body?.action;
    if (!requestId) {
      return NextResponse.json({ ok: false, error: 'request_id is required.' }, { status: 400 });
    }
    if (action !== 'complete' && action !== 'deny') {
      return NextResponse.json(
        { ok: false, error: 'action must be "complete" or "deny".' },
        { status: 400 },
      );
    }

    const outcome = action === 'complete'
      ? await completeShadowDataDeletionRequest(principal, requestId)
      : await denyShadowDataDeletionRequest(principal, requestId);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'shadow_data_deletion_request',
      entity_id: outcome.requestId,
      /* The COUNT, not the conversations. An audit row recording which
         conversations were cleared would carry a list of a person's chat
         session ids into a table read by more people than the chat ever was --
         republishing the shape of what they asked to have removed. How many is
         the fact an auditor needs; which ones is not. */
      details: { action, conversations_cleared: outcome.conversationsCleared },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    /* SHADOW_DELETION_REQUEST_NOT_ACTIONABLE covers three cases that are all
       the same answer to this caller: no such request, another organization's
       request, and a request a colleague already handled. Distinguishing them
       would leak the existence of rows outside this admin's organization, and
       the useful instruction ("reload the queue") is identical either way. */
    if (error instanceof Error && error.message === 'SHADOW_DELETION_REQUEST_NOT_ACTIONABLE') {
      return NextResponse.json(
        { ok: false, error: 'That request is no longer open. Reload the queue.' },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}
