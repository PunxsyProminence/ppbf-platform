// videoScanSweep.ts — the loop that connects uploaded videos to a verdict.
//
// The queue-driven jobs have shadowJobProcessor; this is the equivalent for
// video scanning, and it is deliberately NOT a job type. A scan is not work
// somebody requested -- it is housekeeping the platform owes every upload --
// and modelling it as a job would have meant a new JobType, a new
// ShadowSessionType, and a widened shadow_jobs CHECK constraint for something
// no user ever asks about by job id.
//
// Sweep, not push: the upload route enqueues nothing. An upload that lands
// while the worker is down, or while no scanner is configured, is picked up
// whenever the sweep next runs, because eligibility is a property of the row
// rather than of a message somebody had to successfully send.

import { fileEscalation, type SafetyEscalationSeverity } from './escalationLadder';
import { assertGuardianMediaConsent, GuardianConsentMissingError } from './guardianConsent';
import { emitShadowEvent } from './shadowEvents';
import { scanVideoSession } from './videoScan';
import {
  claimNextVideoSessionForScan,
  isTerminalScanDecision,
  markVideoSessionsUnconfigured,
  rearmUnconfiguredVideoSessions,
  scanRetryBackoffSeconds,
  settleVideoSessionScan,
} from './videoSessions';
import {
  DEFAULT_MAX_SCAN_ATTEMPTS,
  isVideoScanConfigured,
  resolveVideoScanConfig,
  scanStateForDecision,
  videoStatusForDecision,
  type VideoScanDecision,
} from './videoScanPolicy';

// The negative terminal verdicts -- everything a human might need to act on.
// 'promote' is terminal too but needs nobody's attention; 'retry' is not
// terminal at all.
type VideoScanEscalationDecision = 'infected' | 'blocked' | 'needs_human_review';

function isEscalatingScanDecision(decision: VideoScanDecision): decision is VideoScanEscalationDecision {
  return decision === 'infected' || decision === 'blocked' || decision === 'needs_human_review';
}

/**
 * Severity per verdict, fixed by the sweep rather than caller-supplied: this
 * is the only filer for source_type 'video_scan', so there is no human
 * judgment call to thread through at filing time, unlike near_miss or
 * incident.
 *
 * 'blocked' is 'critical' -- the content screen affirmatively refused the
 * footage, and this platform's subject is video of minors. 'infected' is
 * 'high' -- a real scanner verdict and a genuine risk, but not itself a
 * claim about what the footage shows. 'needs_human_review' is 'moderate' --
 * the screen could not tell either way, which is a "look at this," not a
 * "this is wrong."
 */
function escalationSeverityForScanDecision(decision: VideoScanEscalationDecision): SafetyEscalationSeverity {
  switch (decision) {
    case 'blocked':
      return 'critical';
    case 'infected':
      return 'high';
    case 'needs_human_review':
      return 'moderate';
  }
}

function escalationReasonForScanDecision(decision: VideoScanEscalationDecision, scanReason: string): string {
  switch (decision) {
    case 'infected':
      return `Scanner found malware in this upload (${scanReason}). The file is permanently blocked -- `
        + 'no review path can release infected footage.';
    case 'blocked':
      return `The content screen refused this upload (${scanReason}). Held for administrator review -- `
        + 'the coach who uploaded it cannot release it.';
    case 'needs_human_review':
      return `The scan could not reach a verdict on this upload (${scanReason}). Held pending human review.`;
  }
}

// One video per tick by default. A scan does a blob download plus a vision
// call, so a larger batch would stretch the worker tick and delay the job
// queue behind it -- and there is no hurry: a video promoted 30 seconds later
// is indistinguishable to the coach who uploaded it.
const DEFAULT_MAX_SCANS_PER_SWEEP = 1;

export interface VideoScanSweepResult {
  scanned: number;
  promoted: number;
  blocked: number;
  /** Rows parked as 'unconfigured' because no gate exists to produce a verdict. */
  unconfigured?: number;
  skippedReason?: 'not_configured' | 'nothing_due';
}

/**
 * Scan up to `maxScans` quarantined videos.
 *
 * Returns early and does no database work at all when no gate is configured.
 * That is the difference between "this environment has not turned scanning on"
 * and "this environment scanned and found nothing to promote" -- and it stops
 * the sweep from burning an attempt per tick on every quarantined video in an
 * environment that can never produce a verdict.
 */
export async function sweepQuarantinedVideos(options: {
  maxScans?: number;
  env?: Record<string, string | undefined>;
} = {}): Promise<VideoScanSweepResult> {
  const config = resolveVideoScanConfig(options.env);
  if (!isVideoScanConfigured(config)) {
    // Settle due videos as 'unconfigured' rather than leaving them 'pending'.
    //
    // This state exists precisely for "no gate to ask", and the coach release
    // route allows it under every policy -- but nothing could ever write it.
    // decideVideoScanOutcome only returns 'hold' when zero gates are enabled,
    // and this function used to return before calling it, so the one situation
    // the state was designed for was the one situation it could not be reached
    // in. A no-scanner environment left every upload at 'pending', which the
    // release route refuses, so no video could be released by machine OR by
    // coach. Third instance of the same shape after #122 and #49: a terminal
    // state nothing can reach.
    //
    // Settling is terminal and unbounded-safe: an 'unconfigured' row is no
    // longer claimable, so each video is written once rather than burning an
    // attempt per tick -- which is what the early return was protecting.
    const marked = await markVideoSessionsUnconfigured();
    return { scanned: 0, promoted: 0, blocked: 0, unconfigured: marked, skippedReason: 'not_configured' };
  }

  // A scanner was turned on after videos were parked as 'unconfigured'. Put
  // them back in the queue, or they would sit outside the claim set forever
  // and never be scanned by the gate that now exists.
  await rearmUnconfiguredVideoSessions();

  const maxScans = Math.max(1, options.maxScans ?? DEFAULT_MAX_SCANS_PER_SWEEP);
  const result: VideoScanSweepResult = { scanned: 0, promoted: 0, blocked: 0 };

  for (let index = 0; index < maxScans; index += 1) {
    const claim = await claimNextVideoSessionForScan();
    if (!claim) {
      if (result.scanned === 0) result.skippedReason = 'nothing_due';
      break;
    }

    // The content screen sends frames of this footage to an external vision
    // deployment -- the exact action Film Study gates on
    // assertGuardianMediaConsent, under the same reasoning: this must not be
    // a side door around that gate. So a video with a named athlete does not
    // get vision-screened until a guardian has consented to media analysis.
    //
    // Consent-missing is treated as "no verdict yet", NOT as the gate being
    // off. The two look similar but are not: forcing content 'off' for this
    // call would, on an environment that also has malware scanning off (both
    // deploy workflows do -- PPBF_VIDEO_MALWARE_SCAN is left unset), leave
    // zero gates enabled, which decideVideoScanOutcome resolves to 'hold' and
    // writes scan_state 'unconfigured' -- a state claimNextVideoSessionForScan
    // never reclaims. The video would stop being scanned forever, even after
    // the guardian later consents (caught in review on PR #465; both Codex
    // and Copilot found it independently). Passing skipContentScreen instead
    // keeps the content gate enabled in config, so the outcome is the same
    // 'pending'/retry path an ordinary not-yet-arrived verdict already takes:
    // reclaimable, backed off, and re-checked against consent on every retry.
    //
    // A video with no athlete_id (the unattributed team-upload case this
    // sweep already treats specially for escalation filing) has no guardian
    // to ask, so it is unaffected here -- closing that gap is its own,
    // separate piece of work.
    let contentSkippedForConsent = false;
    if (config.content === 'vision' && claim.athlete_id) {
      try {
        await assertGuardianMediaConsent(claim.organization_id, claim.athlete_id);
      } catch (error) {
        if (!(error instanceof GuardianConsentMissingError)) throw error;
        contentSkippedForConsent = true;
      }
    }

    const scan = await scanVideoSession({
      blobPath: claim.blob_path,
      attempts: claim.scan_attempts,
      config,
      maxAttempts: DEFAULT_MAX_SCAN_ATTEMPTS,
      skipContentScreen: contentSkippedForConsent,
    });

    const nextStatus = videoStatusForDecision(scan.decision);
    const terminal = isTerminalScanDecision(scan.decision);

    await settleVideoSessionScan({
      videoSessionId: claim.video_session_id,
      scanState: scanStateForDecision(scan.decision),
      nextStatus,
      detail: {
        decision: scan.decision,
        reason: scan.reason,
        gates_enabled: scan.gatesEnabled,
        gates_passed: scan.gatesPassed,
        // Verdicts, never the model's prose. Whatever the screen said about
        // the footage stays out of the database and out of the logs.
        malware_verdict: scan.malware,
        content_verdict: scan.content,
        attempts: claim.scan_attempts,
        duration_ms: scan.durationMs,
        scanned_at: new Date().toISOString(),
        ...(contentSkippedForConsent ? { content_skipped_reason: 'guardian_consent_missing' } : {}),
      },
      retryInSeconds: terminal ? 0 : scanRetryBackoffSeconds(claim.scan_attempts),
      terminal,
    });

    result.scanned += 1;
    if (scan.decision === 'promote') result.promoted += 1;
    if (scan.decision === 'infected' || scan.decision === 'blocked') result.blocked += 1;

    // File a safety escalation for every negative terminal verdict -- this is
    // the gap this block closes: a blocked, infected, or needs_human_review
    // video used to sit only in the video-review page's own filtered list,
    // with no other surface (this ladder, the compliance center, the board)
    // aware it existed. Unlike emitShadowEvent below, this call is NOT
    // swallowed: a safety escalation failing to file silently is exactly the
    // kind of gap this closes, so a filing failure surfaces through the
    // worker's onError log and the sweep tick retries, rather than looking
    // like it succeeded. The row itself is already durably settled by this
    // point, so a failure here costs a delayed escalation, never data loss.
    //
    // Skipped when the video has no athlete_id (an unattributed team upload,
    // the same case videoScanReview.ts documents) -- safety_escalations.athlete_id
    // is not-null with a foreign key to pilot.athletes, so there is nothing to
    // file against.
    if (terminal && isEscalatingScanDecision(scan.decision) && claim.athlete_id) {
      await fileEscalation({
        organizationId: claim.organization_id,
        sourceType: 'video_scan',
        sourceId: claim.video_session_id,
        athleteId: claim.athlete_id,
        severity: escalationSeverityForScanDecision(scan.decision),
        reason: escalationReasonForScanDecision(scan.decision, scan.reason),
        triggeredBy: 'system',
        metadata: {
          video_session_id: claim.video_session_id,
          decision: scan.decision,
          reason: scan.reason,
        },
      });
    }

    // Emit only on decisions a human would want to know about. A 'retry' every
    // few minutes while Defender thinks would otherwise flood the event feed.
    if (terminal) {
      await emitShadowEvent({
        organizationId: claim.organization_id,
        eventName: 'video.scan_settled',
        entityType: 'video_session',
        entityId: claim.video_session_id,
        // No actor: the platform decided this, not a person. Recording a human
        // here would attribute an automated verdict to somebody who never saw
        // the video.
        actorAccountId: null,
        actorRole: null,
        payload: {
          decision: scan.decision,
          reason: scan.reason,
          gates_enabled: scan.gatesEnabled,
          gates_passed: scan.gatesPassed,
          status: nextStatus ?? 'quarantined',
        },
      }).catch(() => {
        // The verdict is already durable on the row. A failed event write must
        // not undo it or stop the sweep.
      });
    }
  }

  return result;
}
