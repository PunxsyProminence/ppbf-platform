import { NextRequest } from 'next/server';

import { GET } from './route';
import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getSubjectIdentity } from '@/src/server/pilot/profileDb';
import { getGuardianGateSummary } from '@/src/server/pilot/safetyGateMatrix';
import { getActiveTrainingHold } from '@/src/server/pilot/trainingHolds';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthleteById: jest.fn(),
}));

jest.mock('@/src/server/pilot/guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
}));

jest.mock('@/src/server/pilot/profileDb', () => ({
  getSubjectIdentity: jest.fn(),
}));

jest.mock('@/src/server/pilot/safetyGateMatrix', () => ({
  getGuardianGateSummary: jest.fn(),
}));

jest.mock('@/src/server/pilot/trainingHolds', () => ({
  getActiveTrainingHold: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGuardianAthleteIds = jest.mocked(guardianAthleteIds);
const mockGetAthleteById = jest.mocked(getAthleteById);
const mockGetActiveTrainingHold = jest.mocked(getActiveTrainingHold);
const mockGetGuardianGateSummary = jest.mocked(getGuardianGateSummary);
const mockGetSubjectIdentity = jest.mocked(getSubjectIdentity);

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-parent',
    role: 'parent' as const,
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    ...overrides,
  };
}

function get(): Promise<Response> {
  return GET(new NextRequest('http://localhost/api/pilot/parent/safety'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAthleteById.mockResolvedValue({ athlete_id: 'ath-1', full_name: 'Jordan T.' } as never);
  mockGetActiveTrainingHold.mockResolvedValue(null);
  mockGetGuardianGateSummary.mockResolvedValue([]);
  mockGetSubjectIdentity.mockResolvedValue({
    accountId: 'acct-coach',
    fullName: 'Coach Neale',
    athleteId: null,
    dob: null,
    coachAccountId: null,
    memberSince: '2026-01-01T00:00:00Z',
  });
});

test('returns hold and gate status for every linked athlete', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1']);
  mockGetActiveTrainingHold.mockResolvedValueOnce({
    hold_id: 'hold-1',
    athlete_id: 'ath-1',
    scope: 'all_training',
    reason_category: 'medical',
    reason_text: 'Staff-only detail that must never reach this response.',
    athlete_explanation: 'You need a doctor note before training resumes.',
    lift_condition_text: 'Bring a signed clearance note.',
    placed_by_account_id: 'acct-coach',
    placed_by_role: 'coach',
    placed_at: '2026-08-01T00:00:00.000Z',
    expires_at: null,
    lifted_by_account_id: null,
    lifted_at: null,
    lift_note: '',
    status: 'active',
  } as never);
  mockGetGuardianGateSummary.mockResolvedValueOnce([
    { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'flagged', evaluated_at: '2026-08-01T00:00:00.000Z' },
  ]);

  const response = await get();

  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.items).toEqual([
    {
      athlete_id: 'ath-1',
      athlete_name: 'Jordan T.',
      hold: {
        scope: 'all_training',
        athlete_explanation: 'You need a doctor note before training resumes.',
        lift_condition_text: 'Bring a signed clearance note.',
        placed_at: '2026-08-01T00:00:00.000Z',
        expires_at: null,
        placed_by_name: 'Coach Neale',
      },
      gates: [
        { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'flagged', evaluated_at: '2026-08-01T00:00:00.000Z' },
      ],
    },
  ]);
});

// The whole reason a locally-defined projection exists in this route rather
// than returning the hold row directly.
test('never leaks reason_text or reason_category from the hold row', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1']);
  mockGetActiveTrainingHold.mockResolvedValueOnce({
    hold_id: 'hold-1',
    athlete_id: 'ath-1',
    scope: 'all_training',
    reason_category: 'behavioral',
    reason_text: 'STAFF-ONLY-SECRET-REASON',
    athlete_explanation: 'Safe explanation.',
    lift_condition_text: '',
    placed_by_account_id: 'acct-coach',
    placed_by_role: 'coach',
    placed_at: '2026-08-01T00:00:00.000Z',
    expires_at: null,
    lifted_by_account_id: null,
    lifted_at: null,
    lift_note: '',
    status: 'active',
  } as never);

  const response = await get();
  const body = JSON.stringify(await response.json());

  expect(body).not.toContain('STAFF-ONLY-SECRET-REASON');
  expect(body).not.toContain('behavioral');
});

test('no active hold reads as hold: null, not omitted', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1']);

  const response = await get();
  const payload = await response.json();

  expect(payload.items[0].hold).toBeNull();
});

test('an account backing zero linked athletes gets an empty list, not an error', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce([]);

  const response = await get();
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.items).toEqual([]);
  expect(mockGetActiveTrainingHold).not.toHaveBeenCalled();
});

test.each(['coach', 'admin', 'organization_admin', 'athlete', 'board', 'platform_owner', 'volunteer'] as const)(
  'denies the %s role',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, athleteId: role === 'athlete' ? 'ath-1' : null }));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mockGuardianAthleteIds).not.toHaveBeenCalled();
  },
);
