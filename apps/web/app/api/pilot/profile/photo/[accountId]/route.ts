import { type NextRequest } from 'next/server';

import { downloadPilotProfilePhoto } from '@/src/server/pilot/blob';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  getAccountProfile,
  getSubjectIdentity,
  resolveRelationship,
  toProfileSubject,
} from '@/src/server/pilot/profileDb';
import { decidePortrait } from '@/src/server/pilot/profileVisibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SERVE ONE PORTRAIT.
 *
 * This is the only way a photograph leaves the platform, and it is an
 * authenticated byte stream rather than a link. No SAS URL is minted for this
 * container -- see blob.ts -- because a signed URL to a child's face is a
 * bearer capability that outlives the session, survives being pasted into a
 * chat window, and has no idea who is holding it.
 *
 * FOUR GATES, IN ORDER, AND ALL FOUR MATTER:
 *
 *   1. requirePrincipal      -- an authenticated session, and not one still on
 *                               a bootstrap PIN.
 *   2. assertViewerMayReachSubject
 *                            -- the EXISTING child-account boundary
 *                               (assertActorCanAccessAthlete). Nothing here
 *                               widens it; a viewer who cannot read the athlete
 *                               record never reaches gate 3.
 *   3. resolveRelationship   -- self / their coach / their guardian / staff /
 *                               none, from the same joins access.ts uses.
 *   4. decidePortrait        -- and for a minor, only the first three count.
 *
 * EVERY REFUSAL IS THE SAME 404. A viewer who is told "403, you may not see
 * this child's photo" has been told that this child has a photo, which is
 * itself a disclosure about that child. hiddenNotFound() is the platform's
 * existing answer to exactly this, and it is used here for "no such account",
 * "no photo", "not released" and "not your family" alike.
 *
 * AND A FIFTH GATE THAT IS DELIBERATELY ABSENT: GUARDIAN MEDIA CONSENT.
 *
 * It is a fair question, because gate 4's photo_review_state is a human
 * APPROPRIATENESS review -- "is this a suitable picture" -- which is a
 * genuinely different question from "did a guardian agree to this child's
 * image being used". The sibling video route (/api/pilot/video/[videoId]) does
 * now consult pilot.waivers before serving footage. This one does not, on
 * three grounds:
 *
 *   1. The one scope flag that route enforces cannot apply here. It refuses on
 *      covers_video = false -- a photo-only consent -- and a photo-only consent
 *      by definition still covers a photograph. There is nothing for it to
 *      refuse. public_use_allowed does not apply either: the migration defines
 *      false as "internal/gym-only", and an in-circle portrait IS that use.
 *   2. Refusing on a MISSING consent row would close this route for nearly the
 *      whole roster. The only writer of a consent row the gate can see is the
 *      guardian's own console (see that route's own note for the measurement),
 *      so absence is the default state, not a signal.
 *   3. profileVisibility.ts already decided this surface on purpose: portraits
 *      are scoped by RELATIONSHIP, to the three parties who already see the
 *      child in the physical gym. That decision is not overturned from here.
 *
 * What remains genuinely open -- an explicitly WITHDRAWN consent, which today
 * retracts published media but leaves this route serving -- is an owner
 * decision, not a bug to be quietly closed by the next reader.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
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
    const relationship = await resolveRelationship(principal, identity, principal.organizationId);
    const decision = decidePortrait(toProfileSubject(identity, profile), relationship, new Date());

    if (decision.show !== 'photo' || !profile.photoBlobPath) {
      // The caller renders the brass plate. It is not told why, and it does not
      // need to know -- the plate is a finished object, not an error state.
      return hiddenNotFound();
    }

    const bytes = await downloadPilotProfilePhoto(profile.photoBlobPath);

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': profile.photoContentType ?? 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        // no-store, not max-age. A photograph whose release is revoked has to
        // stop being served, and a shared cache holding a child's face for an
        // hour after a guardian asked for it to come down defeats the takedown.
        'Cache-Control': 'private, no-store, max-age=0',
        // Belt and braces against a rendering context that could reinterpret
        // the bytes, and against the response being framed elsewhere.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
