import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { createBehaviourKey, listBehaviourKeys } from '@/src/server/pilot/behaviourObservations';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/behaviourObservations', () => {
  const actual = jest.requireActual('@/src/server/pilot/behaviourObservations');
  return { ...actual, listBehaviourKeys: jest.fn().mockResolvedValue([]), createBehaviourKey: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listBehaviourKeys as jest.Mock;
const mockCreate = createBehaviourKey as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const URL_BASE = 'http://localhost/api/pilot/coach/behaviour-keys';
const postRequest = (body: Record<string, unknown>) =>
  new NextRequest(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('only staff read or grow the list', async () => {
  for (const role of ['athlete', 'parent', 'board', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(new NextRequest(URL_BASE))).status).toBe(403);
    expect((await POST(postRequest({ label: 'K one', skillId: 'SK-JAB-01' }))).status).toBe(403);
  }
  expect(mockList).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

test("a coach reads the gym's list and adds a name to it as themself", async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-3' }));
  mockList.mockResolvedValue([{ behaviour_key: 'k_one' }]);
  const listed = await GET(new NextRequest(URL_BASE));
  expect(await listed.json()).toEqual({ ok: true, keys: [{ behaviour_key: 'k_one' }] });
  expect(mockList).toHaveBeenCalledWith('org-1');

  mockCreate.mockResolvedValue({ behaviour_key: 'k_two' });
  // A key the caller sends is ignored: the server mints it.
  const created = await POST(postRequest({ behaviourKey: 'rosas_low_guard', label: 'K two', skillId: 'SK-JAB-01' }));
  expect(created.status).toBe(201);
  expect(mockCreate).toHaveBeenCalledWith({
    organizationId: 'org-1', label: 'K two', skillId: 'SK-JAB-01', createdByAccountId: 'acct-3',
  });
  expect((await POST(postRequest({ label: 'No skill' }))).status).toBe(400);
});
