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

    if (decision === 'release') {
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
      details: { action: decision === 'release' ? 'photo_released' : 'photo_blocked' },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, review_state: decision === 'release' ? 'released' : 'blocked' });
  } catch (error) {
    return jsonError(error);
  }
}
