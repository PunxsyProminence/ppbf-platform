import { NextRequest } from 'next/server';

import { GET } from './route';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listPresentAthletes, staffPermittedAthleteIds } from '@/src/server/pilot/sessionRunAthletes';
import { getLiveRunForCoach, listSettledRunsForOrganization } from '@/src/server/pilot/sessionScriptRuns';
import type { PilotRole } from '@/src/server/pilot/contracts';

// GET /api/pilot/session-scripts/runs?finished=true (audit finding F-067): the
// gym's finished sessions, plain and scripted, with end notes and who was
// present. The reads themselves are proven on real rows in
// sessionRunAthletes.pg.test.ts; this file asserts what the route decides: who
// is admitted, whose gym is read, that the present athletes are filtered by ids
// the SERVER computed, and what each row carries. requireRole is the real one.

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/sessionScriptRuns', () => ({
  ...jest.requireActual('@/src/server/pilot/sessionScriptRuns'),
  getLiveRunForCoach: jest.fn(),
  listSettledRunsForOrganization: jest.fn(),
}));
jest.mock('@/src/server/pilot/sessionRunAthletes', () => ({
  listPresentAthletes: jest.fn(),
  staffPermittedAthleteIds: jest.fn(),
}));
jest.mock('@/src/server/pilot/achievements', () => ({ getCoachDisplayName: jest.fn() }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockSettled = listSettledRunsForOrganization as jest.Mock;
const mockLive = getLiveRunForCoach as jest.Mock;
const mockPresent = listPresentAthletes as jest.Mock;
const mockPermitted = staffPermittedAthleteIds as jest.Mock;
const mockName = getCoachDisplayName as jest.Mock;

function principal(overrides: Record<string, unknown> = {}) {
  return { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null, sessionToken: 't', authProvider: 'microsoft', ...overrides };
}

const run = (overrides: Record<string, unknown>) => ({
  organization_id: 'org-1',
  run_id: 'ssrun_1',
  script_id: null,
  script_version: null,
  script_name: null,
  delivered_by_account_id: 'acct-coach',
  delivered_on: '2026-10-13',
  run_state: 'completed',
  started_at: '2026-10-13T22:00:00.000Z',
  ended_at: '2026-10-13T23:00:00.000Z',
  athletes_present: 2,
  blocks_completed: null,
  deviation_note: 'Finished early.',
  what_worked: 'The jab round.',
  what_did_not: '',
  ...overrides,
});

const finished = () => GET(new NextRequest('http://localhost/api/pilot/session-scripts/runs?finished=true&organization_id=org-9&athlete_id=ath-77'));

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue(principal());
  mockSettled.mockResolvedValue([]);
  mockPermitted.mockResolvedValue(['ath-1', 'ath-2']);
  mockPresent.mockResolvedValue([]);
  mockName.mockImplementation(async (_org: string, accountId: string) => (accountId === 'acct-coach' ? 'Coach Dee' : 'Coach Ray'));
});

describe('GET ?finished=true', () => {
  it.each([
    ['coach', 200], ['organization_admin', 200], ['admin', 200],
    ['platform_owner', 403], ['athlete', 403], ['parent', 403], ['board', 403], ['volunteer', 403], ['staff', 403],
  ] as Array<[PilotRole, number]>)('%s -> %i, and a refused role reads nothing', async (role, status) => {
    mockPrincipal.mockResolvedValue(principal({ role }));

    expect((await finished()).status).toBe(status);
    if (status === 403) {
      expect(mockSettled).not.toHaveBeenCalled();
      expect(mockPermitted).not.toHaveBeenCalled();
      expect(mockPresent).not.toHaveBeenCalled();
    }
  });

  it("lists the session's own gym's finished sessions with end notes, who delivered them and who was present", async () => {
    mockSettled.mockResolvedValue([
      run({ run_id: 'ssrun_2', delivered_by_account_id: 'acct-other', script_id: 'scr-1', script_version: 2, script_name: 'Tuesday juniors' }),
      run({ run_id: 'ssrun_1' }),
    ]);
    mockPresent.mockResolvedValue([
      { run_id: 'ssrun_1', athlete_id: 'ath-1', full_name: 'Ada Reyes', marked_at: '2026-10-13T22:05:00.000Z' },
      { run_id: 'ssrun_1', athlete_id: 'ath-2', full_name: 'Ben Ortiz', marked_at: '2026-10-13T22:06:00.000Z' },
    ]);

    const response = await finished();

    // The organization and the athlete ids in the query are not read.
    expect(mockSettled).toHaveBeenCalledWith('org-1');
    expect(mockPermitted).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-coach', organizationId: 'org-1' }));
    expect(mockPresent).toHaveBeenCalledWith('org-1', ['ssrun_2', 'ssrun_1'], ['ath-1', 'ath-2']);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const { runs } = (await response.json()) as { runs: Array<Record<string, unknown>> };
    expect(runs.map((row) => [row.run_id, row.script_name, row.delivered_by_name, row.delivered_by_me, row.present])).toEqual([
      ['ssrun_2', 'Tuesday juniors', 'Coach Ray', false, []],
      ['ssrun_1', null, 'Coach Dee', true, [{ athlete_id: 'ath-1', full_name: 'Ada Reyes' }, { athlete_id: 'ath-2', full_name: 'Ben Ortiz' }]],
    ]);
    expect(runs[1]).toMatchObject({ deviation_note: 'Finished early.', what_worked: 'The jab round.', athletes_present: 2 });
    // Exactly these fields: no account id (it can be an email address) and no organization id.
    expect(Object.keys(runs[1]).sort()).toEqual([
      'athletes_present', 'blocks_completed', 'delivered_by_me', 'delivered_by_name', 'delivered_on', 'deviation_note',
      'ended_at', 'present', 'run_id', 'run_state', 'script_id', 'script_name', 'script_version', 'started_at',
      'what_did_not', 'what_worked',
    ]);
    expect(JSON.stringify(runs)).not.toMatch(/acct-|org-1/);
    // It is not the live-run lookup.
    expect(mockLive).not.toHaveBeenCalled();
  });

  it('only the exact value true asks for it: anything else is the live-run lookup as before', async () => {
    mockLive.mockResolvedValue(null);
    for (const value of ['false', '1', 'yes', '']) {
      const response = await GET(new NextRequest(`http://localhost/api/pilot/session-scripts/runs?finished=${value}`));
      await expect(response.json()).resolves.toEqual({ run: null });
    }
    expect(mockSettled).not.toHaveBeenCalled();
  });
});
