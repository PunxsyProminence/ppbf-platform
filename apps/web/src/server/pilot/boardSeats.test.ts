import {
  BOARD_SEAT_SLUGS,
  BoardSeatConflictError,
  assertCanManageBoardSeats,
  assignBoardSeat,
  listBoardRoster,
  listSeatHolders,
  listSeatsForAccount,
  removeBoardSeat,
  resolveLandingSeat,
  setPrimarySeatHolder,
} from './boardSeats';
import { query, queryOne, withTransaction } from './db';
import { boardSeatConfigs } from '@/app/board/boardWorkspaceConfig';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockWithTransaction = jest.mocked(withTransaction);

const ORG = 'org-a';
const OTHER_ORG = 'org-b';

// The shape pg raises when the partial unique index refuses a second holder.
function uniqueViolation(constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });
}

function eligibleHolder(): void {
  mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-board' });
}

function sqlOfCall(index: number): string {
  return String(mockQuery.mock.calls[index][0]);
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('the seat vocabulary is the one the board pages route on', () => {
  test('carries the eight seats and nothing the app cannot render', () => {
    expect(BOARD_SEAT_SLUGS).toEqual(boardSeatConfigs.map((seat) => seat.slug));
    expect(BOARD_SEAT_SLUGS).toHaveLength(8);
  });

  test.each(['vice-president', 'chairman', '', 'BOARD', 'president '])(
    'refuses to record a seat no page can open: %p',
    async (seat) => {
      await expect(
        assignBoardSeat({
          organizationId: ORG,
          seat: seat as never,
          accountId: 'acct-board',
          assignedByAccountId: 'acct-admin',
        }),
      ).rejects.toThrow(/Unsupported seat/);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );
});

describe('who may seat and unseat the board', () => {
  test.each(['organization_admin', 'admin'])('an %s may, without consulting the seat table', async (role) => {
    await expect(assertCanManageBoardSeats({
      accountId: 'acct-admin',
      role: role as never,
      organizationId: ORG,
    })).resolves.toBeUndefined();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('the President may, and the seat is read from the database rather than claimed', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-president' });

    await expect(assertCanManageBoardSeats({
      accountId: 'acct-president',
      role: 'board',
      organizationId: ORG,
    })).resolves.toBeUndefined();

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('is_primary');
    expect(params).toEqual([ORG, 'president']);
  });

  test('a board member who is not the President may not', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-president' });

    await expect(assertCanManageBoardSeats({
      accountId: 'acct-treasurer',
      role: 'board',
      organizationId: ORG,
    })).rejects.toThrow(/^Forbidden/);
  });

  // A co-holder covering the President seat is not the holder of it, so the
  // read that authorizes management must be the is_primary one.
  test('a vacant President seat authorizes nobody', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(assertCanManageBoardSeats({
      accountId: 'acct-board',
      role: 'board',
      organizationId: ORG,
    })).rejects.toThrow(/^Forbidden/);
  });

  test('the President of another gym cannot manage this one', async () => {
    // The lookup is scoped to the caller's own organization, so a President
    // elsewhere simply does not appear as this organization's President.
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(assertCanManageBoardSeats({
      accountId: 'acct-other-org-president',
      role: 'board',
      organizationId: OTHER_ORG,
    })).rejects.toThrow(/^Forbidden/);
    expect(mockQueryOne.mock.calls[0][1]).toEqual([OTHER_ORG, 'president']);
  });

  test.each(['coach', 'athlete', 'parent', 'staff', 'volunteer', 'platform_owner'])(
    'refuses %s outright',
    async (role) => {
      await expect(assertCanManageBoardSeats({
        accountId: 'acct-other',
        role: role as never,
        organizationId: ORG,
      })).rejects.toThrow(/^Forbidden/);
      expect(mockQueryOne).not.toHaveBeenCalled();
    },
  );
});

describe('assigning a seat', () => {
  test('records an appointment that does not take the seat unless it says so', async () => {
    eligibleHolder();
    mockQuery.mockResolvedValueOnce([
      { seat: 'treasurer', account_id: 'acct-board', is_primary: false, assigned_at: 'when' },
    ]);

    const holder = await assignBoardSeat({
      organizationId: ORG,
      seat: 'treasurer',
      accountId: 'acct-board',
      assignedByAccountId: 'acct-admin',
    });

    expect(holder.is_primary).toBe(false);
    expect(mockQuery.mock.calls[0][1]).toEqual([ORG, 'treasurer', 'acct-board', false, 'acct-admin']);
  });

  test('refuses an account that is not an active board member of this organization', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(assignBoardSeat({
      organizationId: ORG,
      seat: 'treasurer',
      accountId: 'acct-athlete',
      assignedByAccountId: 'acct-admin',
    })).rejects.toThrow(/Unsupported account/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('the eligibility read is scoped to the assigning organization', async () => {
    eligibleHolder();
    mockQuery.mockResolvedValueOnce([
      { seat: 'chair', account_id: 'acct-board', is_primary: false, assigned_at: 'when' },
    ]);

    await assignBoardSeat({
      organizationId: ORG,
      seat: 'chair',
      accountId: 'acct-board',
      assignedByAccountId: 'acct-admin',
    });

    expect(mockQueryOne.mock.calls[0][1]).toEqual([ORG, 'acct-board']);
  });

  // The database is what refuses the second holder; this is the translation
  // that turns its constraint name into something the caller can act on.
  test('a second holder outright is reported by naming the person who holds it', async () => {
    eligibleHolder();
    mockQuery.mockRejectedValueOnce(uniqueViolation('pilot_board_seats_one_primary_per_seat'));
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-sitting-treasurer' });

    const rejection = assignBoardSeat({
      organizationId: ORG,
      seat: 'treasurer',
      accountId: 'acct-challenger',
      isPrimary: true,
      assignedByAccountId: 'acct-admin',
    });

    await expect(rejection).rejects.toBeInstanceOf(BoardSeatConflictError);
    await expect(rejection).rejects.toThrow(/Treasurer is held by acct-sitting-treasurer/);
  });

  test('the conflict carries the seat and the current holder for the caller to act on', async () => {
    eligibleHolder();
    mockQuery.mockRejectedValueOnce(uniqueViolation('pilot_board_seats_one_primary_per_seat'));
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-sitting-president' });

    let conflict: BoardSeatConflictError | null = null;
    try {
      await assignBoardSeat({
        organizationId: ORG,
        seat: 'president',
        accountId: 'acct-challenger',
        isPrimary: true,
        assignedByAccountId: 'acct-admin',
      });
    } catch (thrown) {
      conflict = thrown as BoardSeatConflictError;
    }

    expect(conflict?.seat).toBe('president');
    expect(conflict?.currentHolderAccountId).toBe('acct-sitting-president');
  });

  test('holding the same seat twice is refused as its own message', async () => {
    eligibleHolder();
    mockQuery.mockRejectedValueOnce(uniqueViolation('pilot_board_seats_pkey'));

    await expect(assignBoardSeat({
      organizationId: ORG,
      seat: 'secretary',
      accountId: 'acct-board',
      assignedByAccountId: 'acct-admin',
    })).rejects.toThrow(/already holds this seat/);
  });

  // Every other database failure has to keep its own identity rather than
  // being reported to a board administrator as a seat conflict.
  test('an unrelated database failure is not dressed up as a seat conflict', async () => {
    eligibleHolder();
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '08006' }));

    await expect(assignBoardSeat({
      organizationId: ORG,
      seat: 'secretary',
      accountId: 'acct-board',
      assignedByAccountId: 'acct-admin',
    })).rejects.not.toBeInstanceOf(BoardSeatConflictError);
  });
});

describe('the handover', () => {
  function transactionClient(rows: Array<{ rows: unknown[] }>) {
    const client = { query: jest.fn() };
    for (const result of rows) {
      client.query.mockResolvedValueOnce(result);
    }
    mockWithTransaction.mockImplementation(async (fn) => fn(client as never));
    return client;
  }

  test('demotes the outgoing holder and promotes the incoming one in one transaction', async () => {
    const client = transactionClient([
      {
        rows: [
          { seat: 'secretary', account_id: 'acct-outgoing', is_primary: true, assigned_at: 'when' },
          { seat: 'secretary', account_id: 'acct-incoming', is_primary: false, assigned_at: 'when' },
        ],
      },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          { seat: 'secretary', account_id: 'acct-incoming', is_primary: true, assigned_at: 'when' },
          { seat: 'secretary', account_id: 'acct-outgoing', is_primary: false, assigned_at: 'when' },
        ],
      },
    ]);

    const holders = await setPrimarySeatHolder({
      organizationId: ORG,
      seat: 'secretary',
      accountId: 'acct-incoming',
    });

    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(String(client.query.mock.calls[1][0])).toMatch(/is_primary = false/);
    expect(String(client.query.mock.calls[2][0])).toMatch(/is_primary = true/);
    expect(holders[0]).toMatchObject({ account_id: 'acct-incoming', is_primary: true });
  });

  test('promotion does not seat someone who does not already hold the seat', async () => {
    const client = transactionClient([
      { rows: [{ seat: 'chair', account_id: 'acct-someone-else', is_primary: true, assigned_at: 'when' }] },
    ]);

    await expect(setPrimarySeatHolder({
      organizationId: ORG,
      seat: 'chair',
      accountId: 'acct-not-a-holder',
    })).rejects.toThrow(/^Not found/);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('refuses a seat the pages cannot route to before opening a transaction', async () => {
    await expect(setPrimarySeatHolder({
      organizationId: ORG,
      seat: 'vice-president' as never,
      accountId: 'acct-board',
    })).rejects.toThrow(/Unsupported seat/);
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });
});

describe('reads stay organization-scoped and carry no personal data', () => {
  test('an account reads only its own seats, held outright first', async () => {
    mockQuery.mockResolvedValueOnce([
      { seat: 'treasurer', is_primary: true },
      { seat: 'at-large', is_primary: false },
    ]);

    const seats = await listSeatsForAccount(ORG, 'acct-board');

    expect(seats).toEqual([
      { seat: 'treasurer', is_primary: true },
      { seat: 'at-large', is_primary: false },
    ]);
    expect(mockQuery.mock.calls[0][1]).toEqual([ORG, 'acct-board']);
  });

  test('a seat lists its holder outright ahead of anyone covering it', async () => {
    mockQuery.mockResolvedValueOnce([
      { seat: 'chair', account_id: 'acct-holder', is_primary: true, assigned_at: 'when' },
      { seat: 'chair', account_id: 'acct-cover', is_primary: false, assigned_at: 'when' },
    ]);

    await listSeatHolders(ORG, 'chair');

    expect(sqlOfCall(0)).toMatch(/order by is_primary desc/);
    expect(mockQuery.mock.calls[0][1]).toEqual([ORG, 'chair']);
  });

  test('the roster renders in seat order rather than alphabetically', async () => {
    mockQuery.mockResolvedValueOnce([
      { seat: 'at-large', account_id: 'acct-d', is_primary: true, assigned_at: 'when' },
      { seat: 'president', account_id: 'acct-a', is_primary: true, assigned_at: 'when' },
      { seat: 'chair', account_id: 'acct-c', is_primary: false, assigned_at: 'when' },
      { seat: 'chair', account_id: 'acct-b', is_primary: true, assigned_at: 'when' },
    ]);

    const roster = await listBoardRoster(ORG);

    expect(roster.map((row) => `${row.seat}:${row.account_id}`)).toEqual([
      'president:acct-a',
      'chair:acct-b',
      'chair:acct-c',
      'at-large:acct-d',
    ]);
  });

  // The board role is aggregate-only. A governance roster is the one
  // board-readable per-account surface, so it must never widen into a
  // directory of personal data or reach a youth record.
  test.each([
    ['every seat read', async () => {
      mockQuery.mockResolvedValueOnce([]);
      await listBoardRoster(ORG);
    }],
    ['one seat read', async () => {
      mockQuery.mockResolvedValueOnce([]);
      await listSeatHolders(ORG, 'treasurer');
    }],
    ['one account read', async () => {
      mockQuery.mockResolvedValueOnce([]);
      await listSeatsForAccount(ORG, 'acct-board');
    }],
  ])('%s selects named governance columns only', async (_label, run) => {
    await (run as () => Promise<void>)();

    const sql = sqlOfCall(0);
    expect(sql).not.toMatch(/select\s+\*/i);
    expect(sql).not.toMatch(/login_email|pin_hash|athlete_id|payload|entity_id|auth_provider/);
    expect(sql).toMatch(/from pilot\.board_seats/);
  });

  test('removing an assignment this organization never recorded reports nothing changed', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(removeBoardSeat({
      organizationId: ORG,
      seat: 'treasurer',
      accountId: 'acct-board',
    })).resolves.toBeNull();
    expect(mockQuery.mock.calls[0][1]).toEqual([ORG, 'treasurer', 'acct-board']);
  });
});

describe('the seat a session lands on', () => {
  test('a seat held outright wins over one shared with someone else', () => {
    expect(resolveLandingSeat([
      { seat: 'at-large', is_primary: false },
      { seat: 'treasurer', is_primary: true },
    ])).toBe('treasurer');
  });

  test('a member who only covers a seat still lands on it', () => {
    expect(resolveLandingSeat([{ seat: 'chair', is_primary: false }])).toBe('chair');
  });

  test('a board member holding no seat lands nowhere in particular', () => {
    expect(resolveLandingSeat([])).toBeNull();
  });
});
