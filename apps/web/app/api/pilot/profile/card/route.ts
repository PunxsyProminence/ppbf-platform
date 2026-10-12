import { NextResponse, type NextRequest } from 'next/server';

import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  getAccountProfile,
  getSubjectIdentity,
  resolveRelationship,
  toProfileSubject,
} from '@/src/server/pilot/profileDb';
import { coachNameForViewer, resolveCardSubjectAccountId } from '@/src/server/pilot/profileCardSubject';
import { buildFightCard } from '@/src/server/pilot/profileIdentity';
import { decidePortrait, decideRingName } from '@/src/server/pilot/profileVisibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One member's fight card, as this viewer is allowed to see it.
 *
 * Accepts either account_id or athlete_id (resolveCardSubjectAccountId), and
 * both land on the same gates.
 *
 * An athlete or parent viewer gets coachAccountId: null (buildFightCard,
 * OD-2026-10-06-025 ruling 2); the coach's face comes from card/coach-photo.
 *
 * The card is assembled AFTER the visibility decision, not filtered afterwards.
 * `photoAvailable: false` and `ringName: null` are the same values a member with
 * no photo and no ring name produces, so the response cannot be read backwards
 * to learn that a hidden photograph exists.
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

    const now = new Date();
    const subject = toProfileSubject(identity, profile);
    const portrait = decidePortrait(subject, relationship, now);
    const ringName = decideRingName(subject, relationship, now);

    // The coach in this member's corner. Their portrait runs the whole gate
    // again from the VIEWER's standpoint -- a guardian looking at their child's
    // card sees the coach's face because the coach is their child's coach, and
    // a stranger would not, even though the card itself is the same card.
    // card/coach-photo runs this same decision before it serves the bytes.
    let coachName: string | null = null;
    let coachPhotoAvailable = false;
    if (identity.coachAccountId) {
      const coachIdentity = await getSubjectIdentity(principal.organizationId, identity.coachAccountId);
      if (coachIdentity) {
        coachName = await coachNameForViewer(principal, coachIdentity);
        const coachProfile = await getAccountProfile(principal.organizationId, identity.coachAccountId);
        const coachRelationship = await resolveRelationship(principal, coachIdentity, principal.organizationId);
        coachPhotoAvailable = decidePortrait(
          toProfileSubject(coachIdentity, coachProfile),
          coachRelationship,
          now,
        ).show === 'photo';
      }
    }

    const card = buildFightCard(
      {
        accountId: identity.accountId,
        fullName: identity.fullName,
        ringName,
        corner: profile.corner,
        program: profile.program,
        coachName,
        coachAccountId: identity.coachAccountId,
        coachPhotoAvailable,
        memberSince: identity.memberSince,
        photoAvailable: portrait.show === 'photo',
        viewerRole: principal.role,
      },
      now,
    );

    return NextResponse.json(
      { ok: true, card, relationship },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
