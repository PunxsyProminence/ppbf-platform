import { NextResponse, type NextRequest } from 'next/server';

import { requireRole, type ActorIdentity } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listOnTheFloorForStaff, onTheFloorForFamily } from '@/src/server/pilot/onTheFloor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who is on the floor now (lane W4-3; W4 item 3, Q3.1 C, Q3.2 A, Q3.3 A, Q3.4 A).
 *
 *   GET, coach and gym admin   { ok, day, athletes: [{ athlete_id, full_name }] }   (FN-1)
 *   GET, parent                { ok, on_the_floor: [athlete_id, ...] }  their own children who count (FN-2)
 *   GET, athlete               { ok, on_the_floor: true | false }       themselves only (FN-2)
 *
 * GATE: the five roles below (the session's role; GO on #2192), then the
 * module's own refusal: an active staff membership in this gym for the staff
 * line, the guardian rule for a parent, a linked athlete record for an
 * athlete (onTheFloor.ts). The board, volunteers, staff-role accounts and the
 * platform owner are refused before anything is read. The organization and
 * every athlete id come from the session and the server's records, and query
 * fields are refused, so a request cannot name an athlete or a gym.
 *
 * A FAMILY'S FAILURE is one fixed text, whatever the cause, and carries no id
 * (FN-0 F15): the shared error helper can pass a message through.
 *
 * It reads the staff-only presence record and today's class register, and
 * settles idle runs first (onTheFloor.ts). This route path is not a family
 * one; sessionRunPresenceStaffOnly.convention.test.ts pins this route, its
 * module and these five roles as that record's one family-facing reader.
 */

const ON_THE_FLOOR_READ_ROLES = ['coach', 'organization_admin', 'admin', 'parent', 'athlete'] as const;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const FAMILY_FAILURE = 'Not available';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ON_THE_FLOOR_READ_ROLES]);
    if (principal.role === 'parent' || principal.role === 'athlete') return await familyLine(request, principal);
    refuseQueryFields(request);
    const line = await listOnTheFloorForStaff(principal, new Date());
    return NextResponse.json({ ok: true, ...line }, { headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}

async function familyLine(request: NextRequest, principal: ActorIdentity): Promise<NextResponse> {
  try {
    refuseQueryFields(request);
    const answer = await onTheFloorForFamily(principal, new Date());
    return NextResponse.json({ ok: true, on_the_floor: answer.on_the_floor }, { headers: NO_STORE });
  } catch (error) {
    // jsonError still logs a server fault (its class and code only); its body is not passed on.
    const { status } = jsonError(error);
    return NextResponse.json({ error: FAMILY_FAILURE }, { status, headers: NO_STORE });
  }
}

function refuseQueryFields(request: NextRequest): void {
  if (request.nextUrl.searchParams.size > 0) {
    throw new ValidationError('Unsupported query: this read takes no fields');
  }
}
