import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest(query_?: string) {
  return new NextRequest(`http://localhost/api/pilot/publications/library${query_ ? `?${query_}` : ''}`);
}

// Math.min(parseInt(...) || 20, 100) never rejected a negative limit --
// `-5 || 20` stays -5 since a negative number is truthy, and Math.min only
// clamps the UPPER bound -- so it reached Postgres and crashed with an
// unhandled "LIMIT must not be negative", masked as a generic 500.
describe('GET /api/pilot/publications/library', () => {
  test('a negative limit is rejected with 400, never reaches the database', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await GET(getRequest('limit=-5'));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a non-numeric limit is rejected with 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await GET(getRequest('limit=abc'));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a valid limit still lists the library', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQuery.mockResolvedValueOnce([{ library_id: 'lib-1', title: 'Session review', tags: [] }]);

    const res = await GET(getRequest('limit=10'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ library_id: 'lib-1', title: 'Session review', tags: [] }] });
  });

  test('an unset limit falls back to the default of 20', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQuery.mockResolvedValueOnce([]);

    const res = await GET(getRequest());

    expect(res.status).toBe(200);
  });
});
