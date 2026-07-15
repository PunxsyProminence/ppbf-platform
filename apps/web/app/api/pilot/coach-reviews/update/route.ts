import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getCoachReviewById, getSessionAthleteId, upsertCoachReview } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateCoachReviewPayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const payload = validateCoachReviewPayload(await request.json());
    const current = await getCoachReviewById(principal.organizationId, payload.review_id);
    if (!current) {
      throw new Error('Missing coach review record');
    }

    const currentAthleteId = await getSessionAthleteId(principal.organizationId, current.session_id);
    if (!currentAthleteId) {
      throw new Error('Missing session for existing coach review');
    }

    await assertActorCanAccessAthlete(principal, currentAthleteId);

    if (principal.role === 'coach' && payload.coach_id !== principal.accountId) {
      throw new Error('Forbidden: coach can only save own reviews');
    }

    const payloadAthleteId = await getSessionAthleteId(principal.organizationId, payload.session_id);
    if (!payloadAthleteId) {
      throw new Error('Missing session for coach review payload');
    }

    await assertActorCanAccessAthlete(principal, payloadAthleteId);
    await upsertCoachReview(principal.organizationId, payload);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'coach_review',
      entity_id: payload.review_id,
      details: { session_id: payload.session_id },
    });

    return NextResponse.json({ ok: true, review_id: payload.review_id });
  } catch (error) {
    return jsonError(error);
  }
}
