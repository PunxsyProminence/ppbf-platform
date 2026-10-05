import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import {
  bodyMassInputError,
  correctBodyMass,
  summarizeBodyMass,
  toKilograms,
  type BodyMassUnit,
} from '@/src/server/pilot/athleteBodyMass';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The athlete's own latest weigh-in, and the correction of a mistyped one
// (Jason 2026-10-04, "Athlete or their coach"). SELF ONLY, like the check-in
// route beside it: the athlete id is the session's, never the request's.
//
// The athlete gets the weigh-in, not the seven-day flag: the flag sentence is
// written for the coach ("Check in with the athlete."). A correction writes a
// new entry that supersedes the old one; the old one stays on record
// (athleteBodyMass.ts, correctBodyMass).

// Live row required, as in the check-in route: a session that outlived the
// athlete's deletion carries the same id (OD-2026-09-29-002 item 10). The
// correction was already refused (correctBodyMass -> the access guard); the
// read was not.
async function requireOwnAthleteId(principal: { organizationId: string; athleteId?: string | null }): Promise<string> {
  if (!principal.athleteId) throw new ValidationError('This account is not linked to an athlete record.');
  await assertAthleteBelongsToOrganization(principal.organizationId, principal.athleteId);
  return principal.athleteId;
}

async function ownLatest(organizationId: string, athleteId: string) {
  const { latest, correctable_entries } = await summarizeBodyMass(organizationId, athleteId);
  return latest || correctable_entries.length > 0 ? { latest, correctable_entries } : null;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);
    return NextResponse.json({ body_mass: await ownLatest(principal.organizationId, athleteId) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const athleteId = await requireOwnAthleteId(principal);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const observationId = typeof body.observation_id === 'string' ? body.observation_id.trim() : '';
    if (!observationId) throw new ValidationError('Missing observation_id.');
    if (typeof body.body_mass !== 'number') throw new ValidationError('body_mass must be a number.');
    const problem = bodyMassInputError(body.body_mass, body.body_mass_unit);
    if (problem) throw new ValidationError(problem);

    const corrected = await correctBodyMass(principal, {
      athleteId,
      observationId,
      kilograms: toKilograms(body.body_mass, body.body_mass_unit as BodyMassUnit),
    });
    return NextResponse.json({
      corrected,
      body_mass: await ownLatest(principal.organizationId, athleteId),
    });
  } catch (error) {
    return jsonError(error);
  }
}
