import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { FAMILY_MEMBER_CODES, type SkillFamilyId } from '@/src/server/pilot/skillFamilies';
import {
  countUnlinkedAssignments,
  deriveSkillProgressionOrder,
  listAthleteFamilyDrills,
  type FamilyDrillAssignment,
} from '@/src/server/pilot/skillProgressionOrder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The technical progression order, and where the signed-in athlete's own drill
 * record sits on it (map item 16).
 *
 * OWN RECORD ONLY. Athlete role, and the subject comes from the session -- an
 * `athlete_id` query parameter is never read, so there is no parameter to get
 * wrong. Coaches and parents are not served here.
 *
 * READ-ONLY. No verb writes anything.
 *
 * Per family, `record` is one of:
 *   - { state: 'mapped', items } -- the family has an approved code crosswalk
 *     (SKILL-01 today); `items` are the athlete's own assignments in it, which
 *     may be empty, and empty then truly means none assigned.
 *   - { state: 'not_mapped' } -- no crosswalk yet, so the app cannot tell
 *     which drills belong to it. Never sent as an empty list, which would
 *     read as "you have done nothing here".
 */
export type FamilyRecord =
  | { state: 'mapped'; items: FamilyDrillAssignment[] }
  | { state: 'not_mapped' };

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);

    const athleteId = principal.athleteId;
    if (!athleteId) {
      throw new ValidationError('This account is not linked to an athlete record.', 'ATHLETE_RECORD_NOT_LINKED');
    }
    await assertActorCanAccessAthlete(principal, athleteId);

    const order = deriveSkillProgressionOrder();

    const familyIds: SkillFamilyId[] = [
      ...order.steps.flatMap((s) => s.families.map((f) => f.familyId)),
      ...order.acrossAll.map((f) => f.familyId),
    ];

    const records: Partial<Record<SkillFamilyId, FamilyRecord>> = {};
    for (const familyId of familyIds) {
      const codes = FAMILY_MEMBER_CODES[familyId];
      if (!codes) {
        records[familyId] = { state: 'not_mapped' };
        continue;
      }
      const items = await listAthleteFamilyDrills(principal.organizationId, athleteId, codes);
      records[familyId] = { state: 'mapped', items };
    }
    const unlinked = await countUnlinkedAssignments(principal.organizationId, athleteId);

    return NextResponse.json({ ...order, records, unlinked });
  } catch (error) {
    return jsonError(error);
  }
}
