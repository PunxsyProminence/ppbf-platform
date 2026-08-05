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
