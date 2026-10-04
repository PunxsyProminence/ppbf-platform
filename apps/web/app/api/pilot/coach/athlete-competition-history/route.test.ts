import { NextRequest } from 'next/server';

import * as routeModule from './route';
import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * Map item 10 -- staff read of ONE athlete's bout history. requirePrincipal
 * and the database are faked; the route, access.ts and externalCompetition.ts
 * are real. The SQL against real tables is proven in
 * competitionResults.pg.test.ts; this suite proves who may ask, and for whom.
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

const MARISOL_LOSS = {
  entry_id: 'e-1', competition_id: 'comp-1', competition_name: 'Golden Gloves Regional',
  competition_date: '2026-09-01', competition_status: 'completed', location: '', sanctioning_body: 'USA Boxing',
  result: 'lost', lesson_note: 'dropped the right hand',
};

let statements: string[];
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  statements = [];
  mockQueryOne.mockImplementation(async (sql: string, params: string[]) => {
    const text = normalize(sql);
    statements.push(text);
    if (!text.includes('from pilot.athletes')) throw new Error(`unexpected SQL: ${text}`);
    const orgPredicate = /organization_id = \$(\d+)/.exec(text);
    const organizationId = orgPredicate ? params[Number(orgPredicate[1]) - 1] : null;
    const liveOnly = text.includes('deleted_at is null');
    const hit = athletes.find((row) => row.athlete_id === params[0]
      && (organizationId === null || row.organization_id === organizationId)
      && (!liveOnly || row.deleted_at === null));
    return hit ? { athlete_id: hit.athlete_id } : null;
  });
  mockQuery.mockImplementation(async (sql: string, params: string[]) => {
    const text = normalize(sql);
    statements.push(text);
    if (!text.includes('from pilot.external_competition_entries')) throw new Error(`unexpected list SQL: ${text}`);
    return params[0] === 'org-1' && params[1] === 'ath-marisol' ? [MARISOL_LOSS] : [];
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
  const response = await GET(new NextRequest(`http://localhost/api/pilot/coach/athlete-competition-history?${qs}`));
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

const historyReads = () => statements.filter((sql) => sql.includes('external_competition_entries'));

test('coach and admins read the athlete\'s entries, including the lesson note', async () => {
  for (const role of ['coach', 'organization_admin', 'admin'] as const) {
    const { status, payload } = await readAs({ role });
    expect({ role, status }).toEqual({ role, status: 200 });
    expect(payload).toEqual({ items: [MARISOL_LOSS] });
  }
  expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'ath-marisol']);
});

test('the read is one athlete, entered entries, live athletes only', async () => {
  await readAs({});
  const [sql] = historyReads();
  expect(sql).toContain('e.athlete_id = $2');
  expect(sql).toContain("e.status = 'entered'");
  expect(sql).toContain('a.deleted_at is null');
});

test('the athlete role is refused, even for their own id -- self-view is not this item', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner', 'board'] as const) {
    statements = [];
    const { status } = await readAs({ role, athleteId: 'ath-marisol' });
    expect({ role, status }).toEqual({ role, status: 403 });
    expect(statements).toEqual([]);
  }
});

test('another gym and a soft-deleted athlete are refused alike, before the history is read', async () => {
  const crossOrg = await readAs({ organizationId: 'org-2' }, 'athlete_id=ath-marisol&organization_id=org-1');
  const deleted = await readAs({}, 'athlete_id=ath-deleted');
  const nobody = await readAs({}, 'athlete_id=ath-nobody');

  expect([crossOrg.status, deleted.status, nobody.status]).toEqual([403, 403, 403]);
  expect(deleted.payload).toEqual(nobody.payload);
  expect(historyReads()).toHaveLength(0);
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
