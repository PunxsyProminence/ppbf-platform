import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  BOARD_SEAT_SLUGS,
  BoardSeatConflictError,
  assertCanManageBoardSeats,
  assignBoardSeat,
  isBoardSeatSlug,
  listBoardRoster,
  listSeatHolders,
  removeBoardSeat,
  setPrimarySeatHolder,
} from '@/src/server/pilot/boardSeats';
import { jsonError, requireMicrosoftAuthenticatedPrincipal, requirePrincipal } from '@/src/server/pilot/http';
import type { BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

export const runtime = 'nodejs';

// The organization is always the caller's own session organization. It is
// never read from the request, so no board and no administrator can reach
// another gym's roster by changing a parameter.
const READ_ROLES = new Set(['board', 'organization_admin', 'admin']);

function requireSeatParam(value: unknown): BoardSeatSlug {
  if (!isBoardSeatSlug(value)) {
    throw new Error(`Unsupported seat: expected one of ${BOARD_SEAT_SLUGS.join(', ')}`);
  }
  return value;
}

function requireAccountIdParam(value: unknown): string {
  const accountId = typeof value === 'string' ? value.trim() : '';
  if (!accountId) {
    throw new Error('Missing account_id');
  }
  return accountId;
}

// A seat that is already held outright is a conflict the caller can act on --
// hand the seat over -- so the message naming the current holder has to reach
// them rather than being flattened into a generic failure.
function seatError(error: unknown): NextResponse {
  if (error instanceof BoardSeatConflictError) {
    return NextResponse.json(
      {
        error: error.message,
        seat: error.seat,
        current_holder_account_id: error.currentHolderAccountId,
      },
      { status: 409 },
    );
  }
  return jsonError(error);
}

/**
 * The board roster: who holds which seat, in this organization.
 *
 * Returns the appointment and nothing more about the person -- no email, no
 * auth provider, no athlete identifier. The board role is aggregate-only, and
 * a governance roster must not become the one board-readable surface that
 * carries per-account personal data.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    if (!READ_ROLES.has(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const requestedSeat = request.nextUrl.searchParams.get('seat');
    const holders = requestedSeat
      ? await listSeatHolders(principal.organizationId, requireSeatParam(requestedSeat))
      : await listBoardRoster(principal.organizationId);

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      seats: BOARD_SEAT_SLUGS,
      holders,
    });
  } catch (error) {
    return seatError(error);
  }
}

// Seats a board member. is_primary must be asked for: an assignment that says
// nothing about it joins the seat rather than taking it from whoever holds it.
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    await assertCanManageBoardSeats(principal);

    const body = (await request.json()) as {
      seat?: unknown;
      account_id?: unknown;
      is_primary?: unknown;
    };

    const seat = requireSeatParam(body.seat);
    const accountId = requireAccountIdParam(body.account_id);
    const isPrimary = body.is_primary === true;

    const holder = await assignBoardSeat({
      organizationId: principal.organizationId,
      seat,
      accountId,
      isPrimary,
      assignedByAccountId: principal.accountId,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'board_seat',
      entity_id: seat,
      details: {
        action: 'assign_board_seat',
        account_id: accountId,
        is_primary: isPrimary,
      },
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, holder });
  } catch (error) {
    return seatError(error);
  }
}

// The handover: the named holder takes the seat outright and whoever held it
// steps back to co-holder. Both halves commit together or neither does.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    await assertCanManageBoardSeats(principal);

    const body = (await request.json()) as { seat?: unknown; account_id?: unknown };
    const seat = requireSeatParam(body.seat);
    const accountId = requireAccountIdParam(body.account_id);

    const holders = await setPrimarySeatHolder({
      organizationId: principal.organizationId,
      seat,
      accountId,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'board_seat',
      entity_id: seat,
      details: {
        action: 'set_primary_board_seat_holder',
        account_id: accountId,
      },
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, holders });
  } catch (error) {
    return seatError(error);
  }
}

// Ends one appointment. A seat this organization never recorded reads as a
// 404 rather than a silent success, so the caller is never told an assignment
// was removed that was not there.
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    await assertCanManageBoardSeats(principal);

    const seat = requireSeatParam(request.nextUrl.searchParams.get('seat'));
    const accountId = requireAccountIdParam(request.nextUrl.searchParams.get('account_id'));

    const removed = await removeBoardSeat({
      organizationId: principal.organizationId,
      seat,
      accountId,
    });

    if (!removed) {
      throw new Error('Not found: no such board seat assignment in this organization');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'board_seat',
      entity_id: seat,
      details: {
        action: 'remove_board_seat',
        account_id: accountId,
        was_primary: removed.is_primary,
      },
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, removed });
  } catch (error) {
    return seatError(error);
  }
}
