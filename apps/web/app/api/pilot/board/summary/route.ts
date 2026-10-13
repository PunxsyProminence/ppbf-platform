import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { gymDayIso } from '@/src/lib/gymTime';
import { getBoardReport, getBoardSummary } from '@/src/server/pilot/boardSummary';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/** A calendar day, YYYY-MM-DD, that is a real date. */
function calendarDay(raw: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const real = match
    && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === raw;
  if (!real) {
    throw new ValidationError(`${field} must be a date as YYYY-MM-DD.`);
  }
  return raw;
}

/** The last day of the calendar month a YYYY-MM-DD day is in. */
function lastDayOfMonth(day: string): string {
  const [year, month] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
}

/*
 * ONE COMPLETED CALENDAR MONTH PER REPORT (RP-04 Q-F default A). Reports never
 * overlap, so no two can be subtracted to single out what was withheld: free
 * windows let two reports isolate one day, and multi-month spans let
 * "July to September" minus "July to August" reveal a September that was
 * suppressed on its own. A month still in progress could be read on two days
 * and subtracted the same way, so the month must be over in the gym.
 */
function requireOneCompletedMonth(from: string, to: string): void {
  if (!from.endsWith('-01') || to !== lastDayOfMonth(from)) {
    throw new ValidationError('A board report covers one whole calendar month: from must be the first of a month and to the last day of that month.');
  }
  const today = gymDayIso(new Date(Date.now())) ?? new Date().toISOString().slice(0, 10);
  if (to >= `${today.slice(0, 7)}-01`) {
    throw new ValidationError('A board report covers completed months only: to must be before the start of this month.');
  }
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['board', 'platform_owner']);

    /* The dated board report (#1542, RP-04): from and to, both or neither.
       Same roles, same organization, same aggregate contract and suppression;
       only the window for sessions and reviews is chosen. */
    const fromRaw = request.nextUrl.searchParams.get('from');
    const toRaw = request.nextUrl.searchParams.get('to');
    if (fromRaw !== null || toRaw !== null) {
      if (fromRaw === null || toRaw === null) {
        throw new ValidationError('A report needs both from and to.');
      }
      const from = calendarDay(fromRaw, 'from');
      const to = calendarDay(toRaw, 'to');
      if (from > to) {
        throw new ValidationError('from must be on or before to.');
      }
      requireOneCompletedMonth(from, to);
      const report = await getBoardReport(principal.organizationId, { from, to });
      return NextResponse.json(
        { success: true, report },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    const summary = await getBoardSummary(principal.organizationId);
    return NextResponse.json(
      { success: true, summary },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
