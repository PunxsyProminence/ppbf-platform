import { NextRequest } from 'next/server';

import { POST } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  };
}

function postRequest(plan: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/floor-plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
}

const GENERATED_AT_PARAM = 3;

describe('POST /api/pilot/floor-plans', () => {
  test('an unparseable generatedAt falls back to now instead of reaching timestamptz', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQuery.mockResolvedValueOnce([]);

    const res = await POST(postRequest({ generatedAt: 'whenever', tasks: [] }));

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(Number.isNaN(new Date(params[GENERATED_AT_PARAM] as string).getTime())).toBe(false);
  });

  test('a valid generatedAt is preserved', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQuery.mockResolvedValueOnce([]);

    const res = await POST(postRequest({ generatedAt: '2026-07-30T12:00:00.000Z', tasks: [] }));

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[GENERATED_AT_PARAM]).toBe('2026-07-30T12:00:00.000Z');
  });

  test('400 for a plan larger than the stored-payload ceiling', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(postRequest({ generatedAt: '2026-07-30T12:00:00.000Z', notes: 'x'.repeat(200_000) }));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
