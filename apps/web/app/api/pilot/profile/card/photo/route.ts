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
import { portraitBytesResponse, resolveCardSubjectAccountId } from '@/src/server/pilot/profileCardSubject';
import { decidePortrait } from '@/src/server/pilot/profileVisibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * THE FACE ON A FIGHT CARD, ADDRESSED BY THE CARD.
 *
 * A family's card carries no account id (F-119; a parent's own id is
 * email-shaped), so it cannot name /api/pilot/profile/photo/<id>. This route
 * takes the handle /profile/card takes (account_id or athlete_id, or nothing
 * for your own card; resolveCardSubjectAccountId) and serves that subject's
 * portrait.
 *
 * The same gates as profile/photo/[accountId], called in the same order --
 * requirePrincipal, assertViewerMayReachSubject, resolveRelationship,
 * decidePortrait -- plus the card's own "relationship none is a 404". It
 * admits no one that route would refuse for the same subject. Every refusal is
 * the same hiddenNotFound, so a refusal never says a photograph exists.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const accountId = await resolveCardSubjectAccountId(principal, new URL(request.url));
    if (!accountId) return hiddenNotFound();

    const identity = await getSubjectIdentity(principal.organizationId, accountId);
    if (!identity) return hiddenNotFound();

    try {
      await assertViewerMayReachSubject(principal, identity);
    } catch {
      return hiddenNotFound();
    }

    const profile = await getAccountProfile(principal.organizationId, accountId);
    const relationship = await resolveRelationship(principal, identity, principal.organizationId);
    if (relationship === 'none') return hiddenNotFound();

    const decision = decidePortrait(toProfileSubject(identity, profile), relationship, new Date());
    if (decision.show !== 'photo' || !profile.photoBlobPath) return hiddenNotFound();

    const bytes = await downloadPilotProfilePhoto(profile.photoBlobPath);
    return portraitBytesResponse(bytes, profile.photoContentType);
  } catch (error) {
    return jsonError(error);
  }
}
