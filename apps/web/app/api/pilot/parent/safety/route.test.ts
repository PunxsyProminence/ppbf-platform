import { NextRequest } from 'next/server';

import { GET } from './route';
import { getAthleteById } from '@/src/server/pilot/entities';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getSubjectIdentity } from '@/src/server/pilot/profileDb';
import { getGuardianGateSummary } from '@/src/server/pilot/safetyGateMatrix';
import { getActiveTrainingHold } from '@/src/server/pilot/trainingHolds';
import { getAthleteWaiverStatus, TRACKED_WAIVER_TYPES } from '@/src/server/pilot/waiverCompliance';

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

// The db layer is not reachable from this route test, so the waiver read is
// mocked at the module boundary. TRACKED_WAIVER_TYPES is deliberately NOT
// mocked -- the real four-value list drives the assertions, so adding a fifth
// tracked type shows up here rather than silently going unreported to guardians.
jest.mock('@/src/server/pilot/waiverCompliance', () => {
  const actual = jest.requireActual('@/src/server/pilot/waiverCompliance');
  return { ...actual, getAthleteWaiverStatus: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGuardianAthleteIds = jest.mocked(guardianAthleteIds);
const mockGetAthleteById = jest.mocked(getAthleteById);
const mockGetActiveTrainingHold = jest.mocked(getActiveTrainingHold);
const mockGetGuardianGateSummary = jest.mocked(getGuardianGateSummary);
const mockGetSubjectIdentity = jest.mocked(getSubjectIdentity);
const mockGetAthleteWaiverStatus = jest.mocked(getAthleteWaiverStatus);

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
  mockGetAthleteWaiverStatus.mockResolvedValue('signed');
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
      // Asserted as part of the WHOLE item on purpose: this test is what
      // notices a field appearing in a guardian's payload that nobody meant to
      // put there. Adding the key here is the correct response to it failing;
      // loosening it to toMatchObject would not be.
      waivers: {
        general: 'signed',
        medical_release: 'signed',
        photo_media: 'signed',
        travel: 'signed',
      },
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


/* THE LOOP THIS ROUTE COULD NOT CLOSE.

   competitionSafetyGates GATE 3 refuses to enter a child in any competition
   unless their travel waiver reads 'signed'. Only the guardian can sign it,
   and before this no guardian-facing surface reported it: /parent/consent
   covers photo_media alone and /admin/waiver-status is organization-admin. */
test('reports every tracked waiver status, so a guardian can see what is outstanding', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1']);
  mockGetAthleteWaiverStatus.mockImplementation(async (_org, _athlete, waiverType) =>
    (waiverType === 'travel' ? 'missing' : 'signed'));

  const body = await (await get()).json();

  expect(body.items[0].waivers).toEqual({
    general: 'signed',
    medical_release: 'signed',
    photo_media: 'signed',
    travel: 'missing',
  });
});

test('asks for each tracked type against the guardian own organization and athlete', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1']);

  await get();

  for (const waiverType of TRACKED_WAIVER_TYPES) {
    expect(mockGetAthleteWaiverStatus).toHaveBeenCalledWith('org-a', 'ath-1', waiverType);
  }
  // Never the org-wide rollup: one child's question must not read every other
  // child's consent state.
  expect(mockGetAthleteWaiverStatus).toHaveBeenCalledTimes(TRACKED_WAIVER_TYPES.length);
});

test('a missing waiver reads as missing, never as absent from the response', async () => {
  // Absence of consent is a status, not silence. A key that vanishes when the
  // answer is 'no document' is the shape that lets a UI render nothing and a
  // guardian conclude everything is fine.
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1']);
  mockGetAthleteWaiverStatus.mockResolvedValue('missing');

  const body = await (await get()).json();

  for (const waiverType of TRACKED_WAIVER_TYPES) {
    expect(body.items[0].waivers[waiverType]).toBe('missing');
  }
});

test('discloses the status and nothing else about the document', async () => {
  // #793 removed pilot.waivers.notes from the guardian projection because a
  // staff note on the other parent's waiver reached this household. Nothing
  // here may put any of that back: no signer, no timestamp, no version, no
  // note.
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1']);

  const body = await (await get()).json();

  const serialized = JSON.stringify(body.items[0].waivers);
  for (const forbidden of ['notes', 'signed_by_name', 'signed_by_role', 'signed_at', 'consent_version', 'parent_id']) {
    expect(serialized).not.toContain(forbidden);
  }
  expect(Object.keys(body.items[0].waivers).sort()).toEqual([...TRACKED_WAIVER_TYPES].sort());
});

test('each linked child gets their own waiver answers', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1', 'ath-2']);
  mockGetAthleteWaiverStatus.mockImplementation(async (_org, athleteId, waiverType) =>
    (athleteId === 'ath-2' && waiverType === 'travel' ? 'declined' : 'signed'));

  const body = await (await get()).json();

  expect(body.items[0].waivers.travel).toBe('signed');
  expect(body.items[1].waivers.travel).toBe('declined');
});
