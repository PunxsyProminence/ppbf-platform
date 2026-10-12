import { type NextRequest } from 'next/server';

import { downloadPilotProfilePhoto } from '@/src/server/pilot/blob';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  portraitBytesResponse,
  resolveCardSubjectAccountId,
} from '@/src/server/pilot/profileCardSubject';
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
 * THE FACE OF THE COACH IN A CARD'S CORNER, ADDRESSED BY THE CARD.
 *
 * Families see a coach's display name, never the internal account id
 * (OD-2026-10-06-025 ruling 2), so an athlete's or parent's fight card carries
 * coachAccountId: null and cannot name /api/pilot/profile/photo/<coach>. This
 * route takes the same handle the card does (account_id or athlete_id, or
 * nothing for your own card) and finds the coach on the server.
 *
 * TWO SUBJECTS, GATED IN ORDER, EVERY REFUSAL THE SAME 404:
 *
 *   1. The card's subject, exactly as /api/pilot/profile/card gates it:
 *      assertViewerMayReachSubject, then a relationship that is not 'none'.
 *      A viewer who could not open the card cannot reach its coach's face
 *      through it.
 *   2. The coach, from the VIEWER's standpoint: resolveRelationship and
 *      decidePortrait on the coach's own record, the same decision the card
 *      route makes for coachPhotoAvailable and profile/photo/[accountId]
 *      makes for anyone asking by id.
 *
 * Nothing here names the coach in the response: no id in a header, no
 * redirect to the id route. The bytes and the shared portrait headers only.
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

    const relationship = await resolveRelationship(principal, identity, principal.organizationId);
    if (relationship === 'none') return hiddenNotFound();

    if (!identity.coachAccountId) return hiddenNotFound();
    const coachIdentity = await getSubjectIdentity(principal.organizationId, identity.coachAccountId);
    if (!coachIdentity) return hiddenNotFound();
    // The same reach check profile/photo/[accountId] runs on whoever it is
    // asked for, so this route never admits less narrowly than that one. For
    // a coach account with no athlete record it passes; nothing stops
    // athletes.coach_id naming an account that has one, and then it is the
    // athlete boundary that decides, as it would by id.
    try {
      await assertViewerMayReachSubject(principal, coachIdentity);
    } catch {
      return hiddenNotFound();
    }

    const coachProfile = await getAccountProfile(principal.organizationId, coachIdentity.accountId);
    const coachRelationship = await resolveRelationship(principal, coachIdentity, principal.organizationId);
    const decision = decidePortrait(
      toProfileSubject(coachIdentity, coachProfile),
      coachRelationship,
      new Date(),
    );
    if (decision.show !== 'photo' || !coachProfile.photoBlobPath) return hiddenNotFound();

    const bytes = await downloadPilotProfilePhoto(coachProfile.photoBlobPath);
    return portraitBytesResponse(bytes, coachProfile.photoContentType);
  } catch (error) {
    return jsonError(error);
  }
}
