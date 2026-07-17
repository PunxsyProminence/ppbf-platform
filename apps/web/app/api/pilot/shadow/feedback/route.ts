import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  getShadowFeedbackSummary,
  listShadowFeedback,
  recordShadowFeedback,
} from '@/src/server/pilot/shadowFeedback';

export const runtime = 'nodejs';

// GET /api/pilot/shadow/feedback — summary + recent feedback list
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_feedback'] });

    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get('days') ?? '30', 10);
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);

    const [summary, items] = await Promise.all([
      getShadowFeedbackSummary(principal.organizationId, days),
      listShadowFeedback(principal.organizationId, limit),
    ]);

    return NextResponse.json({ ok: true, summary, items });
  } catch (error) {
    return jsonError(error);
  }
}

// POST /api/pilot/shadow/feedback — submit feedback on a SHADOW interaction
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff']);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_feedback'] });

    const body = (await request.json().catch(() => ({}))) as {
      shadow_event_id?: number;
      recommendation_ref?: string;
      helpful: boolean;
      rating?: number;
      comment?: string;
    };

    if (typeof body.helpful !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'Missing required field: helpful (boolean)' }, { status: 400 });
    }

    if (body.rating != null && (body.rating < 1 || body.rating > 5)) {
      return NextResponse.json({ ok: false, error: 'rating must be between 1 and 5' }, { status: 400 });
    }

    const { feedbackId } = await recordShadowFeedback({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      role: principal.role,
      shadowEventId: body.shadow_event_id ?? null,
      recommendationRef: body.recommendation_ref ?? null,
      helpful: body.helpful,
      rating: body.rating ?? null,
      comment: body.comment ?? null,
    });

    const summary = await getShadowFeedbackSummary(principal.organizationId);

    return NextResponse.json({
      ok: true,
      feedbackId,
      aggregatedSatisfaction: {
        totalResponses: summary.total_responses,
        satisfactionRate: summary.satisfaction_rate,
        avgRating: summary.avg_rating,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
