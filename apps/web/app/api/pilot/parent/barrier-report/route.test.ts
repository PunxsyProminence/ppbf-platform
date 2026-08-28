import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { createCoachObservation } from '@/src/server/pilot/intake';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/intake', () => ({
  createCoachObservation: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockCreateCoachObservation = jest.mocked(createCoachObservation);

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

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/parent/barrier-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertAccess.mockResolvedValue(undefined);
  mockCreateCoachObservation.mockResolvedValue('note-1');
});

test('a parent can file a home barrier report for their own child', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ athleteId: 'athlete-1', barrierType: 'home', description: 'No ride most weeknights.' });

  expect(response.status).toBe(200);
  expect(mockAssertAccess).toHaveBeenCalledWith(expect.anything(), 'athlete-1');
  expect(mockCreateCoachObservation).toHaveBeenCalledWith({
    // authorRole pins that a guardian's report is RECORDED as parent-authored
    // at write time. Before this field the role was re-derived from the
    // account on every read, so a guardian who later became a coach had this
    // report start reading as a coach's observation of a family.
    authorRole: 'parent',
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    coachAccountId: 'parent-1',
    noteType: 'home_barrier',
    noteText: 'No ride most weeknights.',
  });
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  expect(payload.note_id).toBe('note-1');
});

test('barrierType transportation maps to note_type transportation_barrier', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  await post({ athleteId: 'athlete-1', barrierType: 'transportation', description: 'Car broke down.' });

  expect(mockCreateCoachObservation).toHaveBeenCalledWith(
    expect.objectContaining({ noteType: 'transportation_barrier' }),
  );
});

test.each(['work', 'other', '', 3])('an invalid barrierType %s is refused, not coerced', async (barrierType) => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ athleteId: 'athlete-1', barrierType, description: 'Something.' });

  expect(response.status).toBe(400);
  expect(mockCreateCoachObservation).not.toHaveBeenCalled();
});

test('missing description is a 400', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ athleteId: 'athlete-1', barrierType: 'home' });

  expect(response.status).toBe(400);
  expect(mockCreateCoachObservation).not.toHaveBeenCalled();
});

test('missing athleteId is a 400, and the athlete-access check never runs', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ barrierType: 'home', description: 'Something.' });

  expect(response.status).toBe(400);
  expect(mockAssertAccess).not.toHaveBeenCalled();
});

test('a child outside this guardian\'s access is refused before writing', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: guardian not linked to athlete'));

  const response = await post({ athleteId: 'athlete-not-mine', barrierType: 'home', description: 'Something.' });

  expect(response.status).toBe(403);
  expect(mockCreateCoachObservation).not.toHaveBeenCalled();
});

test.each(['coach', 'organization_admin', 'admin', 'athlete', 'board', 'platform_owner', 'volunteer', 'staff'] as const)(
  'denies the %s role -- this is a parent-only write path',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, athleteId: role === 'athlete' ? 'athlete-1' : null }));

    const response = await post({ athleteId: 'athlete-1', barrierType: 'home', description: 'Something.' });

    expect(response.status).toBe(403);
    expect(mockCreateCoachObservation).not.toHaveBeenCalled();
  },
);

test('a malformed JSON body is a 400, not a 500', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  const malformed = new NextRequest('http://localhost/api/pilot/parent/barrier-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });

  const response = await POST(malformed);

  expect(response.status).toBe(400);
});
