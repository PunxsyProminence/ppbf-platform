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
  blockedClipVideoIds,
  ExposureLinkSparringOnlyError,
  getLiveClipTag,
  listLiveClipTagsForVideo,
  listLiveTagSubjects,
  removeClipTag,
  setClipTagExposure,
  type ClipEventKind,
} from '@/src/server/pilot/videoClipTags';
import { assertConsentCoversVideo } from '@/src/server/pilot/videoPlaybackConsent';
import { assertVideoIsFilmStudyMedia, VideoDestinationError } from '@/src/server/pilot/videoDestination';
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
  // Teach Shadow footage is anonymous and never a clip; it reads as not
  // found here, as it does on playback.
  try {
    await assertVideoIsFilmStudyMedia(organizationId, videoSessionId);
  } catch (error) {
    // Only the destination refusal reads as not found; a database fault
    // is a server error, not a missing video.
    if (error instanceof VideoDestinationError) return false;
    throw error;
  }
  const tagged = await listLiveTagSubjects(organizationId, videoSessionId);
  // A deleted athlete's footage reads as not found, as on playback.
  if (tagged.some((subject) => subject.athlete_deleted)) return false;
  if (isOrganizationAdminRole(principal.role)) return true;
  const subjects = tagged.map((subject) => subject.athlete_id);
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
    /*
     * Owner, Jason 2026-10-04: "A) Hide". On a clip a consent block stops,
     * no note is shown -- a note may name the child whose guardian refused.
     * The tags themselves stay listed so an organization admin can find and
     * remove the one that blocks (a coach cannot: "Coach, unless consent
     * blocks").
     */
    const blocked = (await blockedClipVideoIds(principal.organizationId, [videoId])).has(videoId);
    /*
     * A partner's tag is listed (decision 3: the clip is shared), but which
     * sparring entry it links to is that athlete's sparring record, which a
     * coach who is not theirs cannot read. So a coach sees the link only on
     * their own athletes' tags.
     */
    const own = isOrganizationAdminRole(principal.role)
      ? null
      : await accessibleAthleteIds(principal, items.map((item) => item.athlete_id));
    return NextResponse.json({
      consent_blocked: blocked,
      items: items.map((item) => ({
        ...item,
        ...(blocked ? { note: '' } : {}),
        ...(own && !own.has(item.athlete_id) ? { exposure_id: null } : {}),
      })),
    });
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

    for (const field of ['athlete_id', 'competition_id', 'exposure_id', 'note'] as const) {
      if (body?.[field] !== undefined && body?.[field] !== null && typeof body?.[field] !== 'string') {
        throw new ValidationError(`${field} must be text.`, 'CLIP_TAG_FIELD_TYPE');
      }
    }
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
      exposureId: optionalText(body?.exposure_id),
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
        exposure_id: tag.exposure_id,
      },
    });

    return NextResponse.json(tag, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

/*
 * Link a sparring tag to the one sparring entry it shows, or clear the link
 * with exposure_id: null. Owner, Jason 2026-10-05 (overwatch-relayed): one
 * entry, optional, behind the scenes for now. The entry must be the tagged
 * athlete's own (the foreign key). A link changes no playback, so the consent
 * rules are those of reading the tag: who may see the video, and a coach only
 * for their own athlete.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    const { videoId } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object.', 'CLIP_TAG_BODY');
    }
    const unknownKey = Object.keys(body).find((key) => key !== 'tag_id' && key !== 'exposure_id');
    if (unknownKey) {
      throw new ValidationError(`Unsupported field: ${unknownKey}`, 'CLIP_TAG_FIELD_UNKNOWN');
    }
    const tagId = typeof body.tag_id === 'string' ? body.tag_id.trim() : '';
    if (!tagId) {
      throw new ValidationError('tag_id is required.', 'CLIP_TAG_ID_REQUIRED');
    }
    // Present and explicit: a string links, null clears. Absent is a mistake,
    // never read as "clear".
    if (body.exposure_id !== null && (typeof body.exposure_id !== 'string' || !body.exposure_id.trim())) {
      throw new ValidationError('exposure_id must be a sparring entry id, or null to clear the link.', 'CLIP_TAG_EXPOSURE_ID');
    }
    const exposureId = body.exposure_id === null ? null : body.exposure_id.trim();

    if (!(await staffCanSeeVideo(principal, principal.organizationId, videoId))) {
      return hiddenNotFound();
    }
    const tag = await getLiveClipTag(principal.organizationId, tagId);
    if (!tag || tag.video_session_id !== videoId) {
      return hiddenNotFound();
    }
    if (!isOrganizationAdminRole(principal.role)) {
      try {
        await assertActorCanAccessAthlete(principal, tag.athlete_id);
      } catch {
        return hiddenNotFound();
      }
    }
    if (tag.event_kind !== 'sparring') {
      throw new ExposureLinkSparringOnlyError();
    }

    const updated = await setClipTagExposure({
      organizationId: principal.organizationId,
      tagId,
      exposureId,
    });
    if (!updated) {
      // Removed between the read and the write.
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
        action: exposureId ? 'video_clip_tag_exposure_linked' : 'video_clip_tag_exposure_cleared',
        video_session_id: videoId,
        athlete_id: updated.athlete_id,
        exposure_id: updated.exposure_id,
        previous_exposure_id: tag.exposure_id,
      },
    });

    // As on GET: a clip a consent block stops shows no note.
    const blocked = (await blockedClipVideoIds(principal.organizationId, [videoId])).has(videoId);
    return NextResponse.json(blocked ? { ...updated, note: '' } : updated);
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
    let consentBlocked = false;
    if (isOrganizationAdminRole(principal.role)) {
      // The admin's removal is the deliberate exception that can let a
      // blocked clip play again, so the audit row says when it was one.
      try {
        await assertConsentCoversVideo(principal.organizationId, tag.athlete_id);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        consentBlocked = true;
      }
    } else {
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
        consent_blocked: consentBlocked,
      },
    });

    return NextResponse.json({ ok: true, tag_id: tagId });
  } catch (error) {
    return jsonError(error);
  }
}
