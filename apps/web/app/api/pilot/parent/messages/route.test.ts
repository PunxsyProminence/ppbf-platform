import { NextRequest } from 'next/server';

import { GET } from './route';
import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listParentMessages } from '@/src/server/pilot/intake';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
}));

jest.mock('@/src/server/pilot/entities', () => ({
  getAthleteById: jest.fn(),
}));

// Task state is a separate read on this route now. Mocked at the module
// boundary so these tests keep asserting the MESSAGE projection; the task
// half has its own coverage in parentTaskState.pg.test.ts against real
// Postgres, which is where a projection question about it belongs.
jest.mock('@/src/server/pilot/parentTasks', () => ({
  parentTaskStateForNotes: jest.fn(async () => new Map()),
  setParentTaskCompletion: jest.fn(),
}));

jest.mock('@/src/server/pilot/intake', () => ({
  listParentMessages: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGuardianAthleteIds = jest.mocked(guardianAthleteIds);
const mockGetAthleteById = jest.mocked(getAthleteById);
const mockListParentMessages = jest.mocked(listParentMessages);

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'parent-1',
    role: 'parent' as const,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    ...overrides,
  };
}

function get() {
  return GET(new NextRequest('http://localhost/api/pilot/parent/messages'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuardianAthleteIds.mockResolvedValue(['ath-1']);
  mockGetAthleteById.mockResolvedValue({ athlete_id: 'ath-1', full_name: 'Jordan T.' } as never);
  mockListParentMessages.mockResolvedValue([]);
});

test('returns messages scoped to the guardian\'s own children, with the athlete name attached', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListParentMessages.mockResolvedValueOnce([
    { note_id: 'note-1', athlete_id: 'ath-1', sender_role: 'coach', note_text: 'Great week!', created_at: '2026-08-07T00:00:00.000Z' },
  ]);

  const response = await get();

  expect(response.status).toBe(200);
  expect(mockGuardianAthleteIds).toHaveBeenCalledWith('org-1', 'parent-1');
  expect(mockListParentMessages).toHaveBeenCalledWith('org-1', ['ath-1']);
  const payload = await response.json();
  // The WHOLE item, deliberately: this assertion is what notices a field
  // appearing in a guardian's payload that nobody meant to put there. Adding
  // `task` here is the correct response to it failing; loosening it to
  // toMatchObject would not be. null because this message carries no task.
  expect(payload.items).toEqual([
    { note_id: 'note-1', athlete_id: 'ath-1', athlete_name: 'Jordan T.', sender_role: 'coach', note_text: 'Great week!', created_at: '2026-08-07T00:00:00.000Z', task: null },
  ]);
});

test('an athlete lookup miss falls back to a null name rather than throwing', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGetAthleteById.mockResolvedValueOnce(null);
  mockListParentMessages.mockResolvedValueOnce([
    { note_id: 'note-1', athlete_id: 'ath-1', sender_role: 'coach', note_text: 'Hi.', created_at: '2026-08-07T00:00:00.000Z' },
  ]);

  const response = await get();

  const payload = await response.json();
  expect(payload.items[0].athlete_name).toBeNull();
});

test.each(['coach', 'organization_admin', 'admin', 'athlete', 'board', 'platform_owner', 'volunteer', 'staff'] as const)(
  'denies the %s role -- this is a parent-only read',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, athleteId: role === 'athlete' ? 'athlete-1' : null }));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mockListParentMessages).not.toHaveBeenCalled();
  },
);

test('no children on the account returns an empty list, not an error', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce([]);

  const response = await get();

  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.items).toEqual([]);
});
