import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  enforceShadowRateLimit,
  resolveShadowRateLimit,
  ShadowRateLimitExceeded,
  shadowRateLimitMessage,
} from '@/src/server/pilot/shadowRateLimit';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  CoachDraftUnavailableError,
  getCoachDraftOrigins,
  listCoachDraftChoices,
  MAX_PREVIEW_TOKEN_LENGTH,
  previewCoachDraft,
  saveCoachDraft,
  StaleCoachDraftError,
} from '@/src/server/pilot/shadowCoachRecommendation';

export const runtime = 'nodejs';

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

async function coachForAthlete(request: NextRequest, athleteId: string) {
  const principal = await requirePrincipal(request);
  if (principal.role !== 'coach') return null;
  try {
    await assertActorCanAccessAthlete(principal, athleteId);
  } catch (error) {
    // Refused reach reads as not found. Anything else (a database failure)
    // is a server error, not a missing athlete.
    if (error instanceof Error && error.message.startsWith('Forbidden')) return null;
    throw error;
  }
  return principal;
}

// Retrieve the athlete's current, eligible formula results for selection.
// No generation occurs on GET and no recommendation is stored.
export async function GET(request: NextRequest) {
  try {
    const athleteId = request.nextUrl.searchParams.get('athleteId');
    if (!bounded(athleteId, 300)) {
      return NextResponse.json({ ok: false, error: 'athleteId is required.' }, { status: 400 });
    }
    const principal = await coachForAthlete(request, athleteId);
    if (!principal) return hiddenNotFound();
    await assertShadowRuntimeReadiness({
      requiredTables: ['shadow_formula_results', 'shadow_formula_observations',
        'shadow_recommendations', 'shadow_audit_entries'],
    });
    const choices = await listCoachDraftChoices(principal.organizationId, athleteId);
    const origins = await getCoachDraftOrigins(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, choices, origins });
  } catch (error) {
    return jsonError(error);
  }
}

interface DraftRequest {
  athleteId?: unknown;
  formulaResultId?: unknown;
  coachQuestion?: unknown;
  action?: unknown;
  previewToken?: unknown;
}

// POST action=draft creates only a signed, expiring preview; POST action=save
// stores one provisional recommendation after explicit coach review.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as DraftRequest;
    if (!bounded(body.athleteId, 300)) {
      return NextResponse.json({ ok: false, error: 'athleteId is required.' }, { status: 400 });
    }
    const principal = await coachForAthlete(request, body.athleteId);
    if (!principal) return hiddenNotFound();
    // The token the server resolved this principal from: the preview is
    // signed with it, so it opens only in the session that asked for it.
    const sessionToken = principal.sessionToken;
    if (!sessionToken) return NextResponse.json({ ok: false, error: 'Session unavailable.' }, { status: 401 });
    await assertShadowRuntimeReadiness({
      requiredTables: ['shadow_formula_results', 'shadow_formula_observations',
        'shadow_recommendations', 'shadow_audit_entries', 'shadow_library_chunks',
        'shadow_library_documents', 'shadow_library_sources', 'shadow_rate_limit_buckets'],
    });

    if (body.action === 'draft') {
      if (!bounded(body.formulaResultId, 300) || !bounded(body.coachQuestion, 2000)) {
        return NextResponse.json({ ok: false, error: 'Invalid draft request.' }, { status: 400 });
      }
      // A draft is a model call, so it spends the coach's SHADOW chat buckets,
      // the limits that "throttle all of SHADOW" (shadowRateLimit.ts).
      await enforceShadowRateLimit({
        organizationId: principal.organizationId, accountId: principal.accountId,
        ...resolveShadowRateLimit('chat'),
      });
      await enforceShadowRateLimit({
        organizationId: principal.organizationId, accountId: principal.accountId,
        ...resolveShadowRateLimit('chat_daily'),
      });
      const result = await previewCoachDraft({
        actor: principal, athleteId: body.athleteId,
        resultId: body.formulaResultId, question: body.coachQuestion,
        sessionToken,
      });
      if (result.kind === 'abstain') {
        // Something the server could not do right now: 503. Everything else
        // is an answer about this request (422).
        const degraded = result.reason === 'evidence_unavailable'
          || result.reason === 'generation_unavailable'
          || result.reason === 'limits_unavailable'
          || result.reason === 'preview_unavailable';
        return NextResponse.json({
          ok: false, state: 'no_draft', reason: result.reason,
        }, { status: degraded ? 503 : 422 });
      }
      return NextResponse.json({ ok: true, preview: result.preview });
    }

    if (body.action === 'save') {
      if (!bounded(body.previewToken, MAX_PREVIEW_TOKEN_LENGTH)) {
        return NextResponse.json({ ok: false, error: 'Missing draft preview.' }, { status: 400 });
      }
      try {
        const recommendation = await saveCoachDraft({
          actor: principal, athleteId: body.athleteId,
          previewToken: body.previewToken, sessionToken,
        });
        if (!recommendation) return hiddenNotFound();
        return NextResponse.json({ ok: true, recommendation });
      } catch (error) {
        if (error instanceof StaleCoachDraftError) {
          return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
        }
        if (error instanceof CoachDraftUnavailableError) {
          return NextResponse.json({ ok: false, error: error.message }, { status: 503 });
        }
        throw error;
      }
    }
    return NextResponse.json({ ok: false, error: 'Invalid draft action.' }, { status: 400 });
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { ok: false, error: shadowRateLimitMessage(error.retryAfterSeconds) },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    return jsonError(error);
  }
}
