import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  logImagerySession,
  readMentalSkills,
  setSelfTalkCue,
} from '@/src/server/pilot/athleteMentalSkills';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Athlete mental skills, family side (map item 21). GET: the athlete reads
// their own; a guardian names which linked child. POST: the athlete only,
// for their own record -- there is no athlete_id to aim at anyone else.
// Staff read through /api/pilot/coach/mental-skills. The access rule lives in
// athleteMentalSkills.ts, not here.

const FAMILY_ROLES = ['athlete', 'parent'] as const;

/** An athlete is the subject and the query string is never read for them; a
 * parent must name a child, and the module's gate decides whether they may. */
function subjectAthleteId(role: string, sessionAthleteId: string | null | undefined, requested: string | null): string {
  if (role === 'athlete') {
    if (!sessionAthleteId) {
      throw new ValidationError('This account is not linked to an athlete record.', 'ATHLETE_RECORD_NOT_LINKED');
    }
    return sessionAthleteId;
  }
  const athleteId = requested?.trim();
  if (!athleteId) throw new ValidationError('Naming which child this is for is required.', 'ATHLETE_ID_REQUIRED');
  return athleteId;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...FAMILY_ROLES]);
    const athleteId = subjectAthleteId(
      principal.role,
      principal.athleteId,
      request.nextUrl.searchParams.get('athlete_id'),
    );
    return NextResponse.json(await readMentalSkills(principal, athleteId));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);

    const parsed: unknown = await request.json().catch(() => ({}));
    const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    // The module writes the entry and its audit record in one transaction.
    if (body.kind === 'self_talk_cue') {
      const cue = await setSelfTalkCue(principal, { cueText: body.cue_text, cueKind: body.cue_kind });
      return NextResponse.json({ current_cue: cue }, { status: 201 });
    }
    if (body.kind === 'imagery_session') {
      const entry = await logImagerySession(principal, { minutes: body.minutes, contentKey: body.content_key });
      return NextResponse.json({ imagery_session: entry }, { status: 201 });
    }
    throw new ValidationError('kind must be self_talk_cue or imagery_session.');
  } catch (error) {
    return jsonError(error);
  }
}
