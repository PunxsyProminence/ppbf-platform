import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import {
  bodyMassInputError,
  bodyMassVisibleTo,
  canCorrectBodyMass,
  correctBodyMass,
  summarizeBodyMass,
  toKilograms,
  type BodyMassUnit,
} from '@/src/server/pilot/athleteBodyMass';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Staff read of ONE athlete's latest weigh-in and seven-day weight change
// (elite-boxing item 5).
//
// A SIBLING OF coach/athlete-check-in, NOT PART OF IT. The read's gates:
//   1. role: coach or organization admin;
//   2. assertActorCanAccessAthlete (OD-2026-10-05-024 ruling 2, Jason
//      2026-10-05, narrowing the 2026-10-04 "B everyone, youth limited" for
//      coaches): the athlete's coach of record, a covering coach with a live
//      grant, or the organization admin -- otherwise the same 403 the
//      check-in route gives;
//   3. bodyMassVisibleTo: the youth rule (no recorded date of birth counts as
//      a youth), kept behind 2 so it still holds if 2 ever widens again.
// A reader who fails 3 gets `body_mass: null`, the same answer as an athlete
// who never entered a weight, so the response does not reveal that a youth's
// weight exists.
//
// The flag inside the summary is a fixed rule (>5% of body mass in 7 days, up
// or down), not a score, and nothing acts on it. Read only; the organization
// is the session's, never the request's.

const BODY_MASS_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...BODY_MASS_READ_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    if (!(await bodyMassVisibleTo(principal, principal.organizationId, athleteId))) {
      return NextResponse.json({ body_mass: null, can_correct: false });
    }
    return NextResponse.json(await readable(principal, athleteId));
  } catch (error) {
    return jsonError(error);
  }
}

// `can_correct` tells the screen whether to offer "Correct" on the summary's
// correctable_entries: this reader is the athlete's own (assigned or covering)
// coach and there is an entry inside the correction window. The POST below
// decides again on its own.
async function readable(principal: PilotPrincipal, athleteId: string) {
  const summary = await summarizeBodyMass(principal.organizationId, athleteId);
  if (!summary.latest) return { body_mass: null, can_correct: false };
  const canCorrect = summary.correctable_entries.length > 0
    && (await canCorrectBodyMass(principal, athleteId));
  return { body_mass: summary, can_correct: canCorrect };
}

// Correct a mistyped weight (Jason 2026-10-04, "Athlete or their coach").
// Coach only, and only the athlete's assigned or covering coach -- the
// organization admin reads the weight but does not correct it. The old entry
// is superseded, not deleted (athleteBodyMass.ts, correctBodyMass).
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach']);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    const observationId = typeof body.observation_id === 'string' ? body.observation_id.trim() : '';
    if (!observationId) throw new ValidationError('Missing observation_id.');
    if (typeof body.body_mass !== 'number') throw new ValidationError('body_mass must be a number.');
    const problem = bodyMassInputError(body.body_mass, body.body_mass_unit);
    if (problem) throw new ValidationError(problem);
    await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);

    const corrected = await correctBodyMass(principal, {
      athleteId,
      observationId,
      kilograms: toKilograms(body.body_mass, body.body_mass_unit as BodyMassUnit),
    });
    return NextResponse.json({ corrected, ...(await readable(principal, athleteId)) });
  } catch (error) {
    return jsonError(error);
  }
}
