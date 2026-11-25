import { NextResponse, type NextRequest } from 'next/server';

import { gymDayIso } from '@/src/lib/gymTime';
import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listStoppedComing } from '@/src/server/pilot/stoppedComing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who has stopped coming (lane W4-6, SC-1; W4 item 6, OW27-30 to OW27-32).
 *
 *   GET   { ok, gap_days, is_default, today, athletes: [{ athlete_id, full_name, last_came_day, days_since_came }] }
 *
 * GATE: coach, organization_admin and admin (the session's role), then an
 * active staff membership in this gym (listStoppedComing; 403 without one).
 * Athletes, parents, the board, volunteers, staff and the platform owner are
 * refused before anything is read. The organization comes from the session;
 * query fields are refused. Read-only.
 *
 * It reads the staff-only session presence record for open-gym marks, on this
 * page only (OW27-32 A); sessionRunPresenceStaffOnly.convention.test.ts pins
 * this route and its module as that record's readers, with these three roles
 * (Overwatch, W4-6 GO, condition 1).
 */

const STOPPED_COMING_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STOPPED_COMING_READ_ROLES]);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const today = gymDayIso();
    if (!today) throw new Error('Unable to resolve the gym date.');
    const list = await listStoppedComing(principal, today);
    return NextResponse.json({ ok: true, ...list }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
