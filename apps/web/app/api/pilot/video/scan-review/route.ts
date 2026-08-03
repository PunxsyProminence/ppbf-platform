// POST /api/pilot/video/scan-review — the ADMINISTRATOR escalation for a
// quarantined video, and the thing video/[videoId]/release already points at.
//
// #149 gave the coach who filmed a session a Release button for footage the
// scanner deferred, and deliberately refused 'blocked': a content screen
// declining footage of a minor is not something the person who shot it gets to
// overturn. Correct. But its refusal message says "ask an administrator to
// review it", and no such surface existed -- 'blocked' had no exit anywhere in
// the platform, which is the same dead end quarantine itself had before #49,
// one level up.
//
// This is that surface. Organization admins only, precisely because the coach
// is excluded from this decision. It is a human attestation, not a second
// automated pass: the reviewer opens the clip (review-link), watches it, and
// records 'approve' or 'block'. 'approve' is the only path here that sets
// status='ready'; 'block' leaves the video quarantined, so a refusal changes
// nothing about what anyone can watch.
//
// The coach's ordinary path stays video/[videoId]/release. This route is not a
// replacement for it and does not widen it.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { reviewVideoSessionScan, type VideoScanReviewDecision } from '@/src/server/pilot/videoSessions';
import {
  authorizeVideoScanReview,
  VideoScanReviewRefused,
  VIDEO_REVIEW_DECIDE_ROLES,
} from '@/src/server/pilot/videoScanReview';

export const runtime = 'nodejs';

const DECISIONS = new Set<VideoScanReviewDecision>(['approve', 'block']);

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...VIDEO_REVIEW_DECIDE_ROLES]);

    const body = await request.json().catch(() => ({}));
    const videoSessionId = typeof body.video_session_id === 'string' ? body.video_session_id.trim() : '';
    // Kept as unknown until it has been checked. Casting to the union first
    // would make "was it absent or was it misspelled" unaskable -- the
    // comparison the narrowed type forbids is exactly the one the caller needs
    // answered.
    const rawDecision: unknown = body.decision;
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2_000) : undefined;

    if (!videoSessionId) {
      throw new Error('Missing video_session_id');
    }
    if (!DECISIONS.has(rawDecision as VideoScanReviewDecision)) {
      // Distinguishes absent from unrecognized: "Missing" on a value that was
      // present but misspelled sends a client author looking in the wrong
      // place. "Unsupported" rather than "Invalid" because jsonError maps
      // status by message PREFIX -- Missing/Unsupported/Request body/PIN are
      // the 400s, and anything else falls through to a 500 that replaces the
      // text with "Internal server error", which would tell the caller less
      // than the wording it replaced. Matches the evidence review route.
      throw new Error(
        rawDecision === undefined || rawDecision === null || rawDecision === ''
          ? 'Missing decision: expected "approve" or "block"'
          : 'Unsupported decision: expected "approve" or "block"',
      );
    }
    const decision = rawDecision as VideoScanReviewDecision;

    const video = await authorizeVideoScanReview(principal, videoSessionId);

    const updated = await reviewVideoSessionScan({
      organizationId: principal.organizationId,
      videoSessionId,
      decision,
      // Captured BEFORE the write, so the record says what the machine had
      // concluded at the moment a person overrode it.
      priorScanState: video.scan_state,
      reviewedByAccountId: principal.accountId,
      reviewedByRole: principal.role,
      notes,
    });

    if (!updated) {
      // The row stopped being quarantined between the authorization read and
      // the write -- another reviewer, or an operator archiving it. Reporting
      // success here would tell this reviewer their decision stuck when it
      // did not.
      throw new VideoScanReviewRefused(
        'VIDEO_SESSION_CHANGED',
        'This video changed state while you were reviewing it. Reload and check before deciding again.',
        409,
      );
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_session',
      entity_id: videoSessionId,
      details: {
        action: 'video_scan_review',
        decision,
        prior_scan_state: video.scan_state,
        resulting_status: updated.status,
        athlete_id: updated.athlete_id,
        file_name: updated.file_name,
        notes: notes ?? '',
      },
      shadow_mirror: false,
    });

    // Mirrors the sweep's own video.scan_settled so both machine and human
    // verdicts land on one timeline. actor is a person here, unlike the
    // sweep's null -- which is precisely the distinction worth recording.
    await emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: 'video.scan_settled',
      entityType: 'video_session',
      entityId: videoSessionId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: {
        decision: decision === 'approve' ? 'promote' : 'blocked',
        reason: 'HUMAN_REVIEW',
        prior_scan_state: video.scan_state,
        status: updated.status,
      },
    }).catch(() => {
      // The verdict is already durable on the row and in the audit trail.
    });

    return NextResponse.json({
      ok: true,
      video_session_id: videoSessionId,
      decision,
      status: updated.status,
      scan_state: updated.scan_state,
    });
  } catch (error) {
    if (error instanceof VideoScanReviewRefused) {
      return NextResponse.json({ error: error.message, reason: error.reason }, { status: error.status });
    }
    return jsonError(error);
  }
}
