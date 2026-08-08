import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getSessionScriptWithDetail, listSessionScripts } from '@/src/server/pilot/sessionScripts';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/sessionScripts', () => {
  const actual = jest.requireActual('@/src/server/pilot/sessionScripts');
  return { ...actual, listSessionScripts: jest.fn(), getSessionScriptWithDetail: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listSessionScripts as jest.Mock;
const mockDetail = getSessionScriptWithDetail as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function get(url: string) {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockList.mockResolvedValue([]);
  mockDetail.mockResolvedValue(null);
});

describe('GET /api/pilot/session-scripts', () => {
  it('lists scripts for the caller organization', async () => {
    mockList.mockResolvedValue([{ script_id: 'scr-1', name: 'Friday sparring' }]);

    const response = await get('http://localhost/api/pilot/session-scripts');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scripts: [{ script_id: 'scr-1', name: 'Friday sparring' }],
    });
  });

  it('scopes the query to the principal organization, never a caller-supplied one', async () => {
    await get('http://localhost/api/pilot/session-scripts?organization_id=other-org');

    expect(mockList).toHaveBeenCalledWith('org-1', expect.anything());
  });

  it('passes every browse filter through to the module', async () => {
    await get(
      'http://localhost/api/pilot/session-scripts'
        + '?discipline=boxing&phase=taper&day_of_week=friday&authoring_state=in_use',
    );

    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: 'boxing',
      phase: 'taper',
      dayOfWeek: 'friday',
      authoringState: 'in_use',
      includeRetired: false,
    });
  });

  it('leaves absent filters undefined rather than sending empty strings', async () => {
    await get('http://localhost/api/pilot/session-scripts');

    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: undefined,
      phase: undefined,
      dayOfWeek: undefined,
      authoringState: undefined,
      includeRetired: false,
    });
  });

  it('only includes retired scripts when include_retired is exactly true', async () => {
    await get('http://localhost/api/pilot/session-scripts?include_retired=true');
    expect(mockList.mock.calls[0][1].includeRetired).toBe(true);

    // Anything else is not an opt-in. A truthy-string check here would make
    // `include_retired=false` surface retired plans as live ones.
    for (const raw of ['false', '1', 'yes', '']) {
      mockList.mockClear();
      await get(`http://localhost/api/pilot/session-scripts?include_retired=${raw}`);
      expect(mockList.mock.calls[0][1].includeRetired).toBe(false);
    }
  });

  it('returns one script with its blocks when script_id is given', async () => {
    mockDetail.mockResolvedValue({ script_id: 'scr-1', blocks: [{ block_id: 'blk-1' }], renderings: [] });

    const response = await get('http://localhost/api/pilot/session-scripts?script_id=scr-1');

    expect(mockDetail).toHaveBeenCalledWith('org-1', 'scr-1');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      script: { script_id: 'scr-1', blocks: [{ block_id: 'blk-1' }], renderings: [] },
    });
  });

  it('404s an unknown script rather than returning an empty envelope', async () => {
    const response = await get('http://localhost/api/pilot/session-scripts?script_id=nope');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'SESSION_SCRIPT_NOT_FOUND' });
  });

  it('does not fall through to the list when script_id is present but unknown', async () => {
    await get('http://localhost/api/pilot/session-scripts?script_id=nope');

    expect(mockList).not.toHaveBeenCalled();
  });

  it('surfaces an unauthenticated caller as an error, not an empty list', async () => {
    // The real requirePrincipal throws a plain Error('Unauthorized'); jsonError
    // maps it by message. Rejecting with any other shape here would prove only
    // that the fallback 500 branch works.
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await get('http://localhost/api/pilot/session-scripts');

    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });
});
