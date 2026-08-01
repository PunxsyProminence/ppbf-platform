import { boardSeatConfigs, isBoardSeatSlug, type BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

import type { PilotRole } from './contracts';
import { isOrganizationAdminRole } from './access';
import { query, queryOne, withTransaction } from './db';

/**
 * The eight governing-board seats, as data.
 *
 * pilot.board_seats is owned by
 * infra/azure/pilot_slice_postgres_board_seats_migration.sql and applied
 * through the apply-migrations workflow. Nothing here may issue DDL.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT TOUCH: no athlete identifier, no
 * entity_id, no event payload. The board role is aggregate-only -- a board
 * member never sees athlete-scoped or individually identifiable youth data --
 * and a seat is a fact about an adult's own appointment. The reads below name
 * the columns they return one by one so a later column on pilot.accounts
 * cannot be swept into a board-facing response by a `select *`.
 */

// The vocabulary is the app's: these are the slugs the /board/[seat] pages
// route on, so a seat the database accepts and a seat a member can open cannot
// drift apart. The check constraint carries the same eight.
export const BOARD_SEAT_SLUGS: readonly BoardSeatSlug[] = boardSeatConfigs.map((seat) => seat.slug);

const BOARD_SEAT_LABELS: ReadonlyMap<string, string> = new Map(
  boardSeatConfigs.map((seat) => [seat.slug, seat.seatLabel]),
);

// The seat whose holder may manage the board's own roster alongside the
// organization's administrators.
const PRESIDENT_SEAT: BoardSeatSlug = 'president';

export { isBoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

// The office as the board says it aloud, for a message a person has to act on.
export function getBoardSeatLabel(seat: BoardSeatSlug): string {
  return BOARD_SEAT_LABELS.get(seat) ?? seat;
}

/**
 * A seat that is already held outright.
 *
 * The database, not this module, refuses a second primary holder: two
 * concurrent assignments each read no existing primary and both write, so a
 * check in TypeScript loses that race by construction. The partial unique
 * index wins it, and this error is how that rejection is reported back with
 * the current holder named instead of as an opaque constraint failure.
 */
export class BoardSeatConflictError extends Error {
  readonly seat: BoardSeatSlug;
  readonly currentHolderAccountId: string | null;

  constructor(seat: BoardSeatSlug, currentHolderAccountId: string | null) {
    super(
      currentHolderAccountId
        ? `Board seat already held: ${getBoardSeatLabel(seat)} is held by ${currentHolderAccountId}. Hand the seat over instead of assigning a second holder.`
        : `Board seat already held: ${getBoardSeatLabel(seat)} already has a holder.`,
    );
    this.name = 'BoardSeatConflictError';
    this.seat = seat;
    this.currentHolderAccountId = currentHolderAccountId;
  }
}

export interface BoardSeatAssignment {
  seat: BoardSeatSlug;
  is_primary: boolean;
}

// Everything the board roster needs to name who holds a seat and to hand it
// over, and nothing else. No login_email, no auth provider, no athlete_id, no
// PIN state -- a governance roster is not a directory of personal data.
export interface BoardSeatHolder {
  seat: BoardSeatSlug;
  account_id: string;
  is_primary: boolean;
  assigned_at: string;
}

const SEAT_FIELDS = 'seat, account_id, is_primary, assigned_at';

// A holder outright sorts ahead of co-holders, then by account so the roster
// renders in a stable order across reads.
const HOLDER_ORDER = 'order by is_primary desc, account_id';

// Postgres reports a partial unique INDEX violation with the index name in the
// error's `constraint` field, but the message is matched as well so a driver
// that omits the field still classifies the failure rather than letting it fall
// through as an unexplained 500.
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { code, constraint: violated, message } = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (code !== '23505') {
    return false;
  }
  return violated === constraint || (typeof message === 'string' && message.includes(constraint));
}

export function assertBoardSeatSlug(value: unknown): asserts value is BoardSeatSlug {
  if (!isBoardSeatSlug(value)) {
    throw new Error('Unsupported seat: not one of the eight board seats');
  }
}

/**
 * The seats one account holds in one organization, held-outright first.
 *
 * This is the read that lands a signed-in board member on their own seat, so
 * it returns the seat and nothing about the account.
 */
export async function listSeatsForAccount(
  organizationId: string,
  accountId: string,
): Promise<BoardSeatAssignment[]> {
  const rows = await query<{ seat: BoardSeatSlug; is_primary: boolean }>(
    `select seat, is_primary
     from pilot.board_seats
     where organization_id = $1 and account_id = $2
     order by is_primary desc, seat`,
    [organizationId, accountId],
  );

  return rows.map((row) => ({ seat: row.seat, is_primary: row.is_primary }));
}

/**
 * The one seat a member's session should land on.
 *
 * A seat held outright wins over one shared with someone else, and a member
 * holding no seat resolves to null -- they belong on the shared board
 * workspace, not on a seat page that is not theirs.
 */
export function resolveLandingSeat(assignments: readonly BoardSeatAssignment[]): BoardSeatSlug | null {
  return assignments.find((item) => item.is_primary)?.seat ?? assignments[0]?.seat ?? null;
}

// Every holder of one seat: the person holding it outright, then anyone
// covering it -- co-chairs, a successor shadowing an outgoing officer, someone
// covering an absence.
export async function listSeatHolders(
  organizationId: string,
  seat: BoardSeatSlug,
): Promise<BoardSeatHolder[]> {
  return query<BoardSeatHolder>(
    `select ${SEAT_FIELDS}
     from pilot.board_seats
     where organization_id = $1 and seat = $2
     ${HOLDER_ORDER}`,
    [organizationId, seat],
  );
}

// The whole board of one organization, in seat order as the board pages list
// them rather than alphabetically, so President is not filed under P.
export async function listBoardRoster(organizationId: string): Promise<BoardSeatHolder[]> {
  const rows = await query<BoardSeatHolder>(
    `select ${SEAT_FIELDS}
     from pilot.board_seats
     where organization_id = $1
     ${HOLDER_ORDER}`,
    [organizationId],
  );

  const seatOrder = new Map(BOARD_SEAT_SLUGS.map((seat, index) => [seat, index]));
  return [...rows].sort((left, right) => {
    const difference = (seatOrder.get(left.seat) ?? BOARD_SEAT_SLUGS.length)
      - (seatOrder.get(right.seat) ?? BOARD_SEAT_SLUGS.length);
    if (difference !== 0) {
      return difference;
    }
    if (left.is_primary !== right.is_primary) {
      return left.is_primary ? -1 : 1;
    }
    return left.account_id.localeCompare(right.account_id);
  });
}

export async function getPrimarySeatHolderAccountId(
  organizationId: string,
  seat: BoardSeatSlug,
): Promise<string | null> {
  const row = await queryOne<{ account_id: string }>(
    `select account_id
     from pilot.board_seats
     where organization_id = $1 and seat = $2 and is_primary`,
    [organizationId, seat],
  );

  return row?.account_id ?? null;
}

/**
 * Who may seat and unseat the board.
 *
 * The organization's administrators, and the person holding the President seat
 * outright. Enforced here rather than in whichever surface happens to call it,
 * so hiding a control in the UI is never what stops an unauthorized write --
 * and the President check reads the seat from the database, never from the
 * caller's session payload, which the client could otherwise assert.
 */
export async function assertCanManageBoardSeats(actor: {
  accountId: string;
  role: PilotRole;
  organizationId: string;
}): Promise<void> {
  if (isOrganizationAdminRole(actor.role)) {
    return;
  }

  if (actor.role === 'board') {
    const president = await getPrimarySeatHolderAccountId(actor.organizationId, PRESIDENT_SEAT);
    if (president && president === actor.accountId) {
      return;
    }
  }

  throw new Error('Forbidden: only an organization administrator or the board President may manage board seats');
}

/**
 * A seat is held by a board member of this organization.
 *
 * The table's foreign key only proves the account exists somewhere on the
 * platform, so without this an account from another gym -- or an athlete
 * account -- could be recorded against this board.
 */
async function assertEligibleHolder(organizationId: string, accountId: string): Promise<void> {
  const row = await queryOne<{ account_id: string }>(
    `select a.account_id
     from pilot.accounts a
     left join pilot.organization_memberships om
       on om.account_id = a.account_id
      and om.organization_id = $1
      and om.active_flag = true
     where a.account_id = $2
       and a.active_flag = true
       and (a.organization_id = $1 or om.account_id is not null)
       and (a.role = 'board' or om.role = 'board')`,
    [organizationId, accountId],
  );

  if (!row) {
    throw new Error('Unsupported account: a board seat is held by an active board member of this organization');
  }
}

/**
 * Records an appointment.
 *
 * is_primary is a deliberate act: an assignment that says nothing about it
 * joins the seat rather than taking it from whoever holds it.
 */
export async function assignBoardSeat(params: {
  organizationId: string;
  seat: BoardSeatSlug;
  accountId: string;
  isPrimary?: boolean;
  assignedByAccountId: string;
}): Promise<BoardSeatHolder> {
  assertBoardSeatSlug(params.seat);
  await assertEligibleHolder(params.organizationId, params.accountId);

  try {
    const rows = await query<BoardSeatHolder>(
      `insert into pilot.board_seats
         (organization_id, seat, account_id, is_primary, assigned_by_account_id)
       values ($1, $2, $3, $4, $5)
       returning ${SEAT_FIELDS}`,
      [
        params.organizationId,
        params.seat,
        params.accountId,
        params.isPrimary === true,
        params.assignedByAccountId,
      ],
    );

    if (!rows[0]) {
      throw new Error('Board seat write verification failed');
    }

    return rows[0];
  } catch (error) {
    if (isUniqueViolation(error, 'pilot_board_seats_one_primary_per_seat')) {
      throw new BoardSeatConflictError(
        params.seat,
        await getPrimarySeatHolderAccountId(params.organizationId, params.seat),
      );
    }
    if (isUniqueViolation(error, 'pilot_board_seats_pkey')) {
      throw new Error('Board seat already held: that person already holds this seat');
    }
    throw error;
  }
}

// Ends one appointment. Returns null when this organization has no such
// assignment, so the caller reports "nothing changed" rather than a silent
// success -- and so a seat in another organization is never reachable.
export async function removeBoardSeat(params: {
  organizationId: string;
  seat: BoardSeatSlug;
  accountId: string;
}): Promise<BoardSeatHolder | null> {
  assertBoardSeatSlug(params.seat);

  const rows = await query<BoardSeatHolder>(
    `delete from pilot.board_seats
     where organization_id = $1 and seat = $2 and account_id = $3
     returning ${SEAT_FIELDS}`,
    [params.organizationId, params.seat, params.accountId],
  );

  return rows[0] ?? null;
}

/**
 * The handover the seat exists to survive.
 *
 * Demoting the outgoing holder and promoting the incoming one happen in one
 * transaction, because between the two statements the seat has no holder and
 * the single-primary index is momentarily satisfied by nothing. Split across
 * two requests, a failure in between leaves the seat vacant.
 *
 * The incoming holder must already be recorded on the seat: promotion changes
 * who holds a seat outright, it does not seat someone new.
 */
export async function setPrimarySeatHolder(params: {
  organizationId: string;
  seat: BoardSeatSlug;
  accountId: string;
}): Promise<BoardSeatHolder[]> {
  assertBoardSeatSlug(params.seat);

  return withTransaction(async (client) => {
    const existing = await client.query<BoardSeatHolder>(
      `select ${SEAT_FIELDS}
       from pilot.board_seats
       where organization_id = $1 and seat = $2
       for update`,
      [params.organizationId, params.seat],
    );

    if (!existing.rows.some((row) => row.account_id === params.accountId)) {
      throw new Error('Not found: that person does not hold this board seat');
    }

    await client.query(
      `update pilot.board_seats
       set is_primary = false, updated_at = now()
       where organization_id = $1 and seat = $2 and account_id <> $3 and is_primary`,
      [params.organizationId, params.seat, params.accountId],
    );

    await client.query(
      `update pilot.board_seats
       set is_primary = true, updated_at = now()
       where organization_id = $1 and seat = $2 and account_id = $3`,
      [params.organizationId, params.seat, params.accountId],
    );

    const holders = await client.query<BoardSeatHolder>(
      `select ${SEAT_FIELDS}
       from pilot.board_seats
       where organization_id = $1 and seat = $2
       ${HOLDER_ORDER}`,
      [params.organizationId, params.seat],
    );

    return holders.rows;
  });
}
