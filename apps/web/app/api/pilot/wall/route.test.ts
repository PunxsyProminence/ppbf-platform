import { NextRequest } from 'next/server';

import { GET } from './route';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import type { WallPublicBoard } from '@/src/server/pilot/wallDisplay';
import { loadPublicWallBoard } from '@/src/server/pilot/wallDisplayDb';
import { resetWallBudget } from '@/src/server/pilot/wallRateLimit';

jest.mock('@/src/server/pilot/wallDisplayDb', () => ({
  loadPublicWallBoard: jest.fn(),
  // Present in the mock only so the test below can prove the public route
  // never reaches for it. It must stay uncalled.
  loadWallBoard: jest.fn(),
}));

jest.mock('@/src/server/pilot/env', () => ({
  getPilotDefaultOrganizationId: jest.fn(() => 'ppbf-default-org'),
  getWallDisplayNameMode: jest.fn(() => 'consent'),
}));

const mockLoad = loadPublicWallBoard as jest.MockedFunction<typeof loadPublicWallBoard>;
const mockOrg = getPilotDefaultOrganizationId as jest.MockedFunction<typeof getPilotDefaultOrganizationId>;

const PUBLIC_BOARD: WallPublicBoard = {
  scope: 'public',
  generated_at: '2026-08-03T18:30:00.000Z',
  gym_day: '2026-08-03',
  time_zone: 'America/New_York',
  sessions: [
    {
      key: 'c1',
      title: 'Youth Boxing',
      start_at: '2026-08-03T22:00:00.000Z',
      end_at: '2026-08-03T23:00:00.000Z',
      location: 'Floor',
      state: 'upcoming',
      on_floor: 3,
    },
  ],
  on_floor_total: 7,
  notice: { message: 'Open mat Saturday.', author: 'Coach Dan · coach', posted_at: '2026-08-01T12:00:00.000Z' },
};

function request(url = 'http://localhost/api/pilot/wall', ip = '10.0.0.1') {
  return new NextRequest(url, { headers: { 'x-real-ip': ip } });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWallBudget();
  mockLoad.mockResolvedValue(PUBLIC_BOARD);
});

describe('GET /api/pilot/wall', () => {
  it('serves the board without a session, because nobody logs a television in', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, board: { gym_day: '2026-08-03' } });
  });

  it('always reads the configured organization and never one from the caller', async () => {
    // The public announcements route's own header records why: an
    // unauthenticated endpoint that accepts an org id is a way to read another
    // gym's children.
    await GET(request('http://localhost/api/pilot/wall?organization_id=someone-else'));
    expect(mockOrg).toHaveBeenCalled();
    expect(mockLoad).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'ppbf-default-org' }));
  });

  // OD-2026-10-07-008, "Paired gym TV only": the public address shows today's
  // classes and a head count only. Initials and milestones go only to a TV
  // paired with a code. These three tests are the public half of that ruling.
  it('serves the PUBLIC shape: classes and a head count, and no person at all', async () => {
    const response = await GET(request());
    const body = (await response.json()) as { ok: boolean; board: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(Object.keys(body.board).sort()).toEqual(
      ['generated_at', 'gym_day', 'notice', 'on_floor_total', 'scope', 'sessions', 'time_zone'],
    );
    expect(body.board.scope).toBe('public');
    expect(body.board.on_floor_total).toBe(7);
  });

  it('carries no name, initials, visibility, milestone or athlete key in the serialized body', async () => {
    const serialized = JSON.stringify(await (await GET(request())).json());
    for (const forbidden of ['"on_floor":[', 'marquee', '"name"', 'visibility', 'initials', 'milestone', 'athlete', 'name_mode', 'crossed_on']) {
      expect({ forbidden, present: serialized.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it('reads the public loader only: the name mode and the paired loader are never consulted here', async () => {
    // The operator's PPBF_WALL_DISPLAY_NAMES setting is for the paired board.
    // Even set to 'consent' (mocked above), it changes nothing on this route,
    // because this route has no names to apply it to.
    const db = jest.requireMock('@/src/server/pilot/wallDisplayDb') as { loadWallBoard: jest.Mock };
    const env = jest.requireMock('@/src/server/pilot/env') as { getWallDisplayNameMode: jest.Mock };
    await GET(request());
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad.mock.calls[0][0]).toEqual({ organizationId: 'ppbf-default-org' });
    expect(db.loadWallBoard).not.toHaveBeenCalled();
    expect(env.getWallDisplayNameMode).not.toHaveBeenCalled();
  });

  it('is never cached, because a wall showing yesterday is worse than a blank one', async () => {
    const response = await GET(request());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('leaks nothing about a failure to the screen', async () => {
    // The diagnostic is supposed to reach the log, so the log is silenced here
    // rather than the route made quieter.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockLoad.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432 as user ppbf_app'));
    const response = await GET(request());
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|5432|ppbf_app/);
    expect(body).toEqual({ ok: false, error: 'The board is unavailable.' });
  });

  it('lets a television poll all day and still stops a scraper', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await GET(request())).status).toBe(200);
    }
    const refused = await GET(request());
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBeTruthy();

    // A different address is unaffected.
    expect((await GET(request('http://localhost/api/pilot/wall', '10.0.0.2'))).status).toBe(200);
  });
});
