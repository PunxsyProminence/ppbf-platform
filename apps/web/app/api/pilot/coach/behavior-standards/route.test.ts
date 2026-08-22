import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createStandard,
  raiseConductConcern,
  recognizeStandardMet,
  retireStandard,
} from '@/src/server/pilot/behaviorStandards';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/achievements', () => ({
  getCoachDisplayName: jest.fn().mockResolvedValue('Coach A'),
}));

jest.mock('@/src/server/pilot/behaviorStandards', () => {
  const actual = jest.requireActual('@/src/server/pilot/behaviorStandards');
  return {
    isRecognitionKind: actual.isRecognitionKind,
    listStandards: jest.fn().mockResolvedValue([]),
    createStandard: jest.fn(),
    retireStandard: jest.fn(),
    recognizeStandardMet: jest.fn(),
    raiseConductConcern: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockCreate = createStandard as jest.Mock;
const mockRetire = retireStandard as jest.Mock;
const mockRecognize = recognizeStandardMet as jest.Mock;
const mockConcern = raiseConductConcern as jest.Mock;

// The athlete gate is permissive by default so each test states its own
// access decision rather than inheriting the previous test's --
// clearAllMocks clears calls, not implementations.
beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
});

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
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const post = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/coach/behavior-standards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('athletes and parents cannot see or touch standards at all', async () => {
  for (const role of ['athlete', 'parent'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(new NextRequest('http://localhost/api/pilot/coach/behavior-standards'))).status)
      .toBeGreaterThanOrEqual(400);
    expect((await POST(post({ action: 'recognize', standard_id: 's1', athlete_id: 'a1' }))).status)
      .toBeGreaterThanOrEqual(400);
  }
  expect(mockRecognize).not.toHaveBeenCalled();
});

test('posting and retiring a standard is admin-only; a coach cannot declare what the gym expects', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));

  expect((await POST(post({
    action: 'post_standard', standard_name: 'Reset after frustration', recognition_kind: 'took_the_correction',
  }))).status).toBeGreaterThanOrEqual(400);
  expect((await POST(post({ action: 'retire_standard', standard_id: 's1' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockRetire).not.toHaveBeenCalled();

  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
  mockCreate.mockResolvedValue({ standard_id: 's1', recognition_kind: 'took_the_correction' });
  expect((await POST(post({
    action: 'post_standard', standard_name: 'Reset after frustration', recognition_kind: 'took_the_correction',
  }))).status).toBe(200);
});

test('a standard must map onto an existing recognition, not invent a new one', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));

  const response = await POST(post({
    action: 'post_standard', standard_name: 'Be excellent', recognition_kind: 'be_excellent',
  }));
  expect(response.status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a coach recognizes a standard met, and the coach name is resolved server-side', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  // a1 is this coach's athlete -- the gate grants. Its refusal has its own test.
  mockAccess.mockResolvedValue(undefined);
  mockRecognize.mockResolvedValue({ recognition_id: 'rec-1' });

  const response = await POST(post({
    action: 'recognize', standard_id: 's1', athlete_id: 'a1', note: 'walked away, came back',
  }));

  expect(response.status).toBe(200);
  expect(mockRecognize).toHaveBeenCalledWith(expect.objectContaining({
    standardId: 's1', athleteId: 'a1', coachDisplayName: 'Coach A',
  }));
});

test('a concern needs a reason and a stated severity, and goes to the safeguarding ladder', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  // a1 is this coach's athlete -- the gate grants, so what is under test here
  // is the shape of the concern, not who may file it.
  mockAccess.mockResolvedValue(undefined);

  // No reason -- refused. A concern about a child that says nothing cannot be handled.
  expect((await POST(post({ action: 'raise_concern', athlete_id: 'a1', severity: 'moderate' }))).status).toBe(400);
  // No severity, or an invented one -- refused.
  expect((await POST(post({ action: 'raise_concern', athlete_id: 'a1', reason: 'x' }))).status).toBe(400);
  expect((await POST(post({
    action: 'raise_concern', athlete_id: 'a1', reason: 'x', severity: 'catastrophic',
  }))).status).toBe(400);
  expect(mockConcern).not.toHaveBeenCalled();

  mockConcern.mockResolvedValue({ escalation_id: 'esc-1' });
  const response = await POST(post({
    action: 'raise_concern', athlete_id: 'a1', reason: 'ignored a stop instruction', severity: 'moderate',
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ item: { escalation_id: 'esc-1' } });
  expect(mockConcern).toHaveBeenCalledWith(expect.objectContaining({
    reason: 'ignored a stop instruction', severity: 'moderate', raisedByRole: 'coach',
  }));
});

test('an unknown action is refused rather than silently ignored', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
  expect((await POST(post({ action: 'log_behavior', athlete_id: 'a1' }))).status).toBe(400);
});

test('a coach with no relationship to the child cannot file a conduct concern about them', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const response = await POST(post({
    action: 'raise_concern', athlete_id: 'a-not-mine',
    reason: 'made it up', severity: 'critical',
  }));

  expect(response.status).toBe(403);
  // Nothing reaches the safeguarding ladder: no escalation, no audit trail
  // naming this child.
  expect(mockConcern).not.toHaveBeenCalled();
});

test('the same gate covers recognition -- a coach cannot record against a child who is not theirs', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const response = await POST(post({ action: 'recognize', standard_id: 's1', athlete_id: 'a-not-mine' }));

  expect(response.status).toBe(403);
  expect(mockRecognize).not.toHaveBeenCalled();
});

test('an organization admin keeps organization-wide reach -- the route defers to the central contract', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  // Which athletes an org admin may reach is assertActorCanAccessAthlete's
  // decision (access.test.ts: 'allows organization_admin when athlete belongs
  // to their organization'); this route adds no narrower rule of its own.
  mockAccess.mockResolvedValue(undefined);
  mockConcern.mockResolvedValue({ escalation_id: 'esc-2' });

  const response = await POST(post({
    action: 'raise_concern', athlete_id: 'a-nobody-coaches',
    reason: 'left the floor without telling anyone', severity: 'moderate',
  }));

  expect(response.status).toBe(200);
  expect(mockAccess).toHaveBeenCalledWith(
    expect.objectContaining({ role: 'organization_admin', organizationId: 'org-1' }),
    'a-nobody-coaches',
  );
});
