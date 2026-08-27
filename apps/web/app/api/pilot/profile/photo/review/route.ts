import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { deletePilotProfilePhoto } from '@/src/server/pilot/blob';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  clearPhoto,
  getAccountProfile,
  getSubjectIdentity,
  releasePhoto,
  resolveRelationship,
} from '@/src/server/pilot/profileDb';

export const runtime = 'nodejs';

/**
 * THE EXIT FROM PENDING.
 *
 * A portrait is born 'pending_review' and only its own uploader can see it
 * until somebody moves it. This is that somebody: an organization admin, or one
 * of the athlete's own coaches.
 *
 * The video pipeline shipped a quarantine state with no exit in the codebase
 * and every upload died in it. This route exists so that cannot happen here --
 * the state has a door and the door has a person behind it.
 *
 * WHY A HUMAN AND NOT A SCANNER. The platform cannot tell whether a photograph
 * of a child is an appropriate photograph of a child. No classifier this
 * project could honestly ship would, and one that claimed to would be worse
 * than none, because everyone downstream would believe it. The gym is small,
 * the coaches know the members, and a coach looking at a picture is the only
 * review that means anything.
 *
 * 'block' takes the bytes with it. A blocked photograph that stays in the
 * container is a photograph somebody with the storage key can still see, and
 * the whole point of blocking it was that it should not exist here.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);

    const body = (await request.json().catch(() => null)) as
      | { account_id?: unknown; decision?: unknown }
      | null;
    const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
    const decision = body?.decision;
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'account_id is required.' }, { status: 400 });
    }
    if (decision !== 'release' && decision !== 'block') {
      return NextResponse.json({ ok: false, error: 'decision must be "release" or "block".' }, { status: 400 });
    }

    const identity = await getSubjectIdentity(principal.organizationId, accountId);
    if (!identity) return hiddenNotFound();

    try {
      await assertViewerMayReachSubject(principal, identity);
    } catch {
      return hiddenNotFound();
    }

    // A coach may only review the portraits of athletes they actually coach --
    // and their own. A coach with an unassigned athlete resolves to
    // 'organization_staff', which is not enough to release a face.
    const relationship = await resolveRelationship(principal, identity, principal.organizationId);
    const mayReview = isOrganizationAdminRole(principal.role)
      || relationship === 'coach_of_subject'
      || relationship === 'self';
    if (!mayReview) return hiddenNotFound();

    const profile = await getAccountProfile(principal.organizationId, accountId);
    if (!profile.photoBlobPath) return hiddenNotFound();

    // THE DECISION IS BOUND TO THE PHOTOGRAPH IT WAS MADE ABOUT.
    //
    // The read above is what the reviewer acted on; without carrying it into
    // the WHERE clause, the write lands on whatever the row holds by the time
    // it runs. A member may replace their portrait at any moment, and setPhoto
    // sends a replacement back to 'pending_review' -- so between this read and
    // an unguarded UPDATE:
    //
    //   release -- flips a photograph NOBODY HAS LOOKED AT to 'released',
    //     attributed to this reviewer. decidePortrait shows a released
    //     portrait of a minor to their coaches and guardians; the human review
    //     this route exists to be is defeated in one statement.
    //   block -- deletes the blob the reviewer read while nulling the row's
    //     path, stranding the replacement's bytes in the container with
    //     nothing referencing them and no path left that can remove them,
    //     against this route's own promise that a block takes the bytes with
    //     it.
    //
    // Both halves of the CAS ride on the UPDATE: the state as read, and
    // photo_uploaded_at, which is the photograph's identity (the blob path is
    // deliberately account-stable, so it does NOT move on a replacement --
    // see setPhoto). Zero rows matched is the denial. This is the same guard
    // the sibling admin console (admin/portrait-review) already carries, and
    // the same shape as video/[videoId]/release repeating its state predicate
    // on the write.
    //
    // Block CASes FIRST and deletes only after it has won, so a reviewer who
    // loses the race never destroys bytes another decision is still using.
    //
    // A row holding a photograph with no photo_uploaded_at has no identity to
    // bind, so there is no safe decision to record about it: refuse rather
    // than fall back to the state guard alone, the same way the admin console
    // fails closed on a null attestation. setPhoto has always stamped this
    // column, so no row any current write path produces reaches here.
    if (profile.photoUploadedAt === null) {
      return NextResponse.json(
        {
          ok: false,
          error: 'This portrait cannot be decided on: the record does not say which photograph it is.',
        },
        { status: 409 },
      );
    }

    const applied = decision === 'release'
      ? await releasePhoto(
          principal.organizationId,
          accountId,
          principal.accountId,
          profile.photoReviewState,
          profile.photoUploadedAt,
        )
      : await clearPhoto(
          principal.organizationId,
          accountId,
          'blocked',
          principal.accountId,
          profile.photoReviewState,
          profile.photoUploadedAt,
        );

    if (!applied) {
      return NextResponse.json(
        {
          ok: false,
          error: 'This portrait changed before your decision was recorded. Reload and look at it again.',
        },
        { status: 409 },
      );
    }

    if (decision === 'block') {
      await deletePilotProfilePhoto(profile.photoBlobPath);
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account_profile_photo',
      entity_id: accountId,
      details: { action: decision === 'release' ? 'photo_released' : 'photo_blocked' },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, review_state: decision === 'release' ? 'released' : 'blocked' });
  } catch (error) {
    return jsonError(error);
  }
}
