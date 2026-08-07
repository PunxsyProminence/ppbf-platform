import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { deletePilotProfilePhoto } from '@/src/server/pilot/blob';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  clearPhoto,
  getAccountProfile,
  listPendingReviewPortraits,
  releasePhoto,
} from '@/src/server/pilot/profileDb';

export const runtime = 'nodejs';

/**
 * T-004: THE ORG-WIDE DOOR INTO THE EXIT profile/photo/review ALREADY BUILT.
 *
 * pilot.account_profiles has carried photo_review_state since profile-identity
 * shipped, and profile/photo/review already lets a coach or admin release or
 * block a photo -- but only if they already know the account_id. Nothing
 * listed who was waiting, so pending portraits sat invisible. This route adds
 * the list and narrows the actor to organization admin only, per the ticket;
 * it does not touch or loosen the sibling route's own (broader, deliberate)
 * gate.
 *
 * 'reject' reuses the sibling route's 'block' semantics: the blob is deleted,
 * the row is kept with photo_review_state = 'blocked' and an attributed
 * reviewer/timestamp. A literal row DELETE would be a second, inconsistent
 * path to the same action, and 'delete' is not even in the audit_events
 * vocabulary this platform enforces (auditEventTypes.ts) -- it would fail the
 * check constraint on its own audit write.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const portraits = await listPendingReviewPortraits(principal.organizationId);
    return NextResponse.json({ ok: true, portraits });
  } catch (error) {
    return jsonError(error);
  }
}

type PortraitReviewDecision = 'approve' | 'reject';

const DECISIONS = new Set<PortraitReviewDecision>(['approve', 'reject']);

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const body = (await request.json().catch(() => null)) as
      | { account_id?: unknown; decision?: unknown }
      | null;
    const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
    const rawDecision: unknown = body?.decision;
    if (!accountId) {
      throw new Error('Missing account_id');
    }
    if (!DECISIONS.has(rawDecision as PortraitReviewDecision)) {
      throw new Error('Unsupported decision: expected "approve" or "reject"');
    }
    const decision = rawDecision as PortraitReviewDecision;

    const profile = await getAccountProfile(principal.organizationId, accountId);
    if (!profile.photoBlobPath) return hiddenNotFound();
    // The queue this console lists is pending_review only; acting on
    // anything else here would be acting on a row nobody showed the admin,
    // most likely a stale tab racing another reviewer.
    if (profile.photoReviewState !== 'pending_review') {
      throw new Error(`Unsupported: portrait is not pending review (current state: ${profile.photoReviewState})`);
    }

    if (decision === 'approve') {
      await releasePhoto(principal.organizationId, accountId, principal.accountId);
    } else {
      await deletePilotProfilePhoto(profile.photoBlobPath);
      await clearPhoto(principal.organizationId, accountId, 'blocked', principal.accountId);
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account_profile_photo',
      entity_id: accountId,
      details: {
        action: decision === 'approve' ? 'photo_released' : 'photo_blocked',
        source: 'admin_portrait_review_console',
      },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, review_state: decision === 'approve' ? 'released' : 'blocked' });
  } catch (error) {
    return jsonError(error);
  }
}
