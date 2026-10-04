import { NextRequest } from 'next/server';

import * as routeModule from './route';
import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * A parent reads their own child's weight and seven-day flag, and nobody
 * else's. requirePrincipal and the database are faked; access.ts, the guardian
 * link query and athleteBodyMass.ts are real, and the fake honours the link
 * only through the parents/guardian_links predicates the statement carries.
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

const NOW = new Date('2026-10-04T18:00:00Z');
const DAY = 24 * 60 * 60 * 1_000;

const athletes = [
  { organization_id: 'org-1', athlete_id: 'ath-child', dob: '2012-03-01', deleted_at: null as string | null },
  { organization_id: 'org-1', athlete_id: 'ath-other', dob: '2012-03-01', deleted_at: null as string | null },
  { organization_id: 'org-1', athlete_id: 'ath-deleted', dob: '2012-03-01', deleted_at: '2026-09-01T00:00:00Z' },
  // Linked when they were 16; 19 now.
  { organization_id: 'org-1', athlete_id: 'ath-grown', dob: '2007-03-01', deleted_at: null as string | null },
];
// parent account -> parent_id, and parent_id -> linked athletes.
const parents = [{ organization_id: 'org-1', account_id: 'acct-parent', parent_id: 'par-1' }];
const links = [
  { organization_id: 'org-1', parent_id: 'par-1', athlete_id: 'ath-child' },
  { organization_id: 'org-1', parent_id: 'par-1', athlete_id: 'ath-deleted' },
  { organization_id: 'org-1', parent_id: 'par-1', athlete_id: 'ath-grown' },
];
let statements: string[];

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  statements = [];
  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push(text);
    const values = params as string[];
    if (text.includes('from pilot.guardian_links')) {
      const [organizationId, athleteId, accountId] = values;
      const liveOnly = text.includes('deleted_at is null');
      const parentIds = parents
        .filter((row) => row.organization_id === organizationId && row.account_id === accountId)
        .map((row) => row.parent_id);
      const hit = links.find((link) => link.organization_id === organizationId
        && link.athlete_id === athleteId
        && parentIds.includes(link.parent_id)
        && athletes.some((a) => a.organization_id === organizationId && a.athlete_id === athleteId
          && (!liveOnly || a.deleted_at === null)));
      return hit ? { athlete_id: hit.athlete_id } : null;
    }
    if (text.includes('from pilot.athletes') && text.includes('as dob')) {
      const [organizationId, athleteId] = values;
      const hit = athletes.find((a) => a.organization_id === organizationId && a.athlete_id === athleteId
        && (!text.includes('deleted_at is null') || a.deleted_at === null));
      return hit ? { dob: hit.dob } : null;
    }
    throw new Error(`unexpected SQL in this test: ${text}`);
  });
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push(text);
    const [, athleteId] = params as string[];
    return [
      { observation_id: `${athleteId}-p`, numeric_value: 60, unit: 'kilograms', observed_at: new Date(NOW.getTime() - 8 * DAY) },
      { observation_id: `${athleteId}-l`, numeric_value: 56.4, unit: 'kilograms', observed_at: new Date(NOW.getTime() - DAY) },
    ];
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

async function readAs(caller: Partial<PilotPrincipal>, athleteId: string) {
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'acct-parent',
    role: 'parent',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...caller,
  } as PilotPrincipal);
  const response = await GET(new NextRequest(`http://localhost/api/pilot/parent/body-mass?athlete_id=${athleteId}`));
  return { status: response.status, payload: (await response.json()) as { body_mass?: Record<string, unknown> | null } };
}

const weightReads = () => statements.filter((sql) => sql.includes('shadow_formula_observations'));

test('a linked parent reads their child\'s weight and flag', async () => {
  const { status, payload } = await readAs({}, 'ath-child');
  expect(status).toBe(200);
  expect(payload.body_mass).toMatchObject({ latest: { kilograms: 56.4 }, flagged: true });
});

test('a guardian link that outlived the child turning 18 shows nothing: adults have no parent surface', async () => {
  const { status, payload } = await readAs({}, 'ath-grown');
  expect(status).toBe(200);
  expect(payload).toEqual({ body_mass: null });
  expect(weightReads()).toEqual([]);
});

test('a parent not linked to the athlete is refused and nothing is read', async () => {
  const { status, payload } = await readAs({}, 'ath-other');
  expect(status).toBe(403);
  expect(payload.body_mass).toBeUndefined();
  expect(weightReads()).toEqual([]);
});

test('a link to a deleted athlete reads nothing', async () => {
  const { status } = await readAs({}, 'ath-deleted');
  expect(status).toBe(403);
  expect(weightReads()).toEqual([]);
});

test('the same parent account in another organization is refused', async () => {
  const { status } = await readAs({ organizationId: 'org-2' }, 'ath-child');
  expect(status).toBe(403);
  expect(weightReads()).toEqual([]);
});

test('only the parent role has a path here', async () => {
  for (const role of ['coach', 'athlete', 'organization_admin', 'admin', 'platform_owner', 'board'] as const) {
    statements = [];
    const { status } = await readAs({ role, athleteId: 'ath-child' }, 'ath-child');
    expect({ role, status }).toEqual({ role, status: 403 });
    expect(statements).toEqual([]);
  }
});

test('GET is the only handler', () => {
  expect(Object.keys(routeModule).filter((name) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(name))).toEqual(['GET']);
});
