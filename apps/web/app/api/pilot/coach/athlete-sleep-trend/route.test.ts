import { NextRequest } from 'next/server';

import * as routeModule from './route';
import { GET, SLEEP_TREND_LIMIT } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * Map item 20 -- a coach or admin in the athlete's own organization reads that
 * athlete's recent sleep hours. requirePrincipal and the database are faked;
 * the route, access.ts and the athleteCheckIns.ts reader are real. The fake
 * filters on deleted_at and organization_id only when the SQL carries them,
 * so dropping either predicate from the shipped gate turns the refusals red.
 */

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

const athletes = [
  { organization_id: 'org-1', athlete_id: 'ath-marisol', deleted_at: null as string | null },
  { organization_id: 'org-1', athlete_id: 'ath-deleted', deleted_at: '2026-09-01T00:00:00Z' },
];

/** Full stored rows: the route must pass on only the day and the hours. */
const rows = [
  { organization_id: 'org-1', athlete_id: 'ath-marisol', check_in_id: 'c2', checked_in_on: '2026-09-22', sleep_hours: 7.5, energy: 4, note: 'private note' },
  { organization_id: 'org-1', athlete_id: 'ath-marisol', check_in_id: 'c1', checked_in_on: '2026-09-21', sleep_hours: null, energy: 2, note: '' },
  { organization_id: 'org-1', athlete_id: 'ath-deleted', check_in_id: 'c9', checked_in_on: '2026-09-22', sleep_hours: 3, energy: 1, note: 'deleted athlete note' },
];

let statements: string[];
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  statements = [];
  mockQueryOne.mockImplementation(async (sql: string, params: string[]) => {
    const text = normalize(sql);
    statements.push(text);
    // OD-2026-10-05-024 ruling 2: a coach passes assertActorCanAccessAthlete.
    // No coverage grants are modelled here; the assignment rule itself is
    // proven in ../assignedCoachReads.test.ts.
    if (text.includes('from pilot.coach_coverage')) return null;
    if (!text.includes('from pilot.athletes')) throw new Error(`unexpected SQL: ${text}`);
    if (text.includes('coach_id = $2') && params[1] !== 'coach-1') return null;
    const orgPredicate = /organization_id = \$(\d+)/.exec(text);
    const organizationId = orgPredicate ? params[Number(orgPredicate[1]) - 1] : null;
    const liveOnly = text.includes('deleted_at is null');
    const hit = athletes.find((row) => row.athlete_id === params[0]
      && (organizationId === null || row.organization_id === organizationId)
      && (!liveOnly || row.deleted_at === null));
    return hit ? { athlete_id: hit.athlete_id } : null;
  });
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push(text);
    if (!text.includes('from pilot.athlete_check_ins')) throw new Error(`unexpected list SQL: ${text}`);
    const [organizationId, athleteId, limit] = params as [string, string, number];
    return rows.filter((row) => row.organization_id === organizationId && row.athlete_id === athleteId).slice(0, limit);
  });
});

afterEach(() => jest.clearAllMocks());

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null,
    sessionToken: 'token', authProvider: 'microsoft', ...overrides,
  } as PilotPrincipal;
}

async function readAs(caller: Partial<PilotPrincipal>, qs = 'athlete_id=ath-marisol') {
  mockRequirePrincipal.mockResolvedValue(principal(caller));
  const response = await GET(new NextRequest(`http://localhost/api/pilot/coach/athlete-sleep-trend?${qs}`));
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

const checkInReads = () => statements.filter((sql) => sql.includes('pilot.athlete_check_ins'));

test('a coach and an admin read the day and hours only, newest first, skipped stays null', async () => {
  for (const role of ['coach', 'organization_admin', 'admin'] as const) {
    const { status, payload } = await readAs({ role });
    expect({ role, status }).toEqual({ role, status: 200 });
    expect(payload).toEqual({
      items: [
        { checked_in_on: '2026-09-22', sleep_hours: 7.5 },
        { checked_in_on: '2026-09-21', sleep_hours: null },
      ],
    });
  }
  expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'ath-marisol', SLEEP_TREND_LIMIT]);
});

test('nothing derived and no other measure rides along', async () => {
  const { payload } = await readAs({});
  expect(Object.keys(payload)).toEqual(['items']);
  expect(JSON.stringify(payload)).not.toMatch(/average|score|band|GREEN|RED|private note|energy/i);
});

test('athlete, parent, platform_owner and board are refused before any read', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner', 'board'] as const) {
    statements = [];
    const { status } = await readAs({ role, athleteId: 'ath-marisol' });
    expect({ role, status }).toEqual({ role, status: 403 });
    expect(statements).toEqual([]);
  }
});

test('another gym and a soft-deleted athlete are refused alike, with no check-in read', async () => {
  const crossOrg = await readAs({ organizationId: 'org-2' }, 'athlete_id=ath-marisol&organization_id=org-1');
  const deleted = await readAs({}, 'athlete_id=ath-deleted');
  const nobody = await readAs({}, 'athlete_id=ath-nobody');

  expect([crossOrg.status, deleted.status, nobody.status]).toEqual([403, 403, 403]);
  expect(deleted.payload).toEqual(nobody.payload);
  expect(JSON.stringify(deleted.payload)).not.toContain('deleted athlete note');
  expect(checkInReads()).toHaveLength(0);
});

test('a missing athlete_id is a 400 and reads nothing', async () => {
  const { status } = await readAs({}, '');
  expect(status).toBe(400);
  expect(statements).toEqual([]);
});

test('GET is the only handler, and it issues no write', async () => {
  const handlers = Object.keys(routeModule).filter((name) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(name));
  expect(handlers).toEqual(['GET']);
  await readAs({});
  expect(statements.length).toBeGreaterThan(0);
  for (const sql of statements) expect(sql).toMatch(/^select\b/i);
});
