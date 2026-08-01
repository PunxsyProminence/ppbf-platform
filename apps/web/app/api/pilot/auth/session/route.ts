import { NextResponse, type NextRequest } from 'next/server';

import { resolvePrincipal } from '@/src/server/pilot/auth';
import {
  listSeatsForAccount,
  resolveLandingSeat,
  type BoardSeatAssignment,
} from '@/src/server/pilot/boardSeats';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStoreJson(body: Record<string, unknown>) {
  const response = NextResponse.json(body);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * The seats this board member holds, for the session payload only.
 *
 * A seat is additional identity on top of the authoritative 'board' role, not
 * an authority of its own: it decides which page the member lands on, and
 * every route that acts on a seat re-reads it server-side. So when the seat
 * table cannot be read, the member still gets their aggregate workspace rather
 * than being locked out of the app -- the only cost is landing on /board
 * instead of on their own seat. Narrowed to undefined_table (42P01), the one
 * shape that means the migration has not been applied yet; anything else is a
 * real database failure and must still surface.
 */
async function readBoardSeats(organizationId: string, accountId: string): Promise<BoardSeatAssignment[]> {
  try {
    return await listSeatsForAccount(organizationId, accountId);
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === '42P01') {
      console.error('board-seats-unavailable', { code: '42P01' });
      return [];
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await resolvePrincipal(request);
    if (!principal) {
      return noStoreJson({ authenticated: false });
    }

    // Only a board principal carries seats, and only a board principal pays
    // for the lookup. resolvePrincipal runs on every authenticated request in
    // the app; this read belongs here, where the browser asks who it is.
    const boardSeats = principal.role === 'board'
      ? await readBoardSeats(principal.organizationId, principal.accountId)
      : [];

    return noStoreJson({
      authenticated: true,
      account_id: principal.accountId,
      role: principal.role,
      organization_id: principal.organizationId,
      athlete_id: principal.athleteId,
      auth_provider: principal.authProvider,
      // Reported so the client can route to /change-pin. This route
      // deliberately uses resolvePrincipal rather than requirePrincipal: if it
      // refused mid-bootstrap sessions the session gate would read the account
      // as signed out and bounce it to /login, which is the one place that
      // cannot resolve the situation.
      must_change_pin: principal.mustChangePin,
      // board_seat is the one seat this session lands on; board_seats is every
      // seat held, because a small board doubles up. Absent for every other
      // role, so no non-board session can present a seat.
      board_seat: principal.role === 'board' ? resolveLandingSeat(boardSeats) : undefined,
      board_seats: principal.role === 'board' ? boardSeats : undefined,
    });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
