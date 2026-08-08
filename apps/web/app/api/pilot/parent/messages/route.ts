import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { listParentMessages } from '@/src/server/pilot/intake';

export const runtime = 'nodejs';

/**
 * Capability #90: the read side of one-directional coach/admin -> parent
 * messaging. There is deliberately no POST here -- a coach/admin sends via
 * the existing POST /api/pilot/intake/domain-upsert
 * (entity_type: 'coach_note', note_type: 'parent_message'), so this route
 * only ever reads. Reply, threading, and any parent-initiated send are
 * explicitly out of scope: real moderation/product decisions, not
 * something this pass guesses at.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteIds = await guardianAthleteIds(principal.organizationId, principal.accountId);

    const [messages, athletes] = await Promise.all([
      listParentMessages(principal.organizationId, athleteIds),
      Promise.all(athleteIds.map((athleteId) => getAthleteById(principal.organizationId, athleteId))),
    ]);

    const nameByAthleteId = new Map(
      athletes.filter((athlete): athlete is NonNullable<typeof athlete> => Boolean(athlete)).map((athlete) => [athlete.athlete_id, athlete.full_name]),
    );

    const items = messages.map((message) => ({
      note_id: message.note_id,
      athlete_id: message.athlete_id,
      athlete_name: nameByAthleteId.get(message.athlete_id) ?? null,
      sender_role: message.sender_role,
      note_text: message.note_text,
      created_at: message.created_at,
    }));

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}
