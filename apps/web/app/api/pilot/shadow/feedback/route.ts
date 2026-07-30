import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  hiddenNotFound,
  isUuid,
  jsonError,
  parseSafeLimit,
  requirePrincipal,
} from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  getShadowFeedbackSummary,
  hasDurableHumanReviewedLearningEvent,
  listShadowFeedback,
  normalizeShadowFeedbackId,
  recordShadowFeedback,
  resolveShadowFeedbackReview,
  verifyShadowFeedbackCorrelation,
} from '@/src/server/pilot/shadowFeedback';
import { processLearningSignal } from '@/src/server/pilot/shadowLearningLoop';
import {
  enforceShadowRateLimit,
  resolveShadowRateLimit,
  shadowRateLimitMessage,
  ShadowRateLimitExceeded,
} from '@/src/server/pilot/shadowRateLimit';

export const runtime = 'nodejs';

// GET /api/pilot/shadow/feedback — summary + recent feedback list
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_feedback'] });

    const url = new URL(request.url);
    const days = parseSafeLimit(url.searchParams.get('days'), 30, 365);
    const limit = parseSafeLimit(url.searchParams.get('limit'), 50, 200);
    if (days === null || limit === null) {
      return NextResponse.json({ ok: false, error: 'Invalid days or limit' }, { status: 400 });
    }

    const summary = await getShadowFeedbackSummary(principal.organizationId, days);
    const items = principal.role === 'platform_owner'
      ? []
      : await listShadowFeedback(principal.organizationId, limit);

    return NextResponse.json({ ok: true, summary, items });
  } catch (error) {
    return jsonError(error);
  }
}

// POST /api/pilot/shadow/feedback — submit feedback on a SHADOW interaction
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // platform_owner is included because the chat route admits it, and a role
    // that can hold a conversation has to be able to rate the answers in it.
    // Its absence here meant Omega got a 403 on every thumbs-up, which the
    // client read as session death and turned into a forced logout mid-chat.
    //
    // This does not widen Omega's depth. verifyShadowFeedbackCorrelation scopes
    // the lookup by organization_id AND account_id, so the caller can only rate
    // a message it authored; there is no path here to another account's
    // conversation, and no PHI is involved. The PATCH review gate below stays
    // organization-admin only.
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff', 'platform_owner']);
    await assertShadowRuntimeReadiness({
      requiredTables: [
        'shadow_feedback',
        'shadow_chat_sessions',
        'shadow_chat_messages',
        'shadow_learning_events',
        'shadow_recommendation_effectiveness',
        'shadow_library_review_flags',
        'shadow_rate_limit_buckets',
      ],
    });

    const body = (await request.json().catch(() => ({}))) as {
      shadow_event_id?: number;
      recommendation_ref?: string;
      message_id?: string;       // For learning loop correlation
      helpful: boolean;
      rating?: number;
      comment?: string;
    };

    if (typeof body.helpful !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'Missing required field: helpful (boolean)' }, { status: 400 });
    }

    if (
      body.rating != null
      && (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5)
    ) {
      return NextResponse.json({ ok: false, error: 'rating must be between 1 and 5' }, { status: 400 });
    }

    if (body.comment != null && (typeof body.comment !== 'string' || body.comment.length > 2_000)) {
      return NextResponse.json({ ok: false, error: 'comment must be a string no longer than 2,000 characters' }, { status: 400 });
    }

    if (body.message_id != null && !isUuid(body.message_id)) {
      return NextResponse.json({ ok: false, error: 'message_id is invalid' }, { status: 400 });
    }
    if (typeof body.message_id !== 'string' || !body.message_id.trim()) {
      return NextResponse.json(
        { ok: false, error: 'A durable SHADOW assistant message is required.' },
        { status: 400 },
      );
    }
    if (body.shadow_event_id != null) {
      return NextResponse.json(
        { ok: false, error: 'Client feedback must reference a durable SHADOW assistant message.' },
        { status: 400 },
      );
    }

    if (
      body.shadow_event_id != null
      && (!Number.isSafeInteger(body.shadow_event_id) || body.shadow_event_id <= 0)
    ) {
      return NextResponse.json({ ok: false, error: 'shadow_event_id is invalid' }, { status: 400 });
    }

    await enforceShadowRateLimit({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      ...resolveShadowRateLimit('feedback'),
    });

    const correlation = await verifyShadowFeedbackCorrelation({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      messageId: body.message_id,
      shadowEventId: null,
    });
    if (
      !correlation.verified
      || correlation.correlationType !== 'shadow_message'
      || !correlation.correlationId
    ) {
      return NextResponse.json(
        { ok: false, error: 'The SHADOW message was not found.' },
        { status: 404 },
      );
    }
    const outcomeSignal = body.helpful ? 'thumbs_up' : 'thumbs_down';

    const recordedFeedback = await recordShadowFeedback({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      role: principal.role,
      shadowEventId: correlation.shadowEventId,
      recommendationRef: correlation.messageId,
      helpful: body.helpful,
      rating: body.rating ?? null,
      comment: body.comment ?? null,
      outcomeSignal,
      correlationType: correlation.correlationType,
      correlationId: correlation.correlationId,
      verificationState: 'durable_client',
      humanReviewRequired: true,
    });
    const { feedbackId } = recordedFeedback;

    let learningAccepted = false;
    let learningReason = correlation.reason;
    if (!recordedFeedback.created) {
      learningReason = recordedFeedback.humanReviewRequired
        ? 'FEEDBACK_ALREADY_RECORDED'
        : 'FEEDBACK_ALREADY_RESOLVED';
    } else if (correlation.learningEligible && correlation.correlationId) {
      try {
        await processLearningSignal({
          feedbackId,
          shadowEventId: correlation.shadowEventId,
          messageId: correlation.messageId ?? correlation.correlationId,
          userId: principal.accountId,
          organizationId: principal.organizationId,
          role: principal.role,
          topic: correlation.topic,
          sessionType: correlation.sessionType,
          outcome: recordedFeedback.outcomeSignal,
          userNote: recordedFeedback.comment ?? undefined,
          verificationState: 'durable_client',
        });
        learningAccepted = true;
        learningReason = 'HUMAN_REVIEW_REQUIRED';
      } catch {
        learningReason = 'LEARNING_RECORD_FAILED';
      }
    }

    const summary = await getShadowFeedbackSummary(principal.organizationId);

    return NextResponse.json({
      ok: true,
      feedbackId,
      aggregatedSatisfaction: {
        totalResponses: summary.total_responses,
        satisfactionRate: summary.satisfaction_rate,
        avgRating: summary.avg_rating,
      },
      learning: {
        accepted: learningAccepted,
        humanReviewRequired: recordedFeedback.humanReviewRequired,
        reason: learningReason ?? 'HUMAN_REVIEW_REQUIRED',
      },
    });
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { ok: false, error: shadowRateLimitMessage(error.retryAfterSeconds, 'feedback') },
        {
          status: 429,
          headers: { 'Retry-After': String(error.retryAfterSeconds) },
        },
      );
    }
    return jsonError(error);
  }
}

// PATCH /api/pilot/shadow/feedback — approve or reject one durable feedback
// item for learning. The request intentionally accepts no correlation,
// account, role, topic, session, outcome, or note fields; all of those are
// reloaded from the organization-scoped durable records.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);
    await assertShadowRuntimeReadiness({
      requiredTables: [
        'shadow_feedback',
        'shadow_chat_sessions',
        'shadow_chat_messages',
        'shadow_learning_events',
        'shadow_recommendation_effectiveness',
        'shadow_library_review_flags',
      ],
    });

    const body = (await request.json().catch(() => ({}))) as {
      feedbackId?: unknown;
      decision?: unknown;
    };
    const feedbackId = normalizeShadowFeedbackId(body.feedbackId);
    if (feedbackId === null || (body.decision !== 'approve' && body.decision !== 'reject')) {
      return NextResponse.json(
        { ok: false, error: 'feedbackId and a supported decision are required' },
        { status: 400 },
      );
    }

    const reviewed = await resolveShadowFeedbackReview({
      organizationId: principal.organizationId,
      feedbackId,
      reviewerAccountId: principal.accountId,
      decision: body.decision,
    });
    if (!reviewed) {
      return hiddenNotFound();
    }

    if (reviewed.decision === 'reject') {
      return NextResponse.json({
        ok: true,
        decision: 'reject',
        learningPromoted: false,
        alreadyResolved: reviewed.alreadyResolved,
      });
    }

    if (reviewed.alreadyResolved) {
      const alreadyDurable = await hasDurableHumanReviewedLearningEvent({
        organizationId: reviewed.organizationId,
        feedbackId: reviewed.feedbackId,
      });
      if (alreadyDurable) {
        return NextResponse.json({
          ok: true,
          decision: 'approve',
          learningPromoted: true,
          alreadyResolved: true,
        });
      }
    }

    // A prior partial failure can be repaired safely because every downstream
    // side effect is keyed by this durable feedback id.
    const learningResult = await processLearningSignal({
      feedbackId: reviewed.feedbackId,
      messageId: reviewed.messageId,
      userId: reviewed.accountId,
      organizationId: reviewed.organizationId,
      role: reviewed.role,
      topic: reviewed.topic,
      sessionType: reviewed.sessionType,
      outcome: reviewed.outcomeSignal,
      userNote: reviewed.userNote ?? undefined,
      verificationState: 'human_reviewed',
    });
    const durableLearning = await hasDurableHumanReviewedLearningEvent({
      organizationId: reviewed.organizationId,
      feedbackId: reviewed.feedbackId,
    });
    if (!durableLearning || !learningResult.metricsRecorded) {
      return NextResponse.json({
        ok: false,
        decision: 'approve',
        learningPromoted: false,
        alreadyResolved: reviewed.alreadyResolved,
        retryable: true,
        error: 'The review was recorded, but durable learning promotion must be retried.',
      }, { status: 503 });
    }

    return NextResponse.json({
      ok: true,
      decision: 'approve',
      learningPromoted: true,
      alreadyResolved: reviewed.alreadyResolved,
    });
  } catch (error) {
    return jsonError(error);
  }
}
