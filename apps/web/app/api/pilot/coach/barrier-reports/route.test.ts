import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { listAthletesWithBarrierReports, listBarrierReports } from '@/src/server/pilot/intake';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/intake', () => ({
  listAthletesWithBarrierReports: jest.fn(),
  listBarrierReports: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockListAthletes = jest.mocked(listAthletesWithBarrierReports);
const mockListReports = jest.mocked(listBarrierReports);

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'coach-1',
    role: 'coach' as const,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    ...overrides,
  } as never;
}

function barrierReport(athleteId: string) {
  return {
    note_id: `note-${athleteId}`,
    athlete_id: athleteId,
    athlete_name: 'Rosa Delgado',
    reporter_role: 'parent',
    note_type: 'transportation_barrier',
    note_text: 'We lost our ride on Tuesdays.',
    created_at: '2026-08-10T10:00:00.000Z',
  };
}

function request(url = 'http://localhost/api/pilot/coach/barrier-reports'): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertAccess.mockResolvedValue(undefined);
  mockListAthletes.mockResolvedValue([]);
  mockListReports.mockResolvedValue({ reports: [], truncated: false });
});

// The read side of ParentHub's "Sent to your child's coach". Until this
// route existed the rows were write-only, so these tests pin the whole
// promise: the right coach sees the report, the wrong coach cannot learn it
// exists, and a partial failure never reads as an empty inbox.
test('returns the named report for an athlete the coach is authorized for', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['ath-1']);
  mockListReports.mockResolvedValueOnce({ reports: [barrierReport('ath-1')], truncated: false });

  const response = await GET(request());

  expect(response.status).toBe(200);
  const payload = (await response.json()) as { barrierReports: Array<{ athlete_id: string; reporter_role: string }> };
  expect(payload.barrierReports).toHaveLength(1);
  expect(payload.barrierReports[0].athlete_id).toBe('ath-1');
  expect(payload.barrierReports[0].reporter_role).toBe('parent');
  expect(mockListReports).toHaveBeenCalledWith('org-1', ['ath-1'], 25);
});

test('drops an athlete access.ts refuses and never reveals the report exists', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['ath-mine', 'ath-not-mine']);
  mockAssertAccess.mockImplementation(async (_principal, athleteId) => {
    if (athleteId === 'ath-not-mine') {
      throw new Error('Forbidden: coach is not assigned to this athlete');
    }
  });
  mockListReports.mockResolvedValueOnce({ reports: [barrierReport('ath-mine')], truncated: false });

  const response = await GET(request());

  expect(response.status).toBe(200);
  expect(mockListReports).toHaveBeenCalledWith('org-1', ['ath-mine'], 25);
});

test('fails the read rather than shortening the list when an access check errors', async () => {
  // A silently shortened list of families asking for help is
  // indistinguishable from no families asking for help.
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['ath-1', 'ath-2']);
  mockAssertAccess.mockImplementation(async (_principal, athleteId) => {
    if (athleteId === 'ath-2') {
      throw new Error('connection reset');
    }
  });

  const response = await GET(request());

  expect(response.status).toBe(500);
  expect(mockListReports).not.toHaveBeenCalled();
});

test('reports truncation so a capped list is not read as the whole set', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['ath-1']);
  mockListReports.mockResolvedValueOnce({ reports: [barrierReport('ath-1')], truncated: true });

  const response = await GET(request());

  const payload = (await response.json()) as { truncated: boolean };
  expect(payload.truncated).toBe(true);
});

test.each(['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner'] as const)(
  '%s cannot read the barrier inbox',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockListAthletes).not.toHaveBeenCalled();
  },
);

test('rejects a malformed limit before reading anything', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await GET(request('http://localhost/api/pilot/coach/barrier-reports?limit=banana'));

  expect(response.status).toBe(400);
  expect(mockListAthletes).not.toHaveBeenCalled();
});

test('caps the requested limit', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['ath-1']);
  mockListReports.mockResolvedValueOnce({ reports: [], truncated: false });

  await GET(request('http://localhost/api/pilot/coach/barrier-reports?limit=5000'));

  expect(mockListReports).toHaveBeenCalledWith('org-1', ['ath-1'], 50);
});
