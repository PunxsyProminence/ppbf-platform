import { type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { downloadPilotProfilePhoto } from '@/src/server/pilot/blob';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  getAccountProfile,
  getSubjectIdentity,
} from '@/src/server/pilot/profileDb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * THE SEEING HALF OF THE PORTRAIT DECISION.
 *
 * The admin console at app/admin/portrait-review listed a queue of pending
 * portraits and offered Approve and Reject, and there was no way for the
 * reviewer to look at the photograph they were deciding about. That is not a
 * missing convenience. The whole justification for a human review step is
 * written down in profileVisibility.ts -- "the platform cannot tell whether a
 * photograph of a child is an appropriate photograph of a child" -- and a
 * reviewer looking at a name and a timestamp cannot tell either. An approval
 * made from metadata is a rubber stamp that releases a child's face on the
 * strength of nothing.
 *
 * WHY THIS IS A SEPARATE ROUTE AND NOT profile/photo/[accountId].
 *
 * That route is the normal read path and it is right as it stands: it runs
 * decidePortrait(), which refuses everything that is not 'released', and for a
 * minor refuses everyone outside MINOR_CIRCLE -- which deliberately excludes
 * the organization's own admins. A pending portrait therefore 404s to the very
 * reviewer whose job is to decide it, and widening that route to let it through
 * would widen it for every caller and every state.
 *
 * So this is the same shape as the video pipeline's answer to the same problem.
 * api/pilot/video/[videoId] returns hiddenNotFound() for anything not 'ready',
 * and api/pilot/video/review-link exists beside it as the narrow, audited,
 * review-only way to see the thing under review. This route is that, for faces:
 *
 *   1. requirePrincipal   -- a real session, not one still on a bootstrap PIN.
 *   2. requireRole         -- organization admin only, the SAME actor set the
 *                             console's queue and decision route already use
 *                             (see ../../route.ts). A coach reviewing their own
 *                             athlete's portrait goes through profile/photo/
 *                             review, and this console is not their door.
 *   3. assertViewerMayReachSubject
 *                          -- the existing child-account boundary out of
 *                             access.ts, unchanged and unwidened. Org isolation
 *                             is enforced here, once, by the module that owns it.
 *   4. pending_review ONLY -- the exception this route carves is exactly as wide
 *                             as the decision it exists to support, and not one
 *                             state wider. Once the portrait is released,
 *                             profileVisibility.ts governs it again and an admin
 *                             who is not in the child's circle gets the plate
 *                             from the normal route. Once it is blocked, the
 *                             bytes are gone. There is no state in which this
 *                             route is a general admin backdoor to a released
 *                             minor's photograph.
 *
 * EVERY REFUSAL IS THE SAME 404, for the reason profile/photo/[accountId]
 * states: "403, you may not see this child's photo" has already disclosed that
 * this child has a photo. The one exception is the role check, which refuses
 * before any subject is looked up and so discloses nothing about anybody.
 *
 * THE VIEW IS AUDITED. Same posture as video/review-link: these are
 * photographs of youth athletes and who looked at one has to be answerable
 * afterwards. It is written before the bytes are returned, so an audit failure
 * costs the reviewer the image rather than costing the record the entry -- and
 * failing closed there is the right direction, because a reviewer who cannot
 * see the portrait cannot approve it either. 'update' is the event_type because
 * the vocabulary in auditEventTypes.ts has no read/view value and adding one
 * needs a migration; video/review-link records its own view the same way, with
 * the truth carried in details.action.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const { accountId } = await params;
    if (!accountId || accountId.length > 128) return hiddenNotFound();

    const identity = await getSubjectIdentity(principal.organizationId, accountId);
    if (!identity) return hiddenNotFound();

    try {
      await assertViewerMayReachSubject(principal, identity);
    } catch {
      return hiddenNotFound();
    }

    const profile = await getAccountProfile(principal.organizationId, accountId);
    if (!profile.photoBlobPath) return hiddenNotFound();
    // The gate that keeps this route honest. Read from the row rather than from
    // the queue listing, because the queue the reviewer is looking at may be
    // seconds old and another admin may already have decided this portrait.
    if (profile.photoReviewState !== 'pending_review') return hiddenNotFound();

    const bytes = await downloadPilotProfilePhoto(profile.photoBlobPath);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account_profile_photo',
      entity_id: accountId,
      details: {
        action: 'portrait_review_image_viewed',
        athlete_id: identity.athleteId,
        source: 'admin_portrait_review_console',
      },
      shadow_mirror: false,
    });

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': profile.photoContentType ?? 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        // Identical header set to profile/photo/[accountId], and for the same
        // reasons written out there: no-store because a photograph whose
        // release is refused has to stop being served and a shared cache
        // holding a child's face defeats that; nosniff and the sandbox CSP
        // against a context that could reinterpret the bytes or frame them
        // somewhere else. An UNDECIDED portrait is the most sensitive state a
        // photograph on this platform is ever in -- nobody has yet said it is
        // appropriate -- so nothing here may be laxer than the released path.
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
