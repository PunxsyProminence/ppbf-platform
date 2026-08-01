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

import { emitShadowEvent } from './shadowEvents';
import { scanVideoSession } from './videoScan';
import {
  claimNextVideoSessionForScan,
  isTerminalScanDecision,
  scanRetryBackoffSeconds,
  settleVideoSessionScan,
} from './videoSessions';
import {
  DEFAULT_MAX_SCAN_ATTEMPTS,
  isVideoScanConfigured,
  resolveVideoScanConfig,
  scanStateForDecision,
  videoStatusForDecision,
} from './videoScanPolicy';

// One video per tick by default. A scan does a blob download plus a vision
// call, so a larger batch would stretch the worker tick and delay the job
// queue behind it -- and there is no hurry: a video promoted 30 seconds later
// is indistinguishable to the coach who uploaded it.
const DEFAULT_MAX_SCANS_PER_SWEEP = 1;

export interface VideoScanSweepResult {
  scanned: number;
  promoted: number;
  blocked: number;
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
    return { scanned: 0, promoted: 0, blocked: 0, skippedReason: 'not_configured' };
  }

  const maxScans = Math.max(1, options.maxScans ?? DEFAULT_MAX_SCANS_PER_SWEEP);
  const result: VideoScanSweepResult = { scanned: 0, promoted: 0, blocked: 0 };

  for (let index = 0; index < maxScans; index += 1) {
    const claim = await claimNextVideoSessionForScan();
    if (!claim) {
      if (result.scanned === 0) result.skippedReason = 'nothing_due';
      break;
    }

    const scan = await scanVideoSession({
      blobPath: claim.blob_path,
      attempts: claim.scan_attempts,
      config,
      maxAttempts: DEFAULT_MAX_SCAN_ATTEMPTS,
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
      },
      retryInSeconds: terminal ? 0 : scanRetryBackoffSeconds(claim.scan_attempts),
      terminal,
    });

    result.scanned += 1;
    if (scan.decision === 'promote') result.promoted += 1;
    if (scan.decision === 'infected' || scan.decision === 'blocked') result.blocked += 1;

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
