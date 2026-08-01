import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Two things this file has to hold.
//
// A seat page opens for its own holders, for the President and Chair, and for
// the platform owner reading. Everyone else on the board goes to the hub --
// which means the wrong answer here is not "locked out", it is "shown a seat
// they do not hold", and the empty-seat case (a board member with no
// assignment at all) is the one that used to admit everybody.
//
// And no board tile may carry a placeholder that reads like a figure. The
// board surface shipped forty of them: 'Unavailable' beside 'Reserve
// Monitoring' tells a fiduciary a reserve figure exists and merely failed to
// load. Nothing on this surface stores a reserve at all.

import {
  BOARD_AGGREGATE_BOUNDARY_STATEMENT,
  BOARD_PLANNED_STAMP,
  BOARD_RECORD_NOT_HELD,
  boardSeatConfigs,
  boardWorkspaceCards,
  boardWorkspaceTabs,
  readBoardSeatsFromSession,
  resolveBoardSeatAccess,
  type BoardSeatSlug,
} from './boardWorkspaceConfig';

const ALL_SEATS = boardSeatConfigs.map((seat) => seat.slug);

function assignments(...seats: BoardSeatSlug[]) {
  return seats.map((seat, index) => ({ seat, is_primary: index === 0 }));
}

describe('readBoardSeatsFromSession', () => {
  test('reads the seats the session reports', () => {
    expect(readBoardSeatsFromSession({ board_seats: assignments('treasurer', 'secretary') }))
      .toEqual(['treasurer', 'secretary']);
  });

  test('treats a session with no seat field as holding no seat', () => {
    expect(readBoardSeatsFromSession({ authenticated: true, role: 'board' })).toEqual([]);
    expect(readBoardSeatsFromSession(null)).toEqual([]);
    expect(readBoardSeatsFromSession({ board_seats: 'treasurer' })).toEqual([]);
  });

  test('drops a seat the app cannot route to instead of trusting it', () => {
    expect(readBoardSeatsFromSession({
      board_seats: [{ seat: 'treasurer' }, { seat: 'chief-executive' }, { seat: 'constructor' }, null],
    })).toEqual(['treasurer']);
  });
});

describe('resolveBoardSeatAccess', () => {
  test('admits the holder of the seat', () => {
    expect(resolveBoardSeatAccess({ role: 'board', seats: ['treasurer'], seat: 'treasurer' }))
      .toEqual({ allowed: true, mode: 'seat-holder' });
  });

  test.each(['president', 'chair'] as const)('%s reaches every other seat', (oversightSeat) => {
    for (const seat of ALL_SEATS) {
      expect(resolveBoardSeatAccess({ role: 'board', seats: [oversightSeat], seat }))
        .toEqual({ allowed: true, mode: expect.stringMatching(/seat-holder|governance-oversight/) });
    }
  });

  test('sends another seat holder to the hub rather than to a dead end', () => {
    expect(resolveBoardSeatAccess({ role: 'board', seats: ['secretary'], seat: 'treasurer' }))
      .toEqual({ allowed: false, redirectTo: '/board' });
  });

  test('a board member holding no seat gets the hub', () => {
    for (const seat of ALL_SEATS) {
      expect(resolveBoardSeatAccess({ role: 'board', seats: [], seat }))
        .toEqual({ allowed: false, redirectTo: '/board' });
    }
  });

  test('a member holding two seats reaches both', () => {
    const seats: BoardSeatSlug[] = ['secretary', 'at-large'];
    expect(resolveBoardSeatAccess({ role: 'board', seats, seat: 'secretary' }).allowed).toBe(true);
    expect(resolveBoardSeatAccess({ role: 'board', seats, seat: 'at-large' }).allowed).toBe(true);
    expect(resolveBoardSeatAccess({ role: 'board', seats, seat: 'treasurer' }).allowed).toBe(false);
  });

  test('platform owner reads any seat and is never treated as holding one', () => {
    for (const seat of ALL_SEATS) {
      expect(resolveBoardSeatAccess({ role: 'platform_owner', seats: [], seat }))
        .toEqual({ allowed: true, mode: 'platform-observer' });
    }
  });

  test('no other role reaches a seat page', () => {
    expect(resolveBoardSeatAccess({ role: null, seats: ['president'], seat: 'president' }))
      .toEqual({ allowed: false, redirectTo: '/board' });
  });
});

describe('seat configuration', () => {
  test('carries all eight governing seats', () => {
    expect(ALL_SEATS).toHaveLength(8);
    expect(new Set(ALL_SEATS).size).toBe(8);
  });

  test('states outright that no governance record is stored, and never fakes a figure', () => {
    for (const seat of boardSeatConfigs) {
      for (const field of [
        seat.openTasksCount,
        seat.pendingReviewsCount,
        seat.meetingItemsCount,
        seat.complianceItemsCount,
      ]) {
        expect(field).toBe(BOARD_RECORD_NOT_HELD);
        expect(field).not.toMatch(/^Unavailable$/);
        expect(field).not.toMatch(/^[\d.,%-]+$/);
      }
    }
  });

  test('does not call a 501(c)(3) veteran-owned', () => {
    for (const seat of boardSeatConfigs) {
      expect(seat.roleDescription).not.toMatch(/veteran-owned/i);
    }
    expect(boardSeatConfigs[0].roleDescription).toMatch(/veteran-founded/i);
  });

  test('the boundary statement names the one administrative control a seat carries', () => {
    // Seat assignment IS an administrative control and the president holds it,
    // so a statement claiming none reach this role would be false. Everything
    // else it excludes is excluded by access.ts, not by this sentence.
    expect(BOARD_AGGREGATE_BOUNDARY_STATEMENT).toBe(
      'Board access is organization-level and aggregate-only. Small cohorts are suppressed, missing data remains unavailable, and athlete records, messages, notes, intake records, video, and safety review remain outside this role. The only administrative control a seat carries is board seat assignment, held by the president.',
    );
  });

  test('the hub renders the shared constant rather than its own copy', () => {
    // Two hand-maintained copies of a boundary claim drift, and the softer one
    // is always the one somebody reads.
    const hub = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(hub).toContain('{BOARD_AGGREGATE_BOUNDARY_STATEMENT}');
    expect(hub).not.toContain('Board access is organization-level and aggregate-only.');
  });
});

describe('workspace card catalogue', () => {
  const everyCard = boardWorkspaceTabs.flatMap((tab) => boardWorkspaceCards[tab]);

  test('covers every tab the workspace renders', () => {
    for (const tab of boardWorkspaceTabs) {
      expect(boardWorkspaceCards[tab].length).toBeGreaterThan(0);
    }
  });

  test('only the two cards with a route behind them claim to be available', () => {
    // GET /api/pilot/board/summary and GET /api/pilot/board/compliance-summary
    // are the whole of what a board session can load. Anything else marked
    // 'built' would be a claim with no endpoint under it.
    const built = everyCard.filter((card) => card.status === 'built').map((card) => card.title);
    expect(new Set(built)).toEqual(new Set(['Organization Aggregate', 'Hand-Filed Compliance Register']));
  });

  test('every other card is stamped rather than left looking shipped', () => {
    const unbacked = everyCard.filter((card) => card.status !== 'built');
    expect(unbacked.length).toBeGreaterThan(40);
    for (const card of unbacked) {
      expect(['planned', 'boundary']).toContain(card.status);
    }
  });

  test.each(['Resolution Registry', 'Committee Workboard', 'Document Registry'])(
    '%s is marked planned, not described as if it exists',
    (title) => {
      const card = everyCard.find((item) => item.title === title);
      expect(card?.status).toBe('planned');
    },
  );

  test('no card claims automated or real-time compliance detection', () => {
    // compliance_rules.detection_logic is descriptive prose that nothing runs,
    // and the only writer is a manual POST.
    for (const card of everyCard) {
      expect(`${card.title} ${card.detail}`).not.toMatch(/automated|real-time|realtime/i);
    }
  });

  test('the stamp is the one the workspace renders', () => {
    expect(BOARD_PLANNED_STAMP).toBe('PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED');
  });
});

describe('legacy fiction', () => {
  test('nothing in the seat catalogue is the bare placeholder any more', () => {
    const everyString = [
      BOARD_RECORD_NOT_HELD,
      ...boardSeatConfigs.flatMap((seat) => [
        seat.seatLabel,
        seat.roleDescription,
        seat.openTasksCount,
        seat.pendingReviewsCount,
        seat.meetingItemsCount,
        seat.complianceItemsCount,
        ...seat.primaryResponsibilities,
      ]),
      ...boardWorkspaceTabs.flatMap((tab) => boardWorkspaceCards[tab].map((card) => card.title)),
    ];

    for (const value of everyString) {
      expect(value.trim()).not.toBe('Unavailable');
    }
  });
});
