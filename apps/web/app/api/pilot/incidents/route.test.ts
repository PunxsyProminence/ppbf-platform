import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { fileIncidentReport } from '@/src/server/pilot/escalationLadder';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/escalationLadder', () => ({
  fileIncidentReport: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockFileIncidentReport = jest.mocked(fileIncidentReport);

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'coach-1',
    role: 'coach' as const,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    ...overrides,
  };
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/incidents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertAccess.mockResolvedValue(undefined);
  mockFileIncidentReport.mockResolvedValue({
    escalation_id: 'esc-1',
    source_type: 'incident',
    source_id: null,
    athlete_id: 'athlete-1',
    severity: 'high',
    reason: 'Sprained an ankle.',
    escalated_to_role: 'organization_admin',
    triggered_by: 'human',
    triggered_by_account_id: 'coach-1',
    triggered_by_role: 'coach',
    status: 'open',
    acknowledged_by_account_id: null,
    acknowledged_at: null,
    resolved_by_account_id: null,
    resolved_at: null,
    resolution_note: '',
    metadata: {},
    created_at: '2026-08-07T00:00:00.000Z',
    updated_at: '2026-08-07T00:00:00.000Z',
  } as never);
});

test('a coach can file an incident report for an athlete they are authorized for', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ athleteId: 'athlete-1', description: 'Sprained an ankle.', severity: 'high' });

  expect(response.status).toBe(200);
  expect(mockAssertAccess).toHaveBeenCalledWith(expect.anything(), 'athlete-1');
  expect(mockFileIncidentReport).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      severity: 'high',
      reason: 'Sprained an ankle.',
      reportedByAccountId: 'coach-1',
      reportedByRole: 'coach',
      occurredAt: null,
    }),
  );
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  expect(payload.escalation.source_type).toBe('incident');
});

test('occurredAt is passed through when provided', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  await post({ athleteId: 'athlete-1', description: 'Late report.', severity: 'critical', occurredAt: '2026-08-05' });

  expect(mockFileIncidentReport).toHaveBeenCalledWith(
    expect.objectContaining({ occurredAt: '2026-08-05' }),
  );
});

test.each(['low', 'moderate'])('severity %s is refused -- an incident is never less than high', async (severity) => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ athleteId: 'athlete-1', description: 'Something happened.', severity });

  expect(response.status).toBe(400);
  expect(mockFileIncidentReport).not.toHaveBeenCalled();
});

test('missing description is a 400', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ athleteId: 'athlete-1', severity: 'high' });

  expect(response.status).toBe(400);
  expect(mockFileIncidentReport).not.toHaveBeenCalled();
});

test('missing athleteId is a 400, and the athlete-access check never runs', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ description: 'Something happened.', severity: 'high' });

  expect(response.status).toBe(400);
  expect(mockAssertAccess).not.toHaveBeenCalled();
});

test('an athlete outside the coach\'s access is refused before filing', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

  const response = await post({ athleteId: 'athlete-not-mine', description: 'Something happened.', severity: 'high' });

  expect(response.status).toBe(403);
  expect(mockFileIncidentReport).not.toHaveBeenCalled();
});

test.each(['board', 'parent', 'athlete', 'platform_owner', 'volunteer', 'staff'] as const)(
  'denies the %s role',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, athleteId: role === 'athlete' ? 'athlete-1' : null }));

    const response = await post({ athleteId: 'athlete-1', description: 'Something happened.', severity: 'high' });

    expect(response.status).toBe(403);
    expect(mockFileIncidentReport).not.toHaveBeenCalled();
  },
);

test.each(['coach', 'organization_admin', 'admin'] as const)('allows the %s role', async (role) => {
  mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

  const response = await post({ athleteId: 'athlete-1', description: 'Something happened.', severity: 'high' });

  expect(response.status).toBe(200);
});

test('a non-string severity is refused, never coerced', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await post({ athleteId: 'athlete-1', description: 'Something happened.', severity: 3 });

  expect(response.status).toBe(400);
  expect(mockFileIncidentReport).not.toHaveBeenCalled();
});

test('a malformed JSON body is a 400, not a 500', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  const malformed = new NextRequest('http://localhost/api/pilot/incidents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });

  const response = await POST(malformed);

  expect(response.status).toBe(400);
});
