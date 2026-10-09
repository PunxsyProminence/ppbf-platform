// Unit tests for the 1% Club (module 127). What these pin is the doctrine,
// not just the plumbing:
//
//   1. Majority is against everyone ELIGIBLE right now, not everyone who
//      voted -- the owner's own words were "majority of coach and admin ON
//      THE LIST", and that is a different number than a majority of ballots.
//   2. A vote is immutable once cast: repeating it is a no-op, changing it
//      is refused.
//   3. A milestone claim is verified against the athlete's real record --
//      a fabricated key never produces a 'milestone_surfaced' nomination.
//   4. Re-nomination and duplicate-nomination refusals, and the withdrawal
//      reason requirement.
//   5. Nothing here ever moves a nomination OUT of 'confirmed'.

import {
  castVote,
  createNomination,
  getTally,
  isEligibleVoterRole,
  listNominations,
  listVotes,
  resolveActorDisplayName,
  withdrawNomination,
} from './onePercentClub';
import { query, queryOne } from './db';

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./achievements', () => ({
  getCoachDisplayName: jest.fn().mockResolvedValue('Coach A'),
  listMilestoneAwards: jest.fn(),
  countCompletedSessions: jest.fn(),
}));

import { countCompletedSessions, listMilestoneAwards } from './achievements';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockAwards = listMilestoneAwards as jest.Mock;
const mockSessions = countCompletedSessions as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

/** Routes a mocked db call by matching a substring against the SQL text, so
 * tests read against behavior rather than call position. */
function dispatch(map: Array<[string, unknown]>) {
  return (sql: string) => {
    const hit = map.find(([needle]) => sql.includes(needle));
    if (!hit) throw new Error(`Unhandled query in test: ${sql}`);
    return Promise.resolve(hit[1]);
  };
}

test('isEligibleVoterRole is exactly coach, organization_admin, admin', () => {
  expect(isEligibleVoterRole('coach')).toBe(true);
  expect(isEligibleVoterRole('organization_admin')).toBe(true);
  expect(isEligibleVoterRole('admin')).toBe(true);
  expect(isEligibleVoterRole('athlete')).toBe(false);
  expect(isEligibleVoterRole('parent')).toBe(false);
});

describe('getTally: majority is against everyone eligible, not everyone who voted', () => {
  test('5 eligible needs 3 yes votes, not a bare plurality', async () => {
    mockQueryOne.mockResolvedValueOnce({ eligible: '5' });
    mockQuery.mockResolvedValueOnce([{ vote: 'yes', count: '2' }]);
    let tally = await getTally('org-1', 'nom-1');
    expect(tally).toEqual({ eligible_count: 5, yes_count: 2, no_count: 0, majority_reached: false });

    mockQueryOne.mockResolvedValueOnce({ eligible: '5' });
    mockQuery.mockResolvedValueOnce([{ vote: 'yes', count: '3' }]);
    tally = await getTally('org-1', 'nom-1');
    expect(tally.majority_reached).toBe(true);
  });

  test('a majority of votes CAST is not enough if it is not a majority of the eligible list', async () => {
    // 10 eligible, only 4 have voted at all, 3 of those said yes -- 3 of 4
    // ballots is a landslide of votes cast, but not a majority of the list.
    mockQueryOne.mockResolvedValueOnce({ eligible: '10' });
    mockQuery.mockResolvedValueOnce([{ vote: 'yes', count: '3' }, { vote: 'no', count: '1' }]);
    const tally = await getTally('org-1', 'nom-1');
    expect(tally.majority_reached).toBe(false);
  });

  test('zero eligible voters can never reach majority', async () => {
    mockQueryOne.mockResolvedValueOnce({ eligible: '0' });
    mockQuery.mockResolvedValueOnce([]);
    const tally = await getTally('org-1', 'nom-1');
    expect(tally.majority_reached).toBe(false);
  });
});

describe('castVote', () => {
  test('refuses to vote on a nomination that is not open', async () => {
    mockQuery.mockImplementation(dispatch([["set status = 'expired'", []]]));
    mockQueryOne.mockImplementation(dispatch([
      ['from pilot.one_percent_nominations n', { nomination_id: 'nom-1', status: 'confirmed' }],
    ]));

    await expect(castVote({
      organizationId: 'org-1', nominationId: 'nom-1', voterAccountId: 'acct-1', voterRole: 'coach', vote: 'yes',
    })).rejects.toThrow('not open for voting');
  });

  test('repeating the same vote is a no-op; changing it is refused', async () => {
    mockQuery.mockImplementation(dispatch([
      ["set status = 'expired'", []],
      ['group by vote', [{ vote: 'yes', count: '1' }]],
    ]));
    mockQueryOne.mockImplementation((sql: string) => {
      if (sql.includes('from pilot.one_percent_nominations n')) return Promise.resolve({ nomination_id: 'nom-1', status: 'open' });
      if (sql.includes('select vote from pilot.one_percent_votes')) return Promise.resolve({ vote: 'yes' });
      if (sql.includes('count(*)::text as eligible')) return Promise.resolve({ eligible: '5' });
      throw new Error(`Unhandled queryOne in test: ${sql}`);
    });

    const repeated = await castVote({
      organizationId: 'org-1', nominationId: 'nom-1', voterAccountId: 'acct-1', voterRole: 'coach', vote: 'yes',
    });
    expect(repeated?.nomination.nomination_id).toBe('nom-1');

    await expect(castVote({
      organizationId: 'org-1', nominationId: 'nom-1', voterAccountId: 'acct-1', voterRole: 'coach', vote: 'no',
    })).rejects.toThrow('cannot be changed');
  });

  test('confirms the nomination the instant yes-votes form a majority of the eligible list', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("set status = 'expired'")) return Promise.resolve([]);
      if (sql.includes('group by vote')) return Promise.resolve([{ vote: 'yes', count: '3' }]);
      throw new Error(`Unhandled query in test: ${sql}`);
    });
    let updatedToConfirmed = false;
    mockQueryOne.mockImplementation((sql: string) => {
      if (sql.includes('from pilot.one_percent_nominations n') && !sql.includes('update')) {
        return Promise.resolve({ nomination_id: 'nom-1', status: updatedToConfirmed ? 'confirmed' : 'open' });
      }
      if (sql.includes('select vote from pilot.one_percent_votes')) return Promise.resolve(null);
      if (sql.includes('count(*)::text as eligible')) return Promise.resolve({ eligible: '5' });
      if (sql.includes('select login_email from pilot.accounts')) return Promise.resolve({ login_email: 'sam.lee@ppbf.org' });
      if (sql.includes('insert into pilot.one_percent_votes')) return Promise.resolve({ voter_account_id: 'acct-1' });
      if (sql.includes("update pilot.one_percent_nominations")) {
        updatedToConfirmed = true;
        return Promise.resolve({ nomination_id: 'nom-1' });
      }
      throw new Error(`Unhandled queryOne in test: ${sql}`);
    });

    const result = await castVote({
      organizationId: 'org-1', nominationId: 'nom-1', voterAccountId: 'acct-1', voterRole: 'admin', vote: 'yes',
    });
    expect(result?.tally.majority_reached).toBe(true);
    expect(result?.nomination.status).toBe('confirmed');
  });
});

describe('createNomination', () => {
  function baseQueryOneMock(overrides: Record<string, unknown> = {}) {
    return (sql: string) => {
      if (sql.includes('select athlete_id from pilot.athletes')) {
        return Promise.resolve(overrides.athleteExists === false ? null : { athlete_id: 'ath-1' });
      }
      if (sql.includes('select full_name from pilot.athletes')) return Promise.resolve({ full_name: 'Jordan P.' });
      if (sql.includes('select login_email from pilot.accounts')) return Promise.resolve({ login_email: 'alex.rivera@ppbf.org' });
      if (sql.includes('insert into pilot.one_percent_nominations')) return Promise.resolve({ nomination_id: 'nom-new' });
      if (sql.includes('from pilot.one_percent_nominations n')) {
        return Promise.resolve({ nomination_id: 'nom-new', status: 'open', source: overrides.expectSource ?? 'coach_nomination' });
      }
      throw new Error(`Unhandled queryOne in test: ${sql}`);
    };
  }

  test('refuses a second nomination while one is already open', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("set status = 'expired'")) return Promise.resolve([]);
      if (sql.includes('order by created_at desc')) return Promise.resolve([{ status: 'open', decided_at: null }]);
      throw new Error(`Unhandled query in test: ${sql}`);
    });
    mockQueryOne.mockImplementation(baseQueryOneMock());

    await expect(createNomination({
      organizationId: 'org-1', athleteId: 'ath-1', nominatorAccountId: 'acct-1', nominatorRole: 'coach',
    })).rejects.toThrow('already has an open');
  });

  test('refuses a nomination once the athlete is already a confirmed member', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("set status = 'expired'")) return Promise.resolve([]);
      if (sql.includes('order by created_at desc')) return Promise.resolve([{ status: 'confirmed', decided_at: '2026-01-01T00:00:00Z' }]);
      throw new Error(`Unhandled query in test: ${sql}`);
    });
    mockQueryOne.mockImplementation(baseQueryOneMock());

    await expect(createNomination({
      organizationId: 'org-1', athleteId: 'ath-1', nominatorAccountId: 'acct-1', nominatorRole: 'coach',
    })).rejects.toThrow('already a 1% Club member');
  });

  test('refuses re-nomination inside the 30-day cooldown after a withdrawal, allows it after', async () => {
    const recentlyClosed = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("set status = 'expired'")) return Promise.resolve([]);
      if (sql.includes('order by created_at desc')) return Promise.resolve([{ status: 'withdrawn', decided_at: recentlyClosed }]);
      throw new Error(`Unhandled query in test: ${sql}`);
    });
    mockQueryOne.mockImplementation(baseQueryOneMock());

    await expect(createNomination({
      organizationId: 'org-1', athleteId: 'ath-1', nominatorAccountId: 'acct-1', nominatorRole: 'coach',
    })).rejects.toThrow('Re-nomination opens in');

    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("set status = 'expired'")) return Promise.resolve([]);
      if (sql.includes('order by created_at desc')) return Promise.resolve([{ status: 'withdrawn', decided_at: longAgo }]);
      throw new Error(`Unhandled query in test: ${sql}`);
    });

    const result = await createNomination({
      organizationId: 'org-1', athleteId: 'ath-1', nominatorAccountId: 'acct-1', nominatorRole: 'coach',
    });
    expect(result?.nomination_id).toBe('nom-new');
  });

  test('a fabricated milestone key that was never earned falls back to coach_nomination, never trusted as-is', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("set status = 'expired'")) return Promise.resolve([]);
      if (sql.includes('order by created_at desc')) return Promise.resolve([]);
      throw new Error(`Unhandled query in test: ${sql}`);
    });
    mockQueryOne.mockImplementation(baseQueryOneMock());
    mockAwards.mockResolvedValue([]);
    mockSessions.mockResolvedValue(1); // nowhere near a real threshold

    let capturedInsertParams: unknown[] = [];
    mockQueryOne.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('select athlete_id from pilot.athletes')) return Promise.resolve({ athlete_id: 'ath-1' });
      if (sql.includes('select login_email from pilot.accounts')) return Promise.resolve({ login_email: 'alex.rivera@ppbf.org' });
      if (sql.includes('insert into pilot.one_percent_nominations')) {
        capturedInsertParams = params ?? [];
        return Promise.resolve({ nomination_id: 'nom-new' });
      }
      if (sql.includes('from pilot.one_percent_nominations n')) return Promise.resolve({ nomination_id: 'nom-new', source: 'coach_nomination' });
      throw new Error(`Unhandled queryOne in test: ${sql}`);
    });

    await createNomination({
      organizationId: 'org-1', athleteId: 'ath-1', nominatorAccountId: 'acct-1', nominatorRole: 'coach',
      claimedMilestoneKey: 'consistency.233',
    });

    // source (index 3) is 'coach_nomination' and milestone_key (index 8) is null --
    // an unearned claim never survives into the row.
    expect(capturedInsertParams[3]).toBe('coach_nomination');
    expect(capturedInsertParams[8]).toBeNull();
  });

  test('a genuinely earned milestone produces a milestone_surfaced nomination carrying the key', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("set status = 'expired'")) return Promise.resolve([]);
      if (sql.includes('order by created_at desc')) return Promise.resolve([]);
      throw new Error(`Unhandled query in test: ${sql}`);
    });
    mockAwards.mockResolvedValue([]);
    mockSessions.mockResolvedValue(233); // clears the real 'consistency.233' threshold

    let capturedInsertParams: unknown[] = [];
    mockQueryOne.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('select athlete_id from pilot.athletes')) return Promise.resolve({ athlete_id: 'ath-1' });
      if (sql.includes('select login_email from pilot.accounts')) return Promise.resolve({ login_email: 'alex.rivera@ppbf.org' });
      if (sql.includes('insert into pilot.one_percent_nominations')) {
        capturedInsertParams = params ?? [];
        return Promise.resolve({ nomination_id: 'nom-new' });
      }
      if (sql.includes('from pilot.one_percent_nominations n')) return Promise.resolve({ nomination_id: 'nom-new', source: 'milestone_surfaced' });
      throw new Error(`Unhandled queryOne in test: ${sql}`);
    });

    await createNomination({
      organizationId: 'org-1', athleteId: 'ath-1', nominatorAccountId: 'acct-1', nominatorRole: 'coach',
      claimedMilestoneKey: 'consistency.233',
    });

    expect(capturedInsertParams[3]).toBe('milestone_surfaced');
    expect(capturedInsertParams[8]).toBe('consistency.233');
  });

  test('an unknown athlete nominates nothing', async () => {
    mockQueryOne.mockImplementation((sql: string) => {
      if (sql.includes('select athlete_id from pilot.athletes')) return Promise.resolve(null);
      throw new Error(`Unhandled queryOne in test: ${sql}`);
    });

    const result = await createNomination({
      organizationId: 'org-1', athleteId: 'ath-nowhere', nominatorAccountId: 'acct-1', nominatorRole: 'coach',
    });
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('withdrawNomination', () => {
  test('requires a non-empty reason', async () => {
    await expect(withdrawNomination({ organizationId: 'org-1', nominationId: 'nom-1', reason: '   ' }))
      .rejects.toThrow('needs a reason');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('cannot touch a confirmed nomination -- the WHERE clause only matches open rows', async () => {
    mockQuery.mockResolvedValue([]);
    mockQueryOne.mockImplementation((sql: string) => {
      // The update targets status = 'open' only; a confirmed row matches
      // zero rows and RETURNING yields nothing.
      if (sql.includes("set status = 'withdrawn'")) return Promise.resolve(null);
      throw new Error(`Unhandled queryOne in test: ${sql}`);
    });

    const result = await withdrawNomination({ organizationId: 'org-1', nominationId: 'nom-confirmed', reason: 'changed my mind' });
    expect(result).toBeNull();
  });
});

describe('resolveActorDisplayName', () => {
  test('a coach reuses the platform coach-name derivation', async () => {
    const name = await resolveActorDisplayName({ organizationId: 'org-1', accountId: 'acct-1', role: 'coach' });
    expect(name).toBe('Coach A');
  });

  test('an athlete is named from their own athlete record, not derived from email', async () => {
    mockQueryOne.mockResolvedValueOnce({ full_name: 'Jordan P.' });
    const name = await resolveActorDisplayName({
      organizationId: 'org-1', accountId: 'acct-athlete', role: 'athlete', selfAthleteId: 'ath-1',
    });
    expect(name).toBe('Jordan P.');
  });

  test('an admin is derived from login email with an admin, not coach, label', async () => {
    mockQueryOne.mockResolvedValueOnce({ login_email: 'alex.rivera@ppbf.org' });
    const name = await resolveActorDisplayName({ organizationId: 'org-1', accountId: 'acct-admin', role: 'admin' });
    expect(name).toBe('Admin Alex Rivera');
  });

  // Scope B. The real-Postgres cases are in athleteSelfPathsDeletion.pg.test.ts;
  // these pin the reads' shape and the existing fallback phrases.
  test('the athlete read takes the deletion mark and falls to the existing phrase', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const name = await resolveActorDisplayName({
      organizationId: 'org-1', accountId: 'acct-athlete', role: 'athlete', selfAthleteId: 'ath-gone',
    });
    expect(name).toBe('An athlete');
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toMatch(/from pilot\.athletes[\s\S]*deleted_at is null/);
    expect(params).toEqual(['org-1', 'ath-gone']);
  });

  test('the admin read takes the deletion mark and falls to the existing phrase', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const name = await resolveActorDisplayName({ organizationId: 'org-1', accountId: 'acct-gone', role: 'admin' });
    expect(name).toBe('An administrator');
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('deleted_account.deleted_at is not null');
    expect(params).toEqual(['org-1', 'acct-gone']);
  });
});

/**
 * Finding N7 (OD-2026-10-06-025 r2, scope B): the frozen nominator and voter
 * name copies are not read back for a deleted person. SQL-shape pins; the
 * rows themselves are proven in w2IdentityReach.pg.test.ts.
 */
describe('a deleted nominator or voter is not named from the stored copy', () => {
  test('listNominations wraps nominated_by_display_name in the deletion-mark CASE, by stored role', async () => {
    mockQuery.mockResolvedValue([]);
    await listNominations('org-1');
    const sql = String(mockQuery.mock.calls.at(-1)?.[0]);
    expect(sql).toMatch(/case when not exists \([\s\S]*deleted_account\.account_id = n\.nominated_by_account_id[\s\S]*then n\.nominated_by_display_name/);
    expect(sql).toContain("when n.nominated_by_role = 'athlete' then 'An athlete'");
    expect(sql).toContain("when n.nominated_by_role = 'coach' then 'Your coach'");
    expect(sql).toContain("else 'An administrator' end as nominated_by_display_name");
    // The mark on the athlete behind the login counts too (accountNotDeletedSql).
    expect(sql).toContain('deleted_athlete.deleted_at is not null');
  });

  test('listVotes wraps voter_display_name the same way', async () => {
    mockQuery.mockResolvedValue([]);
    await listVotes('org-1', 'nom-1');
    const sql = String(mockQuery.mock.calls.at(-1)?.[0]);
    expect(sql).toMatch(/deleted_account\.account_id = v\.voter_account_id[\s\S]*then v\.voter_display_name/);
    expect(sql).toContain("else 'An administrator' end as voter_display_name");
  });
});
