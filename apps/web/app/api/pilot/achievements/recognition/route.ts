import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  InvalidAchievementInput,
  createRecognition,
  getCoachDisplayName,
  listRecognitionsForAthlete,
} from '@/src/server/pilot/achievements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * RECOGNITION — a coach telling an athlete they did well.
 *
 * WHO MAY READ. The athlete it is about, their guardian, their coach, and the
 * organization admin — all of them through assertActorCanAccessAthlete, which
 * already refuses the board and the platform owner an athlete-scoped record.
 * There is no route that reads more than one athlete's recognitions, so there
 * is nowhere in this API to obtain the two lists a comparison would need.
 *
 * WHO MAY WRITE. Coaches and organization admins. An athlete cannot write their
 * own, and — deliberately — cannot write one for a peer either: kids handing
 * each other commendations is a popularity count with extra steps, and this is
 * specifically a coach's voice.
 *
 * WHAT IS NOT HERE. No PATCH and no DELETE. A recognition cannot be edited or
 * withdrawn through this API, which is the same rule the training card holds:
 * nothing an athlete has been given is taken back off them, and a compliment
 * that can be revoked is a lever rather than a gift.
 */

const RECOGNITION_SENDER_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const RECOGNITION_READER_ROLES = ['coach', 'organization_admin', 'admin', 'athlete', 'parent'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RECOGNITION_READER_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 50, 100);
    const items = await listRecognitionsForAthlete(
      principal.organizationId,
      athleteId,
      limit ?? 50,
    );

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RECOGNITION_SENDER_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    // A coach may only recognize an athlete they are assigned to. Same boundary
    // as every other athlete-scoped write on this platform.
    await assertActorCanAccessAthlete(principal, athleteId);

    // Never from the body. See deriveCoachDisplayName: a signature the sender
    // supplies is one the sender can forge, and being able to believe who said
    // it is most of what this feature is.
    const coachDisplayName = await getCoachDisplayName(principal.organizationId, principal.accountId);

    const recognition = await createRecognition({
      organizationId: principal.organizationId,
      athleteId,
      coachAccountId: principal.accountId,
      coachDisplayName,
      kind: typeof body.kind === 'string' ? body.kind : '',
      note: typeof body.note === 'string' ? body.note : '',
    });

    /* Audited like every other write. The audit row carries the KIND and never
       the note: the note is a coach speaking to one athlete, and copying it
       into an operational log gives it a second life in a surface the athlete
       does not read. */
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'recognition',
      entity_id: recognition.recognition_id,
      details: { athlete_id: athleteId, kind: recognition.kind },
    });

    return NextResponse.json({ ok: true, recognition }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidAchievementInput) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return jsonError(error);
  }
}
