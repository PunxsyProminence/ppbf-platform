import { NextRequest } from 'next/server';

import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * The parent hub's Progress tile (WO-PH-01) counts what this route answers, so
 * the tile is only as private as this read. Two families, one child each: each
 * guardian reads their own child's awards and completed-session count, is
 * refused the other family's child before any of that child's records are
 * queried, and never receives an account id.
 *
 * requirePrincipal and the database are faked; access.ts, guardianAccess.ts
 * and achievements.ts are real, and the fake honours a guardian link only
 * through the parents / guardian_links predicates the statement carries.
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
  { organization_id: 'org-1', athlete_id: 'ath-a', dob: '2013-04-02' },
  { organization_id: 'org-1', athlete_id: 'ath-b', dob: '2012-09-15' },
];
const parents = [
  { organization_id: 'org-1', account_id: 'acct-parent-a', parent_id: 'par-a' },
  { organization_id: 'org-1', account_id: 'acct-parent-b', parent_id: 'par-b' },
];
const links = [
  { organization_id: 'org-1', parent_id: 'par-a', athlete_id: 'ath-a' },
  { organization_id: 'org-1', parent_id: 'par-b', athlete_id: 'ath-b' },
];
// Each child's own record: different on purpose, so a value that crossed
// families would be visible in the answer.
const awards: Record<string, Array<Record<string, string>>> = {
  'ath-a': [
    { athlete_id: 'ath-a', milestone_key: 'cond_mile', awarded_by_role: 'coach', note: '', awarded_at: '2026-10-01T12:00:00.000Z' },
  ],
  'ath-b': [
    { athlete_id: 'ath-b', milestone_key: 'cond_mile', awarded_by_role: 'self', note: '', awarded_at: '2026-09-20T12:00:00.000Z' },
    { athlete_id: 'ath-b', milestone_key: 'craft_jab', awarded_by_role: 'coach', note: '', awarded_at: '2026-09-28T12:00:00.000Z' },
  ],
};
const completedSessions: Record<string, number> = { 'ath-a': 4, 'ath-b': 11 };

let statements: Array<{ text: string; params: unknown[] }>;
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  statements = [];
  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push({ text, params });
    if (text.includes('from pilot.guardian_links')) {
      const [organizationId, athleteId, accountId] = params as string[];
      const parentIds = parents
        .filter((row) => row.organization_id === organizationId && row.account_id === accountId)
        .map((row) => row.parent_id);
      const link = links.find((row) => row.organization_id === organizationId
        && row.athlete_id === athleteId && parentIds.includes(row.parent_id));
      const athlete = athletes.find((row) => row.organization_id === organizationId && row.athlete_id === athleteId);
      return link && athlete ? { athlete_id: athleteId, dob: athlete.dob } : null;
    }
    if (text.includes('from pilot.athlete_programs')) return null;
    if (text.includes('from pilot.sessions')) {
      const [, athleteId] = params as string[];
      return { completed: String(completedSessions[athleteId] ?? 0) };
    }
    throw new Error(`unexpected SQL in this test: ${text}`);
  });
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push({ text, params });
    if (text.includes('from pilot.athlete_milestones')) {
      const [, athleteId] = params as string[];
      return awards[athleteId] ?? [];
    }
    throw new Error(`unexpected SQL in this test: ${text}`);
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

async function readAs(accountId: string, athleteId: string) {
  mockRequirePrincipal.mockResolvedValue({
    accountId,
    role: 'parent',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal);
  const response = await GET(
    new NextRequest(`http://localhost/api/pilot/achievements/milestones?athlete_id=${athleteId}`),
  );
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

// Every statement that reads a child's progress record (as opposed to the
// guardian-link check), with the athlete it was asked about.
const progressReadsFor = (athleteId: string) => statements.filter((row) =>
  !row.text.includes('from pilot.guardian_links') && (row.params as unknown[]).includes(athleteId));

test('each guardian reads their own child’s earned milestones and completed sessions, and only theirs', async () => {
  const first = await readAs('acct-parent-a', 'ath-a');
  expect(first.status).toBe(200);
  expect(first.payload.completed_sessions).toBe(4);
  expect((first.payload.items as Array<{ athlete_id: string }>).map((row) => row.athlete_id)).toEqual(['ath-a']);

  const second = await readAs('acct-parent-b', 'ath-b');
  expect(second.status).toBe(200);
  expect(second.payload.completed_sessions).toBe(11);
  expect((second.payload.items as Array<{ athlete_id: string }>).map((row) => row.athlete_id)).toEqual(['ath-b', 'ath-b']);
});

test('a guardian asking for the other family’s child is refused before that child’s records are read', async () => {
  const crossA = await readAs('acct-parent-a', 'ath-b');
  expect(crossA.status).toBe(403);
  expect(crossA.payload.items).toBeUndefined();
  expect(crossA.payload.completed_sessions).toBeUndefined();
  expect(progressReadsFor('ath-b')).toEqual([]);

  statements = [];
  const crossB = await readAs('acct-parent-b', 'ath-a');
  expect(crossB.status).toBe(403);
  expect(progressReadsFor('ath-a')).toEqual([]);
});

test('the answer a family receives carries no account id', async () => {
  const { payload } = await readAs('acct-parent-b', 'ath-b');
  expect(JSON.stringify(payload)).not.toMatch(/account_id|acct-/);
});
