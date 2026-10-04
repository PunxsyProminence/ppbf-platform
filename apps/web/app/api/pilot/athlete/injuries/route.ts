import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { listFamilyInjuries, type FamilyInjury } from '@/src/server/pilot/athleteInjuries';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * An athlete's injury record, to the athlete and their linked guardians
 * (owner decision 2026-10-04: "Yes, read-only own"). READ-ONLY: one verb.
 *
 * WHAT THEY RECEIVE is listFamilyInjuries' projection -- date, body area, type,
 * training or competition, who it came from, expected return, returned date.
 * The staff note, who recorded or edited it, and the ids of linked staff
 * records are never read for this audience (privacyTiers.ts
 * 'athlete_injuries.staff_note' names this route as their enforcer). Staff
 * read the full record through /api/pilot/coach/injuries.
 *
 * WHO: athlete and parent only -- staff, platform_owner and board are refused
 * by the role gate before anything is read. assertActorCanAccessAthlete then
 * admits an athlete only for themselves (and only while their record is
 * live) and a parent only for a linked child; a refusal is a 403, not an empty
 * list, so a guardian is never told "no injuries" about a child they may not
 * see.
 */

const FAMILY_ROLES = ['athlete', 'parent'] as const;

/**
 * The response row, picked field by field a second time here, so that a wider
 * row from the data layer still could not carry a staff field to a family.
 */
function familyRow(row: FamilyInjury): FamilyInjury {
  return {
    injury_id: row.injury_id,
    injury_date: row.injury_date,
    body_area: row.body_area,
    injury_type: row.injury_type,
    context: row.context,
    reported_by: row.reported_by,
    expected_return_date: row.expected_return_date,
    returned_on: row.returned_on,
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...FAMILY_ROLES]);

    let athleteId: string;
    if (principal.role === 'athlete') {
      if (!principal.athleteId) {
        throw new ValidationError('This account is not linked to an athlete record.', 'ATHLETE_RECORD_NOT_LINKED');
      }
      athleteId = principal.athleteId;
    } else {
      athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
      if (!athleteId) throw new ValidationError('Naming which child this is for is required.', 'ATHLETE_ID_REQUIRED');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const injuries = (await listFamilyInjuries(principal.organizationId, athleteId)).map(familyRow);
    return NextResponse.json({ ok: true, injuries }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
