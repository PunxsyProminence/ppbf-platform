// videoScanReview.ts — shared authorization for the two things a person can
// do with a quarantined video that the scan sweep could not settle.
//
// There are now three surfaces on this path and they are deliberately NOT
// interchangeable:
//
//   video/[videoId]/release  (#149) — the coach who filmed it releases footage
//     the scanner deferred ('needs_human_review' / 'unconfigured'). Refuses
//     'blocked' outright, on the argument that a coach is the last person who
//     should be able to overturn a content refusal about footage they shot.
//     That argument is right and this module does not weaken it.
//
//   video/review-link       — lets a reviewer WATCH the clip first. Both roles,
//     because releasing without seeing is the rubber stamp all of this exists
//     to avoid, and #149 shipped its release button with no way to look.
//
//   video/scan-review       — the administrator escalation. This is what
//     #149's own refusal message promises ("ask an administrator to review
//     it") and which, until now, did not exist: 'blocked' had no exit in the
//     entire platform. Organization admins only, precisely because the coach
//     is excluded from this decision.
//
// The shared part below is the state machine -- what is reviewable at all.
// Role is applied per-route, since that is exactly where these three differ.

import { assertActorCanAccessAthlete, isOrganizationAdminRole } from './access';
import type { PilotPrincipal } from './auth';
import { query } from './db';
import { getVideoSessionForReview, type VideoSessionReviewRecord } from './videoSessions';

// Watching is the wider set: a coach must be able to see their own footage
// before using the release button #149 gave them.
export const VIDEO_REVIEW_VIEW_ROLES = ['organization_admin', 'coach'] as const;

// Deciding on a REFUSED video is narrower. A content-screen 'blocked' verdict
// concerns footage of a minor, and the person who filmed it does not get to
// overturn it -- #149's reasoning, kept intact. platform_owner is absent for
// the usual reason: releasing one athlete's footage is depth, and Omega is
// broader in breadth but strictly narrower in depth.
export const VIDEO_REVIEW_DECIDE_ROLES = ['organization_admin'] as const;

export class VideoScanReviewRefused extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(reason: string, message: string, status: number) {
    super(message);
    this.name = 'VideoScanReviewRefused';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Resolve the video a reviewer is acting on, or refuse.
 *
 * Deliberate choices, each of which is a rule someone could get wrong:
 *
 * - 'infected' is refused outright, on every surface. A malware verdict came
 *   from a real scanner, not a judgment call, and no amount of human
 *   confidence makes the bytes safe. Nothing here may become the way a virus
 *   leaves quarantine.
 *
 * - Any other 'quarantined' video is reachable, whatever its scan_state --
 *   including 'blocked'. That is the whole point of the escalation route: a
 *   content screen refusing a dark or unusual training clip is a false
 *   positive somebody has to be able to resolve, and before this there was no
 *   one. Who may act on it is a role question, enforced by the caller.
 *
 * - A video already 'ready' is refused as nothing to do, rather than silently
 *   succeeding. Returning ok for a no-op teaches a reviewer their click did
 *   something.
 *
 * - A non-admin caller must be the UPLOADER, exactly as
 *   video/[videoId]/release requires. Without this the review surfaces were
 *   wider than the gate they serve: any coach assigned to the athlete could
 *   mint a playback link for a quarantined clip another coach uploaded, and
 *   for unattributed team video -- which has no athlete to check -- ANY coach
 *   in the organization could, since the athlete branch below simply does not
 *   run. That made review-link an alternate playback path around
 *   "held until released". Caught in review of #150.
 *
 * - Athlete access is asserted against the ROW's athlete_id, never a
 *   caller-supplied one.
 *
 * - Every "does not exist" and "exists but forbidden" outcome returns the SAME
 *   404-shaped refusal, so a caller cannot use this route to discover that a
 *   video_session_id is real. Same rule the sibling [videoId] read route holds
 *   for issue #8's 403-vs-404 disclosure requirement -- and it has to be
 *   enforced here rather than left to assertActorCanAccessAthlete, whose
 *   throw is a 403 that answers the question.
 */
export async function authorizeVideoScanReview(
  principal: PilotPrincipal,
  videoSessionId: string,
): Promise<VideoSessionReviewRecord> {
  const notFound = () => new VideoScanReviewRefused('VIDEO_SESSION_NOT_FOUND', 'Not found', 404);

  const video = await getVideoSessionForReview(principal.organizationId, videoSessionId);
  if (!video) {
    throw notFound();
  }

  if (!isOrganizationAdminRole(principal.role) && video.uploaded_by_account_id !== principal.accountId) {
    throw notFound();
  }

  if (video.athlete_id) {
    try {
      await assertActorCanAccessAthlete(principal, video.athlete_id);
    } catch {
      throw notFound();
    }
  }

  // State refusals come AFTER the existence and access checks, so their more
  // specific messages are only ever shown to someone already entitled to know
  // the video exists.
  if (video.status === 'infected') {
    throw new VideoScanReviewRefused(
      'VIDEO_SESSION_INFECTED',
      'A scanner found malware in this file. It cannot be released by review.',
      409,
    );
  }

  if (video.status !== 'quarantined') {
    throw new VideoScanReviewRefused(
      'VIDEO_SESSION_NOT_QUARANTINED',
      `This video is '${video.status}', so there is nothing to review.`,
      409,
    );
  }

  return video;
}

/*
 * THE REVIEW A RELEASE RESTS ON, CHECKED ON THE SERVER.
 *
 * WHAT THIS PROVES, EXACTLY: that this platform issued THIS actor a review
 * link for THIS video, against the scan verdict the video carries NOW, within
 * the last fifteen minutes.
 *
 * WHAT IT DOES NOT PROVE, AND MUST NEVER BE DESCRIBED AS PROVING: that anybody
 * watched anything. review-link mints a read-only SAS and the browser fetches
 * the bytes from Azure Storage directly, so this application never observes
 * the footage being played. Proving viewing would need a record of the read
 * that nothing here creates. Every message on this path therefore says "review
 * link" and never "watched", "viewed" or "reviewed".
 *
 * WHY IT WAS ONLY A UI GATE BEFORE. The Film Study console disables Release
 * until a review link succeeds, but that is page state: a direct POST to the
 * release route was accepted with nothing opened. The footage most likely to
 * need a human look is a minor's quarantined video that no scanner could
 * clear, so the check belongs on the server.
 *
 * THE FIFTEEN MINUTES ARE THE CREDENTIAL'S OWN LIFETIME, not a number chosen
 * here: review-link issues a SAS that expires in fifteen. Without a bound, a
 * link issued months ago would satisfy this forever.
 *
 * THE SCAN STATE IS BOUND FOR THE SAME REASON. A link issued while a video was
 * 'unconfigured' must not authorise a release after a re-scan moved it to
 * 'blocked': the actor would be acting on a verdict that no longer holds.
 *
 * NOT SINGLE USE, and that limit is real. Any qualifying row satisfies the
 * check until it ages out, and there is nowhere to mark one consumed without
 * persistence this slice may not add.
 */
export const REVIEW_LINK_VALID_MINUTES = 15;

export async function assertActorHoldsCurrentReviewLink(
  principal: PilotPrincipal,
  videoSessionId: string,
  currentScanState: string,
): Promise<void> {
  const held = await query<{ audit_id: string }>(
    `select audit_id from pilot.audit_events
      where organization_id = $1
        and actor_account_id = $2
        and entity_type = 'video_session'
        and entity_id = $3
        and details->>'action' = 'video_review_link_issued'
        and details->>'scan_state' = $4
        and created_at >= now() - ($5 || ' minutes')::interval
      limit 1`,
    [
      principal.organizationId,
      principal.accountId,
      videoSessionId,
      currentScanState,
      String(REVIEW_LINK_VALID_MINUTES),
    ],
  );

  if (held.length === 0) {
    /*
     * PER ACTOR, INCLUDING ADMINISTRATORS. A link opened by the coach who
     * filmed it does not stand in for the admin who releases it: admin
     * authority decides WHOSE footage may be resolved, not whether the person
     * taking the irreversible action looked first.
     *
     * 'Forbidden' so http.ts maps it to 403, and worded as an instruction
     * because it is one -- the caller can satisfy it immediately.
     */
    throw new Error(
      'Forbidden: open the review link for this footage before releasing it',
    );
  }
}
