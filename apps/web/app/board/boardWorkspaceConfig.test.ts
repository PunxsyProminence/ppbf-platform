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
//
// The seat catalogue used to answer that with four count fields per seat, all
// set to BOARD_RECORD_NOT_HELD and rendered by nothing. Those are gone; the
// check that replaced them is that no seat carries a count-shaped field at
// all, which is a stronger statement than any string test on one.

import {
  BOARD_AGGREGATE_BOUNDARY_STATEMENT,
  BOARD_PLANNED_STAMP,
  BOARD_RECORD_NOT_HELD,
  BOARD_TAB_PLANNED_STAMP,
  boardSeatConfigs,
  boardTabStatus,
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

  test('carries no count field at all, faked or otherwise', () => {
    // A seat has nothing to count: pilot holds no board task table, no
    // policy-review queue, no meeting calendar and no risk register. The four
    // *Count fields were dead weight rendered by nothing, and the mutation
    // this guards against is somebody adding one back with a number in it.
    for (const seat of boardSeatConfigs) {
      for (const key of Object.keys(seat)) {
        expect(key).not.toMatch(/count/i);
      }
      for (const value of Object.values(seat)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          expect(String(entry)).not.toMatch(/^Unavailable$/);
          expect(String(entry)).not.toMatch(/^[\d.,%-]+$/);
        }
      }
    }
  });

  test('the not-held sentence is still stated once, for the panel that renders it', () => {
    expect(BOARD_RECORD_NOT_HELD).toBe('Not stored by this platform');
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
      expect(card.status).toBe('planned');
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
    expect(BOARD_TAB_PLANNED_STAMP).toBe('Planned');
  });

  test('the word SHADOW does not appear anywhere in the board catalogue', () => {
    // Not a taste rule. The board room's purpose line forbids the ask-SHADOW
    // surface outright, and an eleventh tab named for it -- even one whose
    // three cards only said no -- put the word on the wall on every seat page.
    const catalogue = [
      ...boardWorkspaceTabs,
      ...everyCard.flatMap((card) => [card.title, card.detail]),
    ].join(' ');
    expect(catalogue).not.toMatch(/shadow/i);
  });
});

describe('per-tab status', () => {
  test('is read off the cards, so a tab cannot disagree with its own panel', () => {
    for (const tab of boardWorkspaceTabs) {
      const hasBuilt = boardWorkspaceCards[tab].some((card) => card.status === 'built');
      expect(boardTabStatus(tab)).toBe(hasBuilt ? 'partly-built' : 'planned');
    }
  });

  test('only the two tabs with a loadable card escape the stamp', () => {
    // The mutation worth catching is a tab strip that stops stamping: nine of
    // eleven tabs were 100% placeholder and every button looked the same, so a
    // fiduciary only learned which by clicking.
    const planned = boardWorkspaceTabs.filter((tab) => boardTabStatus(tab) === 'planned');
    expect(planned).toEqual([
      'Governance', 'Strategy', 'Meetings', 'Tasks', 'Policies', 'Resolutions', 'Committees', 'Documents',
    ]);
    expect(boardTabStatus('Overview')).toBe('partly-built');
    expect(boardTabStatus('Compliance')).toBe('partly-built');
  });
});

describe('legacy fiction', () => {
  test('nothing in the seat catalogue is the bare placeholder any more', () => {
    const everyString = [
      BOARD_RECORD_NOT_HELD,
      ...boardSeatConfigs.flatMap((seat) => [
        seat.seatLabel,
        seat.roleDescription,
        ...seat.primaryResponsibilities,
      ]),
      ...boardWorkspaceTabs.flatMap((tab) => boardWorkspaceCards[tab].map((card) => card.title)),
    ];

    for (const value of everyString) {
      expect(value.trim()).not.toBe('Unavailable');
    }
  });
});
