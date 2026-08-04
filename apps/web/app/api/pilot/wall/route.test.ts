import { NextRequest } from 'next/server';

import { GET } from './route';
import { getPilotDefaultOrganizationId, getWallDisplayNameMode } from '@/src/server/pilot/env';
import { loadWallBoard } from '@/src/server/pilot/wallDisplayDb';
import { resetWallBudget } from '@/src/server/pilot/wallRateLimit';

jest.mock('@/src/server/pilot/wallDisplayDb', () => ({
  loadWallBoard: jest.fn(),
}));

jest.mock('@/src/server/pilot/env', () => ({
  getPilotDefaultOrganizationId: jest.fn(() => 'ppbf-default-org'),
  getWallDisplayNameMode: jest.fn(() => undefined),
}));

const mockLoad = loadWallBoard as jest.MockedFunction<typeof loadWallBoard>;
const mockMode = getWallDisplayNameMode as jest.MockedFunction<typeof getWallDisplayNameMode>;
const mockOrg = getPilotDefaultOrganizationId as jest.MockedFunction<typeof getPilotDefaultOrganizationId>;

const EMPTY_BOARD = {
  generated_at: '2026-08-03T18:30:00.000Z',
  gym_day: '2026-08-03',
  time_zone: 'America/New_York',
  name_mode: 'initials' as const,
  sessions: [],
  on_floor: [],
  on_floor_total: 0,
  marquee: [],
  notice: null,
};

function request(url = 'http://localhost/api/pilot/wall', ip = '10.0.0.1') {
  return new NextRequest(url, { headers: { 'x-real-ip': ip } });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWallBudget();
  mockLoad.mockResolvedValue(EMPTY_BOARD);
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

  it('defaults to initials when the operator has set nothing', async () => {
    mockMode.mockReturnValue(undefined);
    await GET(request());
    expect(mockLoad).toHaveBeenCalledWith(expect.objectContaining({ mode: 'initials' }));
  });

  it('only reaches real names when an operator asked for it in as many words', async () => {
    mockMode.mockReturnValue('consent');
    await GET(request());
    expect(mockLoad).toHaveBeenCalledWith(expect.objectContaining({ mode: 'consent' }));

    resetWallBudget();
    mockMode.mockReturnValue('yes please');
    await GET(request());
    expect(mockLoad).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'initials' }));
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
