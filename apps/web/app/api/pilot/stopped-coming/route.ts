import { NextResponse, type NextRequest } from 'next/server';

import { gymDayIso } from '@/src/lib/gymTime';
import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listStoppedComing, setStoppedComingReachedOut } from '@/src/server/pilot/stoppedComing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who has stopped coming (lane W4-6, SC-1; W4 item 6, OW27-30 to OW27-32),
 * and the "reached out" mark on it (SC-3a-2; OW27-33 B, Overwatch W4-6 Q4 A).
 *
 *   GET   { ok, gap_days, is_default, today, athletes: [{ athlete_id, full_name, last_came_day, days_since_came,
 *           reached_out: { by_name, by_role: 'coach' | 'office', on_day } | null }] }
 *   PUT   { athlete_id, reached_out: true | false }
 *         -> { ok, outcome: 'marked' | 'already_marked' | 'taken_back' | 'not_marked' }
 *
 * GATE, both handlers: coach, organization_admin and admin (the session's
 * role), then an active staff membership in this gym (the module; 403 without
 * one). Athletes, parents, the board, volunteers, staff and the platform owner
 * are refused before anything is read or written. The organization comes from
 * the session; query fields are refused. The PUT takes exactly its two fields
 * (no note: who and when only); the module answers 404 for an athlete not live
 * here and 409 for a mark on one not on the list now. No account id leaves.
 *
 * It reads the staff-only session presence record for here marks the register
 * does not hold (open gym, a tap that created no register mark, a cancelled
 * class), on this page only (OW27-32 A; App Overwatch on #2172), and the PUT
 * reads it too, for the athlete's last day they came (Overwatch on #2163,
 * answer A: no separate reached-out route);
 * sessionRunPresenceStaffOnly.convention.test.ts pins
 * this route and its module as that record's readers, with these three roles
 * on both handlers (Overwatch, W4-6 GO, condition 1).
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

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STOPPED_COMING_READ_ROLES]);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: send athlete_id and reached_out in the body only');
    }
    const parsed: unknown = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('Request body must be a JSON object with athlete_id and reached_out');
    }
    const body = parsed as Record<string, unknown>;
    const fields = Object.keys(body).sort();
    if (fields.length !== 2 || fields[0] !== 'athlete_id' || fields[1] !== 'reached_out') {
      throw new ValidationError('Unsupported fields: send athlete_id and reached_out only');
    }
    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');
    if (typeof body.reached_out !== 'boolean') throw new ValidationError('reached_out must be true or false');
    const today = gymDayIso();
    if (!today) throw new Error('Unable to resolve the gym date.');
    const outcome = await setStoppedComingReachedOut(principal, athleteId, body.reached_out, today);
    return NextResponse.json({ ok: true, outcome }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
