import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { decideOnRecommendation, getRecommendationAthleteId } from '@/src/server/pilot/shadowRecommendations';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

/**
 * Records a human's accept/reject on one provisional SHADOW recommendation.
 *
 * THE AUTHORIZED ATHLETE MUST BE THE STORED ONE.
 *
 * This route used to authorize `body.athleteId` -- an athlete id the CALLER
 * chose -- and then hand `recommendationId` to a write that matched on
 * (organization_id, recommendation_id) alone. The athlete it checked and the
 * row it wrote were never tied together, so `athleteId` was decorative: a
 * coach passed one of their OWN athletes to satisfy the gate and any other
 * child's recommendationId to aim the write, and the UPDATE committed on that
 * child's row. The response then returned the whole row back, so the same
 * request also disclosed the recommendation text and expected outcome for a
 * child the caller has no relationship with.
 *
 * pilot.shadow_recommendations is not incidental: createProvisionalRecommendation
 * refuses to write one at all unless the athlete holds a current 'cleared'
 * medical administrative status, so every row here is a medically gated
 * judgement about whether a child trains, spars or returns to play. Accepting
 * or rejecting one is a participation decision, and it was reachable by
 * anyone holding a coach seat in the gym.
 *
 * The fix is the shape the sibling routes already use -- the film-study
 * proposals PATCH resolves the stored proposal's athlete_id and authorizes
 * that; decision-outcomes resolves the decision's athlete through
 * getDecisionAthleteId. So:
 *
 *   1. resolve the recommendation's STORED athlete (organization-scoped);
 *   2. authorize the actor against THAT athlete;
 *   3. carry the authorized id into the UPDATE's WHERE.
 *
 * `athleteId` stays in the contract and must now MATCH the stored owner. The
 * decision-loop page always sends the athlete whose panel is open together
 * with a recommendation drawn from that same athlete's list, so nothing
 * legitimate changes; a payload that names a different athlete than the
 * recommendation belongs to is now refused instead of being ignored.
 *
 * Every refusal below is the same hidden not-found: a recommendation that
 * does not exist, one in another gym, one belonging to a child this actor
 * cannot reach, and one whose payload athlete does not match must all be
 * indistinguishable, or this route becomes a probe for which recommendation
 * ids are real.
 */

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

interface DecideRequestBody {
  athleteId?: unknown;
  recommendationId?: unknown;
  decision?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const body = (await request.json().catch(() => ({}))) as DecideRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || !boundedString(body.recommendationId, 300)
      || (body.decision !== 'accepted' && body.decision !== 'rejected')
    ) {
      return NextResponse.json({ ok: false, error: 'Decide payload is invalid.' }, { status: 400 });
    }

    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_recommendations', 'shadow_audit_entries'] });

    // The stored owner, read before anything is authorized and before
    // anything is written.
    const storedAthleteId = await getRecommendationAthleteId(
      principal.organizationId,
      body.recommendationId,
    );
    if (!storedAthleteId) {
      return hiddenNotFound();
    }

    // Authorized against the STORED athlete, never the payload's. Collapsed
    // into the hidden not-found rather than surfacing the 403: "exists but
    // you may not touch it" and "does not exist" have to read the same here.
    try {
      await assertActorCanAccessAthlete(principal, storedAthleteId);
    } catch {
      return hiddenNotFound();
    }

    // Second layer, not the gate: the caller's stated athlete must be the one
    // the recommendation is actually about, so a payload whose two ids
    // disagree fails closed instead of quietly acting on the stored one.
    if (body.athleteId !== storedAthleteId) {
      return hiddenNotFound();
    }

    const recommendation = await decideOnRecommendation({
      organizationId: principal.organizationId,
      athleteId: storedAthleteId,
      recommendationId: body.recommendationId,
      decision: body.decision,
      decidedByAccountId: principal.accountId,
      decidedByRole: principal.role,
    });

    if (!recommendation) {
      return hiddenNotFound();
    }

    return NextResponse.json({ ok: true, recommendation });
  } catch (error) {
    return jsonError(error);
  }
}
