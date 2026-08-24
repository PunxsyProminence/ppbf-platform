import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  listAthletesWithRecentPainReports,
  listPainReportsForAthletes,
} from '@/src/server/pilot/formulas/painReportAlert';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import type { PainReporter } from '@/src/server/pilot/formulas/painReportAlert';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/formulas/painReportAlert', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/painReportAlert');
  return {
    ...actual,
    listAthletesWithRecentPainReports: jest.fn(),
    listPainReportsForAthletes: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockListAthletes = jest.mocked(listAthletesWithRecentPainReports);
const mockListReports = jest.mocked(listPainReportsForAthletes);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);

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

function painReport(athleteId: string, reporter: PainReporter = 'athlete') {
  return {
    nearMissId: `nm-${athleteId}`,
    athleteId,
    athleteName: 'Rosa Delgado',
    severity: 'critical' as const,
    painScore: 8,
    location: 'Left wrist',
    painType: 'Sharp',
    observedAt: '2026-07-31T10:00:00.000Z',
    recordedAt: '2026-07-31T10:00:02.000Z',
    reporter,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadiness.mockResolvedValue(undefined);
  mockAssertAccess.mockResolvedValue(undefined);
  mockListAthletes.mockResolvedValue([]);
  mockListReports.mockResolvedValue({ reports: [], truncated: false });
});

function get(url = 'http://localhost/api/pilot/coach/pain-reports') {
  return GET(new NextRequest(url));
}

test('returns the named report for an athlete the coach is authorized for', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['athlete-1']);
  mockListReports.mockResolvedValueOnce({ reports: [painReport('athlete-1')], truncated: false });

  const response = await get();

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const payload = await response.json();
  expect(payload.painReports).toHaveLength(1);
  expect(payload.painReports[0]).toEqual(expect.objectContaining({
    athleteName: 'Rosa Delgado',
    severity: 'critical',
    painScore: 8,
    location: 'Left wrist',
  }));
  expect(payload.windowDays).toBeGreaterThan(0);
});

// The negative control. An athlete this coach does not cover must not appear,
// and nothing in the response may hint that a report for them exists.
test('drops an athlete access.ts refuses and never reveals the report exists', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['athlete-mine', 'athlete-someone-elses']);
  mockAssertAccess.mockImplementation(async (_actor, athleteId) => {
    if (athleteId === 'athlete-someone-elses') {
      throw new Error('Forbidden: coach not assigned to athlete');
    }
  });
  mockListReports.mockResolvedValueOnce({ reports: [painReport('athlete-mine')], truncated: false });

  const response = await get();

  expect(response.status).toBe(200);
  expect(mockListReports).toHaveBeenCalledWith('org-1', ['athlete-mine'], expect.anything());
  const body = JSON.stringify(await response.json());
  expect(body).not.toContain('athlete-someone-elses');
});

test('does not query for reports when the coach is authorized for none of them', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['athlete-someone-elses']);
  mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

  const response = await get();

  expect(response.status).toBe(200);
  expect(mockListReports).toHaveBeenCalledWith('org-1', [], expect.anything());
  const payload = await response.json();
  expect(payload.painReports).toEqual([]);
});

// A database failure part-way through the authorization pass would otherwise
// shrink the list silently, which reads to a coach exactly like "no child
// reported pain".
test('fails the read rather than shortening the list when an access check errors', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['athlete-1', 'athlete-2']);
  mockAssertAccess.mockImplementation(async (_actor, athleteId) => {
    if (athleteId === 'athlete-2') {
      throw new Error('connection terminated unexpectedly');
    }
  });

  const response = await get();

  expect(response.status).toBe(500);
  expect(mockListReports).not.toHaveBeenCalled();
});

test('reports truncation so a capped list is not read as the whole set', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['athlete-1']);
  mockListReports.mockResolvedValueOnce({ reports: [painReport('athlete-1')], truncated: true });

  const payload = await (await get()).json();

  expect(payload.truncated).toBe(true);
});

test.each(['board', 'parent', 'athlete', 'platform_owner', 'volunteer', 'staff'] as const)(
  'denies the %s role before any athlete is resolved',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({
      role,
      athleteId: role === 'athlete' ? 'athlete-1' : null,
    }));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mockListAthletes).not.toHaveBeenCalled();
    expect(mockListReports).not.toHaveBeenCalled();
  },
);

test.each(['coach', 'organization_admin', 'admin'] as const)('allows the %s role', async (role) => {
  mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

  const response = await get();

  expect(response.status).toBe(200);
});

test('rejects a malformed limit before reading anything', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await get('http://localhost/api/pilot/coach/pain-reports?limit=-1');

  expect(response.status).toBe(400);
  expect(mockListAthletes).not.toHaveBeenCalled();
});

test('caps the requested limit', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockListAthletes.mockResolvedValueOnce(['athlete-1']);

  await get('http://localhost/api/pilot/coach/pain-reports?limit=5000');

  expect(mockListReports).toHaveBeenCalledWith(
    'org-1',
    ['athlete-1'],
    expect.objectContaining({ limit: 50 }),
  );
});
