import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  clearNickname,
  getAccountProfile,
  getSubjectIdentity,
  setCorner,
  setNickname,
  setProgram,
} from '@/src/server/pilot/profileDb';
import {
  buildFightCard,
  isNicknameLocked,
  normalizeCorner,
  normalizeProgram,
  NICKNAME_REJECTION_MESSAGE,
  validateNickname,
  type CornerChoice,
  type ProgramChoice,
} from '@/src/server/pilot/profileIdentity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A member's own identity: read it, and change it.
 *
 * Everything on this route is scoped to the caller. There is no account_id
 * parameter and there must never be one -- reading somebody else's card goes
 * through /api/pilot/profile/card, which runs the visibility gate. A route that
 * can be pointed at an account id is a route that will eventually be pointed at
 * the wrong one.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const identity = await getSubjectIdentity(principal.organizationId, principal.accountId);
    const profile = await getAccountProfile(principal.organizationId, principal.accountId);
    const now = new Date();

    const coachIdentity = identity?.coachAccountId
      ? await getSubjectIdentity(principal.organizationId, identity.coachAccountId)
      : null;
    const coachProfile = identity?.coachAccountId
      ? await getAccountProfile(principal.organizationId, identity.coachAccountId)
      : null;

    return NextResponse.json({
      ok: true,
      // The member's own settings, as stored. A member always sees their own
      // ring name back, cleared or not, because the settings screen has to be
      // able to say "this was taken down" rather than silently showing blank.
      settings: {
        nickname: profile.nickname,
        nickname_cleared: Boolean(profile.nicknameClearedAt),
        nickname_locked: isNicknameLocked(profile.nicknameClearedAt, now),
        corner: profile.corner,
        program: profile.program,
        photo_review_state: profile.photoReviewState,
        has_photo: profile.photoBlobPath !== null,
      },
      card: identity
        ? buildFightCard(
          {
            accountId: identity.accountId,
            fullName: identity.fullName,
            ringName: profile.nicknameClearedAt ? null : profile.nickname,
            corner: profile.corner,
            program: profile.program,
            coachName: coachIdentity?.fullName ?? null,
            coachAccountId: identity.coachAccountId,
            // The coach's own portrait is only ever released by the coach's own
            // review, so this is a state read and not a policy decision.
            coachPhotoAvailable: coachProfile?.photoReviewState === 'released'
              && coachProfile.photoBlobPath !== null,
            memberSince: identity.memberSince,
            photoAvailable: profile.photoBlobPath !== null
              && profile.photoReviewState !== 'blocked'
              && profile.photoReviewState !== 'removed',
          },
          now,
        )
        : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: 'A JSON body is required.' }, { status: 400 });
    }

    const now = new Date();
    const changed: string[] = [];

    if ('corner' in body) {
      const corner: CornerChoice = normalizeCorner(body.corner);
      await setCorner(principal.organizationId, principal.accountId, corner);
      changed.push('corner');
    }

    if ('program' in body) {
      const program: ProgramChoice = normalizeProgram(body.program);
      await setProgram(principal.organizationId, principal.accountId, program);
      changed.push('program');
    }

    if ('nickname' in body) {
      const raw = body.nickname;
      if (raw === null || raw === '') {
        // The member clearing their own. Not a moderation event: no lock, and
        // the record must not read as staff having intervened.
        await clearNickname(principal.organizationId, principal.accountId, null);
        changed.push('nickname_cleared_by_self');
      } else {
        const profile = await getAccountProfile(principal.organizationId, principal.accountId);
        if (isNicknameLocked(profile.nicknameClearedAt, now)) {
          return NextResponse.json(
            { ok: false, error: NICKNAME_REJECTION_MESSAGE.locked_by_staff, reason: 'locked_by_staff' },
            { status: 409 },
          );
        }
        const validation = validateNickname(raw);
        if (!validation.ok || !validation.value) {
          return NextResponse.json(
            {
              ok: false,
              error: NICKNAME_REJECTION_MESSAGE[validation.reason ?? 'disallowed_characters'],
              reason: validation.reason,
            },
            { status: 400 },
          );
        }
        await setNickname(principal.organizationId, principal.accountId, validation.value);
        changed.push('nickname');
      }
    }

    if (changed.length === 0) {
      return NextResponse.json({ ok: false, error: 'Nothing to change.' }, { status: 400 });
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account_profile',
      entity_id: principal.accountId,
      // Field NAMES only. The ring name string itself never enters the audit
      // log: an audit row is read by more people than the ring name is, and
      // writing it here would route a child's self-chosen name straight past
      // the visibility gate the rest of this feature is built on.
      details: { action: 'self_update', fields: changed },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, changed });
  } catch (error) {
    return jsonError(error);
  }
}
