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

import { assertActorCanAccessAthlete } from './access';
import type { PilotPrincipal } from './auth';
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
 * - Athlete access is asserted against the ROW's athlete_id, never a
 *   caller-supplied one.
 */
export async function authorizeVideoScanReview(
  principal: PilotPrincipal,
  videoSessionId: string,
): Promise<VideoSessionReviewRecord> {
  const video = await getVideoSessionForReview(principal.organizationId, videoSessionId);
  if (!video) {
    throw new VideoScanReviewRefused('VIDEO_SESSION_NOT_FOUND', 'Not found', 404);
  }

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

  if (video.athlete_id) {
    await assertActorCanAccessAthlete(principal, video.athlete_id);
  }

  return video;
}
