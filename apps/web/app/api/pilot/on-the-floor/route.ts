import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listOnTheFloorForStaff } from '@/src/server/pilot/onTheFloor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who is on the floor now (lane W4-3, FN-1; W4 item 3, Q3.1 C and Q3.3 A).
 *
 *   GET   { ok, day, athletes: [{ athlete_id, full_name }] }
 *
 * GATE: coach, organization_admin and admin (the session's role), then an
 * active staff membership in this gym (listOnTheFloorForStaff; 403 without
 * one). Parents, athletes, the board, volunteers, staff and the platform owner
 * are refused before anything is read; parents and athletes until FN-2 opens
 * their branches (GO on #2192). The organization comes from the session, and
 * query fields are refused, so a request cannot name an athlete or a gym.
 *
 * It reads the staff-only session presence record and today's class register,
 * and settles idle runs first (onTheFloor.ts). This route path is not a family
 * one; sessionRunPresenceStaffOnly.convention.test.ts pins this route and its
 * module as that record's readers, with these three roles.
 */

const ON_THE_FLOOR_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ON_THE_FLOOR_READ_ROLES]);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const line = await listOnTheFloorForStaff(principal, new Date());
    return NextResponse.json({ ok: true, ...line }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
