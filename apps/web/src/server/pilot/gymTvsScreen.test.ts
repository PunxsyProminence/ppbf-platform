/**
 * readGymTvScreen, the paired TV's whole screen (W1). gymTvs.pg.test.ts proves
 * the pairing, the key gate and readGymTvSession against the real database and
 * is deliberately untouched; this pins the composition on top of it with the
 * database mocked: one key resolution per read, the board for the TV's own
 * organization, nothing on an unknown key, and the best-effort rule for a
 * board that fails to load (PR 2).
 */
jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(),
}));

jest.mock('./wallDisplayDb', () => ({
  loadWallBoard: jest.fn(),
  loadPublicWallBoard: jest.fn(),
}));

import { query, queryOne } from './db';
import { readGymTvScreen } from './gymTvs';
import type { WallBoard } from './wallDisplay';
import { loadWallBoard } from './wallDisplayDb';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockLoadWallBoard = jest.mocked(loadWallBoard);

const TV = {
  organization_id: 'org-b',
  tv_id: 'tv-1',
  tv_name: 'House',
  current_run_id: null,
  current_run_set_by_account_id: null,
};

const BOARD: WallBoard = {
  generated_at: '2026-10-08T18:00:00.000Z',
  gym_day: '2026-10-08',
  time_zone: 'America/New_York',
  name_mode: 'initials',
  sessions: [],
  on_floor: [{ key: 'k1', name: 'M.R.', visibility: 'initials' }],
  on_floor_total: 1,
  marquee: [],
  notice: null,
};

afterEach(() => {
  jest.clearAllMocks();
});

it('an unknown or empty key is null before any board is loaded', async () => {
  mockQueryOne.mockResolvedValue(null);
  expect(await readGymTvScreen('k'.repeat(64), { mode: 'initials' })).toBeNull();
  expect(await readGymTvScreen('', { mode: 'initials' })).toBeNull();
  expect(mockLoadWallBoard).not.toHaveBeenCalled();
});

it("a paired TV with nothing on it gets its name, session: null, and the board for ITS organization", async () => {
  mockQueryOne.mockResolvedValueOnce(TV);
  mockLoadWallBoard.mockResolvedValue(BOARD);

  const read = await readGymTvScreen('k'.repeat(64), { mode: 'consent' });

  expect(read).toEqual({ tv: { tv_name: 'House' }, session: null, board: BOARD, board_status: 'ok' });
  expect(mockLoadWallBoard).toHaveBeenCalledTimes(1);
  expect(mockLoadWallBoard).toHaveBeenCalledWith({ organizationId: 'org-b', mode: 'consent' });
  // One resolution of the key (one last_seen_at touch), not one per read.
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
  expect(String(mockQueryOne.mock.calls[0][0])).toContain('device_key_hash = $1');
  expect(mockQuery).not.toHaveBeenCalled();
});

it('a board load failure is best-effort: board null, board_status unavailable, the session still served', async () => {
  mockQueryOne.mockResolvedValueOnce(TV);
  mockLoadWallBoard.mockRejectedValue(Object.assign(new Error('relation pilot.sessions does not exist at db.internal'), { code: '42P01' }));
  const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const read = await readGymTvScreen('k'.repeat(64), { mode: 'initials' });
    expect(read).toEqual({ tv: { tv_name: 'House' }, session: null, board: null, board_status: 'unavailable' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toBe('tv-board-read-failed');
    expect(logged.mock.calls[0][1]).toEqual({ name: 'Error', code: '42P01' });
    expect(JSON.stringify(logged.mock.calls[0])).not.toContain('db.internal');
  } finally {
    logged.mockRestore();
  }
});
