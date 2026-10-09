// POST /api/pilot/video/[videoId]/archive — take footage out of circulation,
// or put it back.
//
// THE MISSING HALF OF A STATUS THAT ALREADY EXISTED. 'archived' has been in the
// video_sessions status CHECK constraint since that table shipped and every
// gate in the platform already honours it, but nothing could write it. The only
// way to withdraw footage was an UPDATE typed against the production database
// by hand. See videoArchive.ts for what archive does and does not mean -- the
// short version is that it stops the platform serving, clipping, labelling or
// counting the footage, and does NOT delete the media.
//
// THE SAME AUTHORITY SHAPE AS RELEASE, deliberately. A coach may withdraw
// footage they uploaded, provided they still reach an athlete in it; an
// organization admin may withdraw any of the organization's. Release already
// draws that line for the opposite transition, and a coach who may put their
// own footage INTO circulation should not need to find an administrator to take
// it back out -- that asymmetry is how a gym ends up with test footage nobody
// can remove.
//
// ENTITLEMENT FAILURES RETURN hiddenNotFound(), matching the sibling read and
// release routes: a coach whose list does not include a session must not learn
// it exists by trying to archive it.
import { NextResponse, type NextRequest } from 'next/server';

import {
  accessibleAthleteIds,
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  isOrganizationAdminRole,
  requireRole,
} from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { queryOne } from '@/src/server/pilot/db';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import {
  ARCHIVABLE_STATUS,
  ARCHIVED_STATUS,
  setVideoArchiveState,
  type VideoArchiveAction,
} from '@/src/server/pilot/videoArchive';
import { listLiveTagSubjects } from '@/src/server/pilot/videoClipTags';

export const runtime = 'nodejs';

const ACTIONS = new Set<VideoArchiveAction>(['archive', 'restore']);

interface VideoSessionRow {
  video_session_id: string;
  status: string;
  athlete_id: string | null;
  capture_take_id: string | null;
  uploaded_by_account_id: string;
  file_name: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    const { videoId } = await params;

    const body = await request.json().catch(() => ({}));
    // Kept as unknown until checked, so "absent" and "misspelled" stay
    // distinguishable -- the comparison a narrowed type would forbid is the
    // one a client author needs answered. Same handling as scan-review.
    const rawAction: unknown = body?.action ?? 'archive';
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 2_000) : undefined;

    if (!ACTIONS.has(rawAction as VideoArchiveAction)) {
      // "Unsupported" rather than "Invalid": jsonError maps status by message
      // PREFIX, and anything it does not recognize becomes a 500 whose body is
      // replaced with "Internal server error" -- telling the caller less than
      // the wording it replaced.
      throw new Error('Unsupported action: expected "archive" or "restore"');
    }
    const action = rawAction as VideoArchiveAction;

    const row = await queryOne<VideoSessionRow>(
      `select video_session_id, status, athlete_id, capture_take_id, uploaded_by_account_id, file_name
         from pilot.video_sessions
        where video_session_id = $1 and organization_id = $2`,
      [videoId, principal.organizationId],
    );

    if (!row) {
      return hiddenNotFound();
    }
    if (!isOrganizationAdminRole(principal.role)) {
      if (row.uploaded_by_account_id !== principal.accountId) {
        return hiddenNotFound();
      }
      // Having uploaded footage is not a standing claim on the athlete in it
      // (CL-A21). A coach who has since lost the assignment no longer reaches
      // that athlete, so they may not restore -- or archive -- the footage
      // either; videoScanReview.ts holds the same line for reviewing it.
      // Teaching footage names nobody, so the uploader rule alone applies.
      if (row.athlete_id) {
        try {
          await assertActorCanAccessAthlete(principal, row.athlete_id);
        } catch {
          return hiddenNotFound();
        }
      }
    }

    /*
     * EVERY CHILD THE CLIP SHOWS (videoClipTags.ts). The uploader rule above
     * cannot see the tags: a coach who uploaded untagged team footage that
     * another coach then tagged with a child the uploader does not coach was
     * entitled on the upload alone, and could take that child's clip out of
     * circulation or put it back. Playback's rule for a tagged clip
     * (video/[videoId]/route.ts; release holds it too): a coach must reach at
     * least one athlete in it, own athlete included; an organization admin
     * reaches every athlete in the organization and is not asked. Read after
     * the entitlement refusals above, so a tag's not-found never confirms a
     * video exists to a caller those already refused, and before the state
     * refusal below, with the other entitlement refusals.
     *
     * RESTORE IS A RELEASE, so it also asks whether the athletes are still
     * here: a deleted athlete's footage reads as not found everywhere else
     * (deletedAthletes.ts) and restoring it would bring it back into
     * circulation. ARCHIVE DOES NOT ASK THAT. Withdrawing footage of a child
     * the gym has deleted is the protective direction, and refusing it would
     * leave that footage the one kind nobody could take down.
     */
    const tagged = await listLiveTagSubjects(principal.organizationId, videoId);
    if (action === 'restore') {
      if (tagged.some((subject) => subject.athlete_deleted)) {
        return hiddenNotFound();
      }
      if (row.athlete_id) {
        try {
          await assertAthleteBelongsToOrganization(principal.organizationId, row.athlete_id);
        } catch {
          return hiddenNotFound();
        }
      }
    }
    if (tagged.length > 0 && !isOrganizationAdminRole(principal.role)) {
      const subjects = [...new Set([
        ...(row.athlete_id ? [row.athlete_id] : []),
        ...tagged.map((subject) => subject.athlete_id),
      ])];
      const reach = await accessibleAthleteIds(principal, subjects);
      if (reach.size === 0) {
        return hiddenNotFound();
      }
    }

    /*
     * THE STATE REFUSAL IS SPECIFIC, and it runs only after the two
     * entitlement refusals above, so it reaches nobody who was not already
     * entitled to know this video exists. That ordering is what lets it name
     * the status without becoming a disclosure oracle -- the rule
     * videoScanReview.ts states for its own state refusals.
     */
    const requiredStatus = action === 'archive' ? ARCHIVABLE_STATUS : ARCHIVED_STATUS;
    if (row.status !== requiredStatus) {
      return NextResponse.json(
        {
          error: action === 'archive'
            ? row.status === ARCHIVED_STATUS
              ? 'This footage is already archived.'
              : `Only released footage can be archived, and this is "${row.status}". Footage that is still held is not in circulation yet.`
            : 'This footage is not archived, so there is nothing to restore.',
          status: row.status,
        },
        { status: 409 },
      );
    }

    const updated = await setVideoArchiveState({
      organizationId: principal.organizationId,
      videoSessionId: videoId,
      action,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      reason,
    });

    if (!updated) {
      // The row left the status this caller inspected between the read above
      // and the write -- a scan-review, another operator, or the same person in
      // a second tab. Reporting success would tell them their decision stuck.
      return NextResponse.json(
        {
          error: 'This footage changed state while you were looking at it. Reload and check before deciding again.',
          reason: 'VIDEO_SESSION_CHANGED',
        },
        { status: 409 },
      );
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_session',
      entity_id: videoId,
      details: {
        action: action === 'archive' ? 'video_archived' : 'video_restored',
        prior_status: row.status,
        resulting_status: updated.status,
        // Null on teaching footage by design -- Teach Shadow media names
        // nobody. Recorded rather than omitted so the audit row says which
        // kind of footage this was without a second lookup.
        athlete_id: updated.athlete_id,
        teaching_footage: updated.capture_take_id !== null,
        file_name: updated.file_name,
        reason: reason ?? '',
      },
      shadow_mirror: false,
    });

    /*
     * WHY AN EVENT AND NOT ONLY AN AUDIT ROW. Archiving a source video retracts
     * every clip and label cut from it from the corpus counts, so a coverage
     * figure that was true this morning is different this afternoon with no
     * capture and no labelling to explain it. This is the record that explains
     * the step.
     */
    await emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: action === 'archive' ? 'video.archived' : 'video.restored',
      entityType: 'video_session',
      entityId: videoId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: {
        prior_status: row.status,
        status: updated.status,
        teaching_footage: updated.capture_take_id !== null,
        reason: reason ?? null,
      },
    }).catch(() => {
      // The decision is already durable on the row and in the audit trail.
    });

    return NextResponse.json({
      ok: true,
      video_session_id: videoId,
      action,
      status: updated.status,
    });
  } catch (error) {
    return jsonError(error);
  }
}
