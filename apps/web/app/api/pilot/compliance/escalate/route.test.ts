import { NextRequest } from 'next/server';

import { POST } from './route';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  // The escalation and the violation's status change have to commit together,
  // so both statements run on a transaction client rather than the module's
  // query(). The fake hands the callback a client whose query() is the same
  // spy, keeping the call assertions below meaningful.
  withTransaction: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;

beforeEach(() => {
  // A transaction client returns the pg Result shape ({ rows }), unlike the
  // module's query() which returns the rows array directly.
  mockWithTransaction.mockImplementation(
    (work: (client: { query: jest.Mock }) => Promise<unknown>) => work({
      query: jest.fn(async (...args: unknown[]) => ({ rows: (await mockQuery(...args)) ?? [] })) as jest.Mock,
    }),
  );
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/compliance/escalate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pilot/compliance/escalate', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await POST(postRequest({ violation_id: 'v1', escalated_to_role: 'board' }));
    expect(res.status).toBe(401);
  });

  test('403 for a role that cannot escalate', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    const res = await POST(postRequest({ violation_id: 'v1', escalated_to_role: 'board' }));
    expect(res.status).toBe(403);
  });

  test('400 when required fields are missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await POST(postRequest({ violation_id: 'v1' }));
    expect(res.status).toBe(400);
  });

  test('cross-organization violation_id returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ violation_id: 'v-other-org', escalated_to_role: 'board' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('escalates a violation that belongs to this organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce({ violation_id: 'v1', athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await POST(postRequest({ violation_id: 'v1', escalated_to_role: 'board' }));
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('organization_id = $2'),
      expect.arrayContaining(['v1', 'org-1']),
    );
  });
});
