import { query, queryOne } from './db';
import type { VideoScanDecision } from './videoScanPolicy';

export interface VideoSessionRecord {
  video_session_id: string;
  organization_id: string;
  athlete_id: string | null;
  // Read by the Film Study executor to fetch the source clip. Never taken
  // from a request: the row is the authority for which blob gets analyzed.
  blob_path: string;
  // Uploads are born 'quarantined' pending scan (#125). Film Study refuses
  // anything that has not reached 'ready', so an unscanned or infected file
  // is never opened by the worker. The scan sweep (#49) is the only thing in
  // the platform that writes 'ready'.
  status: string;
}

export interface VideoScanClaim extends VideoSessionRecord {
  scan_attempts: number;
}

export async function getVideoSessionById(
  organizationId: string,
  videoSessionId: string,
): Promise<VideoSessionRecord | null> {
  return queryOne<VideoSessionRecord>(
    `select video_session_id, organization_id, athlete_id, blob_path, status
     from pilot.video_sessions
     where organization_id = $1 and video_session_id = $2`,
    [organizationId, videoSessionId],
  );
}

export interface VideoSessionReviewRecord extends VideoSessionRecord {
  title: string;
  file_name: string;
  scan_state: string;
  scan_detail: Record<string, unknown>;
}

/**
 * Load a video for human review, including the scan verdict being reviewed.
 *
 * Separate from getVideoSessionById because a reviewer needs to see WHAT the
 * scan concluded before overriding it -- approving a video without knowing the
 * screen refused it is the rubber stamp this whole surface exists to avoid.
 */
export async function getVideoSessionForReview(
  organizationId: string,
  videoSessionId: string,
): Promise<VideoSessionReviewRecord | null> {
  return queryOne<VideoSessionReviewRecord>(
    `select video_session_id, organization_id, athlete_id, blob_path, status,
            title, file_name, scan_state, scan_detail
     from pilot.video_sessions
     where organization_id = $1 and video_session_id = $2`,
    [organizationId, videoSessionId],
  );
}

export type VideoScanReviewDecision = 'approve' | 'block';

/**
 * The human closure of the scan's deferred judgment.
 *
 * The automated screen can say "I am not sure" (needs_human_review) or "no"
 * (blocked), and until this existed neither had an exit -- a video could reach
 * a state where the platform had made a decision no person could answer. This
 * is the answer, and it follows reviewIntakeDocumentSecurity: a named human
 * looks at the thing and attests.
 *
 * 'approve' is the only path that sets status='ready'. 'block' leaves the row
 * quarantined, so a rejected video stays exactly as unreadable as it was.
 *
 * The attestation is MERGED into scan_detail rather than replacing it, so the
 * machine verdict the human overrode survives alongside the override. A
 * human-released video must never be indistinguishable from one the screen
 * passed on its own -- that difference is the entire audit value here.
 *
 * The `status = 'quarantined'` guard is what stops this from resurrecting an
 * archived video, and refusing 'infected' upstream is what stops it being used
 * to release malware: a virus is not a judgment call.
 */
export async function reviewVideoSessionScan(params: {
  organizationId: string;
  videoSessionId: string;
  decision: VideoScanReviewDecision;
  priorScanState: string;
  reviewedByAccountId: string;
  reviewedByRole: string;
  notes?: string;
}): Promise<VideoSessionReviewRecord | null> {
  const approved = params.decision === 'approve';

  return queryOne<VideoSessionReviewRecord>(
    `update pilot.video_sessions
     set status = case when $3 then 'ready' else status end,
         scan_state = case when $3 then 'passed' else 'blocked' end,
         scanned_at = now(),
         scan_claimed_at = null,
         scan_detail = scan_detail || $4::jsonb,
         updated_at = now()
     where organization_id = $1
       and video_session_id = $2
       and status = 'quarantined'
     returning video_session_id, organization_id, athlete_id, blob_path, status,
               title, file_name, scan_state, scan_detail`,
    [
      params.organizationId,
      params.videoSessionId,
      approved,
      JSON.stringify({
        human_review: {
          decision: params.decision,
          // What the machine had concluded at the moment a person overrode it.
          prior_scan_state: params.priorScanState,
          reviewed_by_account_id: params.reviewedByAccountId,
          reviewed_by_role: params.reviewedByRole,
          reviewed_at: new Date().toISOString(),
          notes: params.notes ?? null,
        },
      }),
    ],
  );
}

// A claim older than this is assumed to belong to a worker that died mid-scan
// and is eligible to be taken over. Comfortably longer than a scan's worst
// case (a 512MB download plus a 120s vision timeout) so a slow scan is never
// stolen from a worker that is still running it.
const SCAN_CLAIM_STALE_SECONDS = 900;

/**
 * Claim one quarantined video for scanning, or return null if none is due.
 *
 * FOR UPDATE SKIP LOCKED plus the scan_state transition means two workers --
 * two replicas, or a sweep overlapping an ops call -- can never scan the same
 * video concurrently, the same guarantee claimNextJob gives the job queue.
 *
 * Increments scan_attempts as part of the claim rather than at settle time, so
 * a worker that crashes mid-scan still burns an attempt. Otherwise a video
 * that reliably kills the worker would be retried forever.
 */
export async function claimNextVideoSessionForScan(): Promise<VideoScanClaim | null> {
  return queryOne<VideoScanClaim>(
    `update pilot.video_sessions
     set scan_state = 'scanning',
         scan_claimed_at = now(),
         scan_attempts = scan_attempts + 1,
         updated_at = now()
     where video_session_id = (
       select video_session_id
       from pilot.video_sessions
       where status = 'quarantined'
         and (
           (scan_state = 'pending' and scan_next_attempt_at <= now())
           or (scan_state = 'scanning' and scan_claimed_at < now() - ($1::int * interval '1 second'))
         )
       order by created_at asc
       for update skip locked
       limit 1
     )
     returning video_session_id, organization_id, athlete_id, blob_path, status, scan_attempts`,
    [SCAN_CLAIM_STALE_SECONDS],
  );
}

/**
 * Record a scan outcome, and move status ONLY when the decision says to.
 *
 * The `status = 'quarantined'` guard is not redundant with the claim: it
 * closes the window between claiming a row and settling it, so a scan that
 * started before an operator archived or re-quarantined a video cannot resurrect
 * it as 'ready' minutes later.
 */
export async function settleVideoSessionScan(params: {
  videoSessionId: string;
  scanState: string;
  nextStatus: string | null;
  detail: Record<string, unknown>;
  retryInSeconds: number;
  terminal: boolean;
}): Promise<boolean> {
  const rows = await query<{ video_session_id: string }>(
    `update pilot.video_sessions
     set status = coalesce($3, status),
         scan_state = $2,
         scan_detail = $4::jsonb,
         scanned_at = case when $6 then now() else scanned_at end,
         scan_claimed_at = null,
         scan_next_attempt_at = now() + ($5::int * interval '1 second'),
         updated_at = now()
     where video_session_id = $1
       and status = 'quarantined'
     returning video_session_id`,
    [
      params.videoSessionId,
      params.scanState,
      params.nextStatus,
      JSON.stringify(params.detail),
      Math.max(0, Math.trunc(params.retryInSeconds)),
      params.terminal,
    ],
  );
  return rows.length > 0;
}

/**
 * Backoff between scan attempts, in seconds.
 *
 * Defender for Storage writes its verdict asynchronously and is not quick
 * about it, so a fixed retry at worker cadence would exhaust the attempt
 * budget in four minutes and send every upload to human review before the
 * scanner had answered. Doubling from the worker's own 30s tick reaches the
 * 8-attempt ceiling about 64 minutes after upload instead.
 */
export function scanRetryBackoffSeconds(attempts: number): number {
  const capped = Math.min(Math.max(attempts, 1), 8);
  return Math.min(30 * 2 ** (capped - 1), 1_800);
}

/** Decisions after which retrying is pointless: the verdict will not change. */
export function isTerminalScanDecision(decision: VideoScanDecision): boolean {
  return decision === 'promote'
    || decision === 'infected'
    || decision === 'blocked'
    || decision === 'needs_human_review';
}
