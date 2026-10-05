import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest(query_: string) {
  return new NextRequest(`http://localhost/api/pilot/progression/gaps?${query_}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/progression/gaps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/pilot/progression/gaps', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(401);
  });

  test('403 when athlete requests another athlete_id (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('athlete can read their own gaps', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // live athlete row (assertActorCanAccessAthlete)
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });

  test('403 when organization_admin requests an athlete from another organization (cross-organization)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await GET(getRequest('athlete_id=ath-other-org'));
    expect(res.status).toBe(403);
  });

  test('linked parent can read gaps for their athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // guardian link found
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });

  test('unlinked parent is denied', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce(null); // no guardian link
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/pilot/progression/gaps: who reads which words for a load jump', () => {
  const COACH_TEXT = 'Training load jumped: 2400 over the last 7 days against a usual week of 1000 (2.4x, averaged over 4 of the 4 weeks before; session RPE x minutes, unvalidated). Worth a look.';
  const FAMILY_TEXT = 'Your training this week was about 2.4 times your usual week. Your coach is keeping an eye on it.';
  const rows = () => [
    {
      gap_id: 'gap-load', athlete_id: 'ath-1', gap_type: 'endurance', gap_description: COACH_TEXT,
      severity: 'medium', status: 'identified', created_at: '2026-10-05T12:00:00.000Z',
      detected_from: 'deterministic_rule:load_jumped',
      detection_data: { acute_load: 2400, usual_weekly_load: 1000, ratio: 2.4, ratio_shown: '2.4', prior_weeks_with_load: 4 },
    },
    {
      gap_id: 'gap-manual', athlete_id: 'ath-1', gap_type: 'technique', gap_description: 'Drops lead hand',
      severity: 'medium', status: 'identified', created_at: '2026-10-05T11:00:00.000Z',
      detected_from: 'coach_observation', detection_data: {},
    },
  ];

  async function read(p: PilotPrincipal) {
    mockRequirePrincipal.mockResolvedValueOnce(p);
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce(rows());
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(200);
    return (await res.json()).items as Record<string, unknown>[];
  }

  test.each([
    ['athlete', principal({ role: 'athlete', athleteId: 'ath-1' })],
    ['parent', principal({ role: 'parent', athleteId: null })],
  ])('the %s reads the plain sentence; other gaps are unchanged', async (_role, p) => {
    const items = await read(p);
    expect(items.map((i) => i.gap_description)).toEqual([FAMILY_TEXT, 'Drops lead hand']);
  });

  test.each([
    ['coach', principal({ role: 'coach', athleteId: null })],
    ['organization_admin', principal({ role: 'organization_admin', athleteId: null })],
  ])('the %s keeps the stored coach text', async (_role, p) => {
    const items = await read(p);
    expect(items.map((i) => i.gap_description)).toEqual([COACH_TEXT, 'Drops lead hand']);
  });

  test('the read selects detected_from and detection_data, which the wording needs', async () => {
    await read(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('from pilot.progression_gaps');
    expect(sql).toMatch(/\bdetected_from\b/);
    expect(sql).toMatch(/\bdetection_data\b/);
  });

  test.each([
    ['athlete', principal({ role: 'athlete', athleteId: 'ath-1' })],
    ['coach', principal({ role: 'coach', athleteId: null })],
  ])('detection fields are never sent (%s)', async (_role, p) => {
    const items = await read(p);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ['athlete_id', 'created_at', 'gap_description', 'gap_id', 'gap_type', 'severity', 'status'],
      );
    }
  });
});

describe('POST /api/pilot/progression/gaps', () => {
  test('parent cannot create a gap (writes remain denied)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_type: 'technique', gap_description: 'x' }),
    );
    expect(res.status).toBe(403);
  });

  test('403 when coach creates a gap for an unassigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(
      postRequest({ athlete_id: 'ath-other', gap_type: 'technique', gap_description: 'x' }),
    );
    expect(res.status).toBe(403);
  });

  test('201 when coach creates a gap for an assigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ gap_id: 'gap-1' }]);
    const res = await POST(
      postRequest({ athlete_id: 'ath-1', gap_type: 'technique', gap_description: 'x' }),
    );
    expect(res.status).toBe(201);
  });
});
