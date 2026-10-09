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
import { resolveScanSubject } from './captureParticipants';
import { PilotError } from './errors';
import { withTransaction } from './db';
import {
  assertGuardianMediaConsent,
  GuardianConsentMissingError,
  lockGuardianLinksForAthletes,
  type QueryExecutor,
} from './guardianConsent';
import { emitShadowEvent } from './shadowEvents';
import { listLiveTagSubjects } from './videoClipTags';
import { assertConsentCoversVideo } from './videoPlaybackConsent';
import { scanVideoSession, VIDEO_SCAN_VISION_TIMEOUT_MS, type VisionCallGuard } from './videoScan';
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

/*
 * CL-B1: the refusals assertConsentCoversVideo can make, each a decision a
 * guardian made (or a record the platform cannot read) rather than a fault.
 * Each becomes a skip; anything else it throws is a fault and propagates.
 */
const COVERAGE_SKIP_REASONS: Record<string, string> = {
  GUARDIAN_CONSENT_WITHDRAWN: 'guardian_consent_withdrawn',
  GUARDIAN_CONSENT_EXCLUDES_VIDEO: 'guardian_consent_excludes_video',
  GUARDIAN_CONSENT_UNREADABLE: 'guardian_consent_unreadable',
};

/*
 * The skip reason for the first athlete whose consent refuses the screen, or
 * null. Both checks run for each athlete, as CL-B1 requires; the coverage
 * refusal, when there is one, is the reason recorded. With a client, every
 * read holds that athlete's guardian links FOR SHARE until the transaction
 * ends (guardianConsent.ts).
 */
async function consentSkipReason(
  organizationId: string,
  athleteIds: readonly string[],
  client?: QueryExecutor,
): Promise<string | null> {
  const inTx: [] | [QueryExecutor] = client ? [client] : [];
  let reason: string | null = null;
  for (const athleteId of athleteIds) {
    if (reason) break;
    try {
      await assertGuardianMediaConsent(organizationId, athleteId, ...inTx);
    } catch (error) {
      if (!(error instanceof GuardianConsentMissingError)) throw error;
      reason = 'guardian_consent_missing';
    }
    try {
      await assertConsentCoversVideo(organizationId, athleteId, ...inTx);
    } catch (error) {
      const coverage = error instanceof PilotError && error.code ? COVERAGE_SKIP_REASONS[error.code] : undefined;
      if (!coverage) throw error;
      reason = coverage;
    }
  }
  return reason;
}

/*
 * How long the re-check below may wait for any one lock before it gives up.
 * A give-up throws inside the content screen, which returns null: the
 * ordinary pending/retry path, never a send.
 */
const VIDEO_SCAN_RECHECK_LOCK_TIMEOUT_MS = 10_000;

/*
 * REVIEWER B ON #1369: THE FIRST CHECK IS NOT THE LAST WORD.
 *
 * The check in the sweep loop is plain reads, and then the blob is downloaded
 * and cut into frames, which takes seconds. A guardian's withdrawal, a
 * photo-only change or a coach's tag naming a photo-only child, committed in
 * that window, was never seen: the frames went out on consent that no longer
 * stood.
 *
 * So the vision call itself runs inside this transaction, after a second
 * check made under locks that every one of those writes has to wait for:
 *   1. the consent-set lock SHARED and the guardian links FOR SHARE, for every
 *      athlete the video can name (consentSetLock.ts, #1270's order). A
 *      withdrawal or photo-only grant (recordMediaConsentAndSuppress, links
 *      FOR UPDATE) and a new guardian link (consent set EXCLUSIVE) wait;
 *   2. then the video row FOR SHARE. addClipTag locks that row FOR UPDATE
 *      before it inserts, so a new tag waits. The row comes after the consent
 *      locks, the order scan-review's approve already takes them in.
 * A tag that landed before the row lock but after the athletes were chosen
 * names someone not locked in step 1; that skips this attempt, and the next
 * retry asks them.
 *
 * Held through the vision call (Overwatch's ruling for this fix, option b),
 * so nothing can commit between the check and the send. The cost is that
 * those writers wait for the call: at most VIDEO_SCAN_VISION_TIMEOUT_MS, and
 * idle_in_transaction_session_timeout ends the session (dropping the locks)
 * shortly after that if the call somehow outlives its own abort. The sweep
 * runs one scan at a time and the worker chains its ticks
 * (shadowJobWorker.ts), so this holds one pooled connection at most.
 */
export function recheckBeforeVision(
  organizationId: string,
  videoSessionId: string,
  claimAthleteId: string | null,
  onSkip: (reason: string) => void,
): VisionCallGuard {
  return async <T>(send: () => Promise<T>) => {
    let sent = false;
    // The transaction sits idle, with no query running, for the whole vision
    // call. If idle_in_transaction_session_timeout ends the session then, pg
    // emits 'error' on the client (pg/lib/client.js _handleErrorMessage), and
    // pg-pool removes its own listener while a client is checked out
    // (pg-pool _acquireClient): unheard, that is an uncaught exception in the
    // web server. Heard here until the client is back in the pool, the COMMIT
    // fails instead, which the content screen turns into a retry.
    const ignoreDroppedSession = () => {};
    let held: { off(event: 'error', listener: () => void): unknown } | null = null;
    try {
      return await withTransaction(async (client): Promise<T | null> => {
        client.on('error', ignoreDroppedSession);
        held = client;
        await client.query(`set local lock_timeout = '${VIDEO_SCAN_RECHECK_LOCK_TIMEOUT_MS}ms'`);
        await client.query(
          `set local idle_in_transaction_session_timeout = '${VIDEO_SCAN_VISION_TIMEOUT_MS + 5_000}ms'`,
        );

        const firstLook = await listLiveTagSubjects(organizationId, videoSessionId, client);
        const locked = new Set([
          ...(claimAthleteId ? [claimAthleteId] : []),
          ...firstLook.map((tag) => tag.athlete_id),
        ]);
        await lockGuardianLinksForAthletes(client, organizationId, [...locked].sort(), 'share');

        // The video's own athlete deleted since the claim (Scope B: a deleted
        // athlete's footage is not sent to the vision screen). Read, not
        // locked: deletion, the purge and other writers lock the athlete
        // row FOR UPDATE ahead of their own later locks, and taking it
        // here, after the consent set and the video row, would risk a
        // cycle. A deletion landing during the call itself is not held off.
        const video = await client.query<{ athlete_id: string | null; athlete_deleted: boolean }>(
          `select v.athlete_id, (a.deleted_at is not null) as athlete_deleted
             from pilot.video_sessions v
             left join pilot.athletes a
               on a.organization_id = v.organization_id and a.athlete_id = v.athlete_id
            where v.organization_id = $1 and v.video_session_id = $2
            for share of v`,
          [organizationId, videoSessionId],
        );
        const row = video.rows[0];
        if (!row) {
          onSkip('video_missing');
          return null;
        }
        if (row.athlete_deleted) {
          onSkip('athlete_deleted');
          return null;
        }

        const tags = await listLiveTagSubjects(organizationId, videoSessionId, client);
        if (tags.some((tag) => tag.athlete_deleted)) {
          onSkip('tagged_athlete_deleted');
          return null;
        }
        const athleteIds = [...new Set([
          ...(row.athlete_id ? [row.athlete_id] : []),
          ...tags.map((tag) => tag.athlete_id),
        ])];
        if (athleteIds.some((id) => !locked.has(id))) {
          onSkip('tag_subjects_changed');
          return null;
        }

        const reason = await consentSkipReason(organizationId, athleteIds, client);
        if (reason) {
          onSkip(reason);
          return null;
        }
        sent = true;
        return await send();
      });
    } catch (error) {
      // A lock wait past lock_timeout or a database fault, before anything was
      // sent: fail closed (the content screen turns the throw into null, the
      // pending/retry path) and say so in scan_detail rather than looking
      // like a verdict that has not arrived. A vision failure is not this.
      if (!sent) onSkip('recheck_failed');
      throw error;
    } finally {
      (held as { off(event: 'error', listener: () => void): unknown } | null)?.off('error', ignoreDroppedSession);
    }
  };
}

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
    // TS-ANON-01: WHICH CONSENT, AND WHOSE, NOW DEPENDS ON THE DESTINATION.
    //
    // claim.athlete_id can no longer answer this. A teaching video carries
    // none by design, and "no athlete_id" used to mean "an unattributed team
    // upload with no guardian to ask" -- so keying off it would send every
    // properly anonymised child's footage to the content screen with the
    // consent check skipped entirely. That is the failure this slice exists to
    // prevent, arriving through the gate meant to stop it.
    //
    // So the destination is resolved first. Film Study asks publication media
    // consent, exactly as before. Teach Shadow asks nobody -- that footage is
    // training data for a recognizer rather than a record about the person in
    // frame, and the owner ruled it carries no per-athlete permission and that
    // filming for it is never restricted.
    const subject = await resolveScanSubject(claim.organization_id, claim.video_session_id);
    //
    // CL-B1: "SIGNED" IS NOT "SIGNED FOR VIDEO". Owner ruling 2026-10-05:
    // photo-only consent (covers_video=false) means no video use at all, so
    // the vision screen skips that child's video exactly as it does for
    // missing consent. assertGuardianMediaConsent asks only whether every
    // guardian signed, so the coverage check playback and publish use
    // (assertConsentCoversVideo) runs as well. It runs even when the first
    // check already refused: a withdrawal is then recorded as a withdrawal
    // rather than as missing paperwork, and the skip never rests on one
    // check alone. Same skip path as missing consent: reclaimable, backed
    // off, and re-checked on every retry.
    //
    // CL-B5: EVERY CHILD THE CLIP SHOWS, NOT ONLY THE ONE IT IS FILED UNDER.
    // Tags can be added while a video is still quarantined, and a sparring
    // clip tagged with a second child went to the vision screen on the first
    // child's consent alone. Same subjects as Film Study (filmStudyConsent.ts):
    // the video's own athlete plus every live tag subject; a tag naming a
    // deleted athlete skips the screen, as Film Study refuses it. A clip
    // with no athlete and no tags still names nobody and asks nobody: owner
    // ruling 2026-10-08 (option B, "keep scanning") -- such team footage is
    // still screened, unchecked. Tag the children in it and they are asked.
    let contentSkippedForConsent = false;
    let contentSkippedReason: string | null = null;
    if (config.content === 'vision' && !subject.isTeaching) {
      const tagSubjects = await listLiveTagSubjects(claim.organization_id, claim.video_session_id);
      if (tagSubjects.some((tag) => tag.athlete_deleted)) {
        contentSkippedForConsent = true;
        contentSkippedReason = 'tagged_athlete_deleted';
      }
      const athleteIds = [...new Set([
        ...(claim.athlete_id ? [claim.athlete_id] : []),
        ...tagSubjects.map((tag) => tag.athlete_id),
      ])];
      if (!contentSkippedForConsent) {
        const reason = await consentSkipReason(claim.organization_id, athleteIds);
        if (reason) {
          contentSkippedForConsent = true;
          contentSkippedReason = reason;
        }
      }
    }

    // The check above passed on plain reads; it is asked again, under lock,
    // immediately before the frames are sent (recheckBeforeVision). Teaching
    // footage names nobody and gets no guard, as above.
    const guardVisionCall = config.content === 'vision' && !subject.isTeaching && !contentSkippedForConsent
      ? recheckBeforeVision(claim.organization_id, claim.video_session_id, claim.athlete_id, (reason) => {
        contentSkippedReason = reason;
      })
      : undefined;

    const scan = await scanVideoSession({
      blobPath: claim.blob_path,
      attempts: claim.scan_attempts,
      config,
      maxAttempts: DEFAULT_MAX_SCAN_ATTEMPTS,
      skipContentScreen: contentSkippedForConsent,
      ...(guardVisionCall ? { guardVisionCall } : {}),
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
        // Present only when a vision call was made: is the scan's 30 s cap
        // (VIDEO_SCAN_VISION_TIMEOUT_MS) too tight?
        ...(scan.visionMs === null || scan.visionMs === undefined
          ? {}
          : { vision_ms: scan.visionMs, vision_timed_out: scan.visionTimedOut }),
        scanned_at: new Date().toISOString(),
        ...(contentSkippedReason ? { content_skipped_reason: contentSkippedReason } : {}),
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
    // Skipped when nobody can be resolved -- safety_escalations.athlete_id is
    // not-null with a foreign key to pilot.athletes, so there is nothing to
    // file against.
    //
    // TEACHING FOOTAGE ALWAYS RESOLVES TO NOBODY, so it never escalates. That
    // is the cost of the owner's rule that this media names no one, recorded
    // here rather than argued: an escalation carrying an athlete would be that
    // identity arriving by a side door, and there is no identity to carry.
    // Film Study is untouched and still escalates against its own athlete.
    const escalationAthleteId = subject.isTeaching ? null : claim.athlete_id;
    if (terminal && isEscalatingScanDecision(scan.decision) && escalationAthleteId) {
      await fileEscalation({
        organizationId: claim.organization_id,
        sourceType: 'video_scan',
        sourceId: claim.video_session_id,
        athleteId: escalationAthleteId,
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
