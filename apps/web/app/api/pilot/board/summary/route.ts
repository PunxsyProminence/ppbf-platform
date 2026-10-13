import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
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
