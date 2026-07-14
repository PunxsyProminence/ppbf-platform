import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getSessionAthleteId, upsertCoachReview } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateCoachReviewPayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach']);

    const payload = validateCoachReviewPayload(await request.json());

    if (principal.role === 'coach' && payload.coach_id !== principal.accountId) {
      throw new Error('Forbidden: coach can only create own reviews');
    }

    const athleteId = await getSessionAthleteId(payload.session_id);
    if (!athleteId) {
      throw new Error('Missing session for coach review');
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    await upsertCoachReview(payload);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'coach_review',
      entity_id: payload.review_id,
      details: { session_id: payload.session_id },
    });

    return NextResponse.json({ ok: true, review_id: payload.review_id });
  } catch (error) {
    return jsonError(error);
  }
}
