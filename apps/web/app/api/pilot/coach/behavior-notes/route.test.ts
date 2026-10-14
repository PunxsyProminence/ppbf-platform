import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { listBehaviourNotes } from '@/src/server/pilot/behaviourNotes';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/behaviourNotes', () => ({
  listBehaviourNotes: jest.fn().mockResolvedValue([]),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listBehaviourNotes as jest.Mock;

function principal(role: string): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'ath-1' : undefined,
  } as unknown as PilotPrincipal;
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/coach/behavior-notes${query}`);
}

beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
  mockList.mockResolvedValue([{ note_id: 'n1', athlete_id: 'ath-1', note_text: 'x' }]);
});

afterEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockRestore();
});

test.each(['coach', 'organization_admin', 'admin'])('a %s reads the notes of their own gym', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect((await response.json()).items).toHaveLength(1);
  expect(mockList).toHaveBeenCalledWith('org-1', { athleteId: undefined });
});

test.each(['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner'])(
  'a %s gets no note and no query runs',
  async (role) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(request());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).not.toContain('note_text');
    expect(mockList).not.toHaveBeenCalled();
  },
);

test('naming an athlete goes through the usual reach check first', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  mockAccess.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const response = await GET(request('?athlete_id=ath-9'));
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockList).not.toHaveBeenCalled();

  mockAccess.mockResolvedValueOnce(undefined);
  await GET(request('?athlete_id=ath-9'));
  expect(mockList).toHaveBeenCalledWith('org-1', { athleteId: 'ath-9' });
});
