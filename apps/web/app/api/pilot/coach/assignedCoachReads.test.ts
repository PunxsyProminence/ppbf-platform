import { NextRequest } from 'next/server';

import { GET as getCheckIn } from './athlete-check-in/route';
import { GET as getSleepTrend } from './athlete-sleep-trend/route';
import { GET as getCompetitionHistory } from './athlete-competition-history/route';
import { GET as getSessionNote } from './athlete-session-note/route';
import { GET as getBodyMass } from './athlete-body-mass/route';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getTodayCheckIn, listRecentCheckIns } from '@/src/server/pilot/athleteCheckIns';
import { listAthleteCompetitionHistory } from '@/src/server/pilot/externalCompetition';
import { getTodaySessionNote } from '@/src/server/pilot/sessionNotes';
import { summarizeBodyMass } from '@/src/server/pilot/athleteBodyMass';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * OD-2026-10-05-024, ruling 2 (Jason 2026-10-05, "Go with all reco,endations"):
 * coach read routes that allowed any coach in the gym allow only the athlete's
 * assigned coach(es) -- coach of record or a live coverage grant -- the same
 * rule assertActorCanAccessAthlete applies everywhere else. This supersedes
 * A-FIN-03R1 (check-in) and OD-2026-09-25-003 (session note) for reads.
 *
 * One fake database, shared by all five routes, models the athletes and
 * coverage tables; the real access.ts runs against it. The per-route data
 * readers are mocked so a refusal can be checked for "nothing was read".
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

jest.mock('@/src/server/pilot/athleteCheckIns', () => ({
  getTodayCheckIn: jest.fn(async () => null),
  listRecentCheckIns: jest.fn(async () => []),
}));

jest.mock('@/src/server/pilot/externalCompetition', () => {
  const actual = jest.requireActual('@/src/server/pilot/externalCompetition');
  return { ...actual, listAthleteCompetitionHistory: jest.fn(async () => []) };
});

jest.mock('@/src/server/pilot/sessionNotes', () => ({ getTodaySessionNote: jest.fn(async () => null) }));

jest.mock('@/src/server/pilot/athleteBodyMass', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteBodyMass');
  return {
    ...actual,
    // Adult athlete: past the youth rule, so only the ruling-2 gate can refuse.
    bodyMassVisibleTo: jest.fn(async () => true),
    summarizeBodyMass: jest.fn(async () => ({ latest: null, correctable_entries: [] })),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

const athletes = [
  { organization_id: 'org-1', athlete_id: 'ath-marisol', coach_id: 'coach-record', deleted_at: null as string | null },
];
const coverage = [
  { organization_id: 'org-1', athlete_id: 'ath-marisol', covering_coach_id: 'coach-covering', live: true },
  { organization_id: 'org-1', athlete_id: 'ath-marisol', covering_coach_id: 'coach-lapsed', live: false },
];

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  mockQueryOne.mockImplementation(async (sql: string, params: string[]) => {
    const text = normalize(sql);
    if (text.includes('from pilot.coach_coverage')) {
      const [organizationId, athleteId, coachId] = params;
      const hit = coverage.find((grant) => grant.organization_id === organizationId
        && grant.athlete_id === athleteId && grant.covering_coach_id === coachId && grant.live);
      return hit ? { athlete_id: hit.athlete_id } : null;
    }
    if (text.includes('from pilot.athletes')) {
      if (text.includes('coach_id = $2')) {
        const [athleteId, coachId, organizationId] = params;
        const hit = athletes.find((row) => row.athlete_id === athleteId && row.coach_id === coachId
          && row.organization_id === organizationId && row.deleted_at === null);
        return hit ? { athlete_id: hit.athlete_id } : null;
      }
      const orgPredicate = /organization_id = \$(\d+)/.exec(text);
      const organizationId = orgPredicate ? params[Number(orgPredicate[1]) - 1] : null;
      const hit = athletes.find((row) => row.athlete_id === params[0]
        && (organizationId === null || row.organization_id === organizationId)
        && row.deleted_at === null);
      return hit ? { athlete_id: hit.athlete_id } : null;
    }
    throw new Error(`unexpected SQL: ${text}`);
  });
});

afterEach(() => jest.clearAllMocks());

const ROUTES = [
  { name: 'athlete-check-in', handler: getCheckIn, reader: getTodayCheckIn },
  { name: 'athlete-sleep-trend', handler: getSleepTrend, reader: listRecentCheckIns },
  { name: 'athlete-competition-history', handler: getCompetitionHistory, reader: listAthleteCompetitionHistory },
  { name: 'athlete-session-note', handler: getSessionNote, reader: getTodaySessionNote },
  { name: 'athlete-body-mass', handler: getBodyMass, reader: summarizeBodyMass },
] as const;

async function readAs(route: (typeof ROUTES)[number], caller: Partial<PilotPrincipal>) {
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'coach-record', role: 'coach', organizationId: 'org-1', athleteId: null,
    sessionToken: 'token', authProvider: 'microsoft', ...caller,
  } as PilotPrincipal);
  const response = await route.handler(
    new NextRequest(`http://localhost/api/pilot/coach/${route.name}?athlete_id=ath-marisol`),
  );
  return response.status;
}

describe.each(ROUTES)('$name: only the athlete\'s assigned coach(es) read it', (route) => {
  test('a coach with no assignment and no coverage is refused, before any read', async () => {
    expect(await readAs(route, { accountId: 'coach-unrelated' })).toBe(403);
    expect(route.reader).not.toHaveBeenCalled();
  });

  test('a coach whose coverage grant has lapsed is refused, before any read', async () => {
    expect(await readAs(route, { accountId: 'coach-lapsed' })).toBe(403);
    expect(route.reader).not.toHaveBeenCalled();
  });

  test('the coach of record and a live covering coach read it', async () => {
    expect(await readAs(route, { accountId: 'coach-record' })).toBe(200);
    expect(await readAs(route, { accountId: 'coach-covering' })).toBe(200);
  });

  test('an organization admin reads it under both role names', async () => {
    expect(await readAs(route, { accountId: 'acct-admin', role: 'organization_admin' })).toBe(200);
    expect(await readAs(route, { accountId: 'acct-admin', role: 'admin' })).toBe(200);
  });
});
