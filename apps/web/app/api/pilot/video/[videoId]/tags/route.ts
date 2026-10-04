import { NextResponse, type NextRequest } from 'next/server';

import {
  accessibleAthleteIds,
  assertActorCanAccessAthlete,
  isOrganizationAdminRole,
  requireRole,
} from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { ConflictError, ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  addClipTag,
  getLiveClipTag,
  listLiveClipTagsForVideo,
  listLiveTagSubjects,
  removeClipTag,
  type ClipEventKind,
} from '@/src/server/pilot/videoClipTags';
import { assertConsentCoversVideo } from '@/src/server/pilot/videoPlaybackConsent';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

/*
 * Tag a sparring or bout video to the athletes in it and to its event, so a
 * coach can review an athlete's clips. Staff only (owner, 2026-10-03). Human
 * film study: nothing here scores footage.
 *
 * A coach may act on a video they can already see -- unattributed, or showing
 * at least one athlete who is theirs (decision 3) -- and may tag only athletes
 * who are theirs. Tagging their own athlete cannot open someone else's video,
 * because the video has to be visible before the tag is added.
 */
async function staffCanSeeVideo(
  principal: PilotPrincipal,
  organizationId: string,
  videoSessionId: string,
): Promise<boolean> {
  const video = await getVideoSessionById(organizationId, videoSessionId);
  if (!video) return false;
  if (isOrganizationAdminRole(principal.role)) return true;
  const subjects = (await listLiveTagSubjects(organizationId, videoSessionId)).map((s) => s.athlete_id);
  if (video.athlete_id) subjects.push(video.athlete_id);
  if (subjects.length === 0) return true;
  return (await accessibleAthleteIds(principal, subjects)).size > 0;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    const { videoId } = await params;
    if (!(await staffCanSeeVideo(principal, principal.organizationId, videoId))) {
      return hiddenNotFound();
    }
    const items = await listLiveClipTagsForVideo(principal.organizationId, videoId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    const { videoId } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

    const athleteId = optionalText(body?.athlete_id);
    const eventKind = body?.event_kind;
    if (!athleteId) {
      throw new ValidationError('Choose the athlete to tag.', 'CLIP_TAG_ATHLETE_REQUIRED');
    }
    if (eventKind !== 'sparring' && eventKind !== 'competition') {
      throw new ValidationError('event_kind must be "sparring" or "competition".', 'CLIP_TAG_EVENT_KIND');
    }

    if (!(await staffCanSeeVideo(principal, principal.organizationId, videoId))) {
      return hiddenNotFound();
    }
    await assertActorCanAccessAthlete(principal, athleteId);

    const tag = await addClipTag({
      organizationId: principal.organizationId,
      videoSessionId: videoId,
      athleteId,
      eventKind: eventKind as ClipEventKind,
      competitionId: optionalText(body?.competition_id),
      note: typeof body?.note === 'string' ? body.note.trim() : '',
      taggedByAccountId: principal.accountId,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_clip_tag',
      entity_id: tag.tag_id,
      details: {
        action: 'video_clip_tag_added',
        video_session_id: videoId,
        athlete_id: athleteId,
        event_kind: tag.event_kind,
        competition_id: tag.competition_id,
      },
    });

    return NextResponse.json(tag, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    const { videoId } = await params;
    const tagId = optionalText(new URL(request.url).searchParams.get('tag_id'));
    if (!tagId) {
      throw new ValidationError('tag_id is required.', 'CLIP_TAG_ID_REQUIRED');
    }

    const tag = await getLiveClipTag(principal.organizationId, tagId);
    if (!tag || tag.video_session_id !== videoId) {
      return hiddenNotFound();
    }
    // A coach removes tags on athletes who are theirs; an admin, any.
    if (!isOrganizationAdminRole(principal.role)) {
      try {
        await assertActorCanAccessAthlete(principal, tag.athlete_id);
      } catch {
        return hiddenNotFound();
      }
      /*
       * Owner, Jason 2026-10-04: "Coach, unless consent blocks". Removing the
       * tag of an athlete whose consent blocks video would make the clip play
       * again while that child is still in the footage, so that removal is
       * an organization admin's call. Same test as playback.
       */
      try {
        await assertConsentCoversVideo(principal.organizationId, tag.athlete_id);
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ConflictError(
            "This athlete's media consent blocks video, so removing their tag would let the clip play with them "
            + 'still in it. Ask an organization admin to remove it.',
            'CLIP_TAG_REMOVAL_NEEDS_ADMIN',
          );
        }
        throw error;
      }
    }

    const removed = await removeClipTag({
      organizationId: principal.organizationId,
      tagId,
      removedByAccountId: principal.accountId,
    });
    if (!removed) {
      return hiddenNotFound();
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_clip_tag',
      entity_id: tagId,
      details: {
        action: 'video_clip_tag_removed',
        video_session_id: videoId,
        athlete_id: removed.athlete_id,
      },
    });

    return NextResponse.json({ ok: true, tag_id: tagId });
  } catch (error) {
    return jsonError(error);
  }
}
