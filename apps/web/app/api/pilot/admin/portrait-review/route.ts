import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { deletePilotProfilePhoto } from '@/src/server/pilot/blob';
import { query } from '@/src/server/pilot/db';
import { ForbiddenError } from '@/src/server/pilot/errors';
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
    // The wire format is snake_case, matching every other admin route's JSON
    // response in this codebase (e.g. admin/coach-coverage) -- the internal
    // profileDb.ts return type stays camelCase, matching this module's own
    // TS convention, so the mapping happens once, here, at the boundary.
    return NextResponse.json({
      ok: true,
      portraits: portraits.map((portrait) => ({
        account_id: portrait.accountId,
        full_name: portrait.fullName,
        athlete_id: portrait.athleteId,
        uploaded_at: portrait.uploadedAt,
      })),
    });
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

    // The queue this console lists is pending_review only, and two admins
    // can have it open at once. expectedCurrentState makes the DB write
    // itself the compare-and-swap: the UPDATE's WHERE clause re-checks
    // photo_review_state at the moment it acquires the row lock, so a
    // second reviewer racing the same account_id loses atomically instead
    // of silently overwriting (or, for reject, deleting the blob out from
    // under) whatever the first reviewer's decision already committed.
    // Blob deletion happens only AFTER the CAS confirms this request won --
    // deleting first and losing the race would destroy a photo the other
    // reviewer just released.
    if (decision === 'approve') {
      // An approval attests that THIS reviewer looked at THIS photograph. The
      // client disables Approve until the image loads, but a disabled button
      // is not a server guarantee -- the only server-verifiable record of a
      // look is the audit row the photo route writes BEFORE serving bytes
      // (photo/[accountId]/route.ts), which records WHICH photograph it
      // served: the row's exact photo_uploaded_at. The probe demands
      // EQUALITY with the profile's current value, not recency ordering --
      // a member can replace a pending photo while the queue is open
      // (setPhoto sends a replacement back to pending_review), and under
      // ordering the view event for the OLD photo can postdate the swap and
      // attest a photo nobody saw. A null photo_uploaded_at, and any view
      // event written before identities were recorded, matches nothing:
      // fail closed, look again. Reject is deliberately ungated: refusing
      // is never slowed.
      const attestedUploadedAt = profile.photoUploadedAt;
      const viewed = attestedUploadedAt === null
        ? []
        : await query<{ audit_id: string }>(
            `select audit_id
             from pilot.audit_events
             where organization_id = $1
               and actor_account_id = $2
               and entity_type = 'account_profile_photo'
               and entity_id = $3
               and details->>'action' = 'portrait_review_image_viewed'
               and details->>'photo_uploaded_at' = $4
             limit 1`,
            [principal.organizationId, principal.accountId, accountId, attestedUploadedAt],
          );
      if (attestedUploadedAt === null || viewed.length === 0) {
        throw new ForbiddenError('Forbidden: approve requires viewing the current photo first');
      }
      // The attested identity rides into the CAS: releasePhoto's UPDATE also
      // requires photo_uploaded_at to still equal it, so a replacement
      // landing between the probe above and this write matches zero rows and
      // refuses -- the same shape as losing the pending_review race.
      const applied = await releasePhoto(principal.organizationId, accountId, principal.accountId, 'pending_review', attestedUploadedAt);
      if (!applied) {
        throw new Error('Unsupported: portrait was already decided by another reviewer');
      }
    } else {
      const applied = await clearPhoto(principal.organizationId, accountId, 'blocked', principal.accountId, 'pending_review');
      if (!applied) {
        throw new Error('Unsupported: portrait was already decided by another reviewer');
      }
      await deletePilotProfilePhoto(profile.photoBlobPath);
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
