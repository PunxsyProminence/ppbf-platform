import { queryOne } from './db';

/*
 * WITHDRAWING FOOTAGE FROM CIRCULATION, AND PUTTING IT BACK.
 *
 * WHY THIS EXISTS. pilot.video_sessions.status has admitted 'archived' since
 * the video-sessions migration shipped, and nothing in the platform has ever
 * written it. Every gate already treats it correctly -- assertVideoClippable
 * refuses anything that is not 'ready', /api/pilot/video/[videoId] returns
 * hiddenNotFound() for the same reason, the Film Study list pins 'ready', and
 * authorizeVideoScanReview only ever returns a quarantined row, so no review
 * link can be minted either. The status was a complete exit with no door.
 *
 * So the first time footage needed taking out of circulation there was nothing
 * to click and nothing to call: the only way was a hand-written UPDATE against
 * the production database. That is the defect this closes.
 *
 * ARCHIVE IS NOT DELETION, and every caller has to be told so rather than
 * discovering it. The row stays, the audit trail stays, and THE MEDIA STAYS IN
 * BLOB STORAGE. What changes is that nothing in the platform will serve it,
 * clip it, label it or count it. Deleting the bytes is a different action with
 * a different risk, and conflating the two would mean an operator reaching for
 * the reversible one and getting the permanent one.
 *
 * WHICH IS WHY IT IS REVERSIBLE. An archive that could not be undone would be
 * a permanent consequence behind a single click, and the first mis-click would
 * send somebody back to the SQL prompt this exists to replace.
 *
 * FROM 'ready' ONLY, AND BACK TO 'ready' ONLY.
 *
 * That pairing is the whole reason restore is safe. Footage still held --
 * 'quarantined', 'infected', 'error' -- is not archivable here, so 'archived'
 * can only ever have come from 'ready', so restoring to 'ready' returns a row
 * exactly where it was and can never promote unscreened footage.
 *
 * The alternative was recording a prior status and restoring to that, which
 * reads as more general and is strictly worse: it makes restore a path from
 * quarantine to playback whose safety depends on a jsonb field being right. A
 * narrower archive needs no such proof. Held footage already has its own
 * surface and cannot be labelled anyway, so nothing is stranded by leaving it
 * out.
 */

/** The statuses this module moves a video between. Nothing else is touched. */
export const ARCHIVABLE_STATUS = 'ready';
export const ARCHIVED_STATUS = 'archived';

export type VideoArchiveAction = 'archive' | 'restore';

export interface VideoArchiveRecord {
  video_session_id: string;
  organization_id: string;
  status: string;
  file_name: string;
  athlete_id: string | null;
  capture_take_id: string | null;
  uploaded_by_account_id: string;
}

/**
 * Move one video into or out of 'archived'.
 *
 * COMPARE-AND-SET ON THE STATUS THE CALLER INSPECTED, not merely a WHERE on
 * the id. Two people can be looking at the same queue, and a sweep or a
 * scan-review can change a row underneath either of them. Returning null on a
 * miss lets the route say "this changed while you were looking at it" instead
 * of reporting a success that never happened -- the same discipline
 * reviewVideoSessionScan applies for the same reason.
 *
 * The reason is recorded on the row rather than only in the audit log. An
 * operator reading the archived list needs to know why footage was pulled
 * without going to a different system to find out, and scan_detail is already
 * where this table keeps its human decisions (see human_review).
 */
export async function setVideoArchiveState(params: {
  organizationId: string;
  videoSessionId: string;
  action: VideoArchiveAction;
  actorAccountId: string;
  actorRole: string;
  reason?: string;
}): Promise<VideoArchiveRecord | null> {
  const archiving = params.action === 'archive';
  const requiredStatus = archiving ? ARCHIVABLE_STATUS : ARCHIVED_STATUS;
  const nextStatus = archiving ? ARCHIVED_STATUS : ARCHIVABLE_STATUS;

  return queryOne<VideoArchiveRecord>(
    `update pilot.video_sessions
        set status = $4,
            scan_detail = scan_detail || $5::jsonb,
            updated_at = now()
      where organization_id = $1
        and video_session_id = $2
        and status = $3
      returning video_session_id, organization_id, status, file_name, athlete_id,
                capture_take_id, uploaded_by_account_id`,
    [
      params.organizationId,
      params.videoSessionId,
      requiredStatus,
      nextStatus,
      /*
       * ONE KEY, OVERWRITTEN EACH TIME, rather than an appended history. The
       * `||` operator replaces a repeated key, so this records the CURRENT
       * archive decision; the full sequence of them is in pilot_audit_events,
       * which is append-only and is the right place for a history. Keeping a
       * second history here would give two answers to "why is this archived"
       * and no rule for which wins.
       */
      JSON.stringify({
        archive: {
          action: params.action,
          decided_by_account_id: params.actorAccountId,
          decided_by_role: params.actorRole,
          decided_at: new Date().toISOString(),
          reason: params.reason ?? null,
        },
      }),
    ],
  );
}
