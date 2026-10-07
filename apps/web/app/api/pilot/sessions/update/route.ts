import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getSessionById, upsertSession } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { isSessionNoteWriter } from '@/src/server/pilot/sessionNotes';
import { assertDurationWrittenByAthlete, validateSessionPayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const payload = validateSessionPayload(await request.json());
    // Minutes are the athlete's own report; staff writes may not carry them.
    assertDurationWrittenByAthlete(principal.role, payload);
    const current = await getSessionById(principal.organizationId, payload.session_id);
    if (!current) {
      throw new Error('Missing session record');
    }

    await assertActorCanAccessAthlete(principal, current.athlete_id);
    await assertActorCanAccessAthlete(principal, payload.athlete_id);

    // Compare-and-set: the write carries the owner just authorized, so a
    // concurrent owner change between the lookup above and this write fails
    // closed instead of overwriting a row that moved. noteWriter says whether
    // the caller may change the note's text (OD-2026-10-06-025 ruling 4:
    // only the writer); the store refuses the change for anyone else.
    await upsertSession(principal.organizationId, payload, {
      mode: 'update',
      expectedAthleteId: current.athlete_id,
      noteWriter: isSessionNoteWriter(principal, current.athlete_id),
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'session',
      entity_id: payload.session_id,
      details: { athlete_id: payload.athlete_id },
    });

    return NextResponse.json({ ok: true, session_id: payload.session_id });
  } catch (error) {
    return jsonError(error);
  }
}
