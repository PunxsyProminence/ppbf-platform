jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
}));

import {
  InvalidAchievementInput,
  MentorshipAlreadyOpenError,
  awardMilestone,
  countCompletedSessions,
  createMentorship,
  createPersonalGoal,
  createRecognition,
  deriveCoachDisplayName,
  getAthleteProgram,
  listRecognitionsForAthlete,
  markPersonalGoalReached,
  setAthleteProgram,
} from './achievements';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

/** The SQL of the most recent query, whitespace-collapsed for matching. */
function lastSql(): string {
  const calls = mockQuery.mock.calls;
  return String(calls[calls.length - 1]?.[0] ?? '').replace(/\s+/g, ' ');
}

describe('recognition', () => {
  it('refuses anything outside the closed positive vocabulary', async () => {
    // Checked here as well as by the check constraint. The constraint is what
    // cannot be bypassed; this is what gives a coach a sentence rather than
    // SQLSTATE 23514 -- and what makes a negative value impossible to write
    // even from a caller that skips the route.
    for (const kind of ['concern', 'warning', 'needs_improvement', 'late_again', '']) {
      await expect(createRecognition({
        organizationId: 'org-1',
        athleteId: 'ath-1',
        coachAccountId: 'acc-1',
        coachDisplayName: 'Coach Jason',
        kind,
      })).rejects.toBeInstanceOf(InvalidAchievementInput);
    }

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('writes a positive one, signed, and never returns the coach account id', async () => {
    mockQuery.mockResolvedValueOnce([{
      recognition_id: 'recog_1',
      athlete_id: 'ath-1',
      coach_display_name: 'Coach Jason',
      kind: 'helped_someone',
      note: '',
      created_at: '2026-08-03T12:00:00.000Z',
    }]);

    const recognition = await createRecognition({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      coachAccountId: 'acc-1',
      coachDisplayName: 'Coach Jason',
      kind: 'helped_someone',
    });

    expect(recognition.kind).toBe('helped_someone');
    // The account behind the name has no reason to reach a client, and it is
    // the one field that would make a recognition feed joinable to anything.
    expect(Object.keys(recognition)).not.toContain('coach_account_id');
    expect(lastSql()).not.toContain('returning recognition_id, athlete_id, coach_account_id');
  });

  it('truncates a long note rather than losing what the coach typed', async () => {
    mockQuery.mockResolvedValueOnce([{}]);

    await createRecognition({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      coachAccountId: 'acc-1',
      coachDisplayName: 'Coach Jason',
      kind: 'good_partner',
      note: 'x'.repeat(400),
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    // The cap keeps it a sentence rather than a report, and truncating rather
    // than rejecting means a coach in a hurry never loses the send to a
    // validation error.
    expect(String(params[6])).toHaveLength(140);
  });

  it('reads one athlete at a time, with a bounded page', async () => {
    await listRecognitionsForAthlete('org-1', 'ath-1', 5000);
    const params = mockQuery.mock.calls[0][1] as unknown[];

    expect(lastSql()).toContain('where organization_id = $1 and athlete_id = $2');
    expect(lastSql()).toContain('order by created_at desc');
    // Not ordered by anything comparable between athletes, and never unbounded.
    expect(lastSql()).not.toMatch(/order by count|group by/i);
    expect(params[2]).toBe(100);

    await listRecognitionsForAthlete('org-1', 'ath-1', -3);
    expect((mockQuery.mock.calls[1][1] as unknown[])[2]).toBe(1);
  });
});

describe('the signature on a recognition', () => {
  it('is derived from the sender\'s own login, never supplied', () => {
    expect(deriveCoachDisplayName('jason@punxsyprominence.org')).toBe('Coach Jason');
    expect(deriveCoachDisplayName('mary.ellen.walsh@example.org')).toBe('Coach Mary Ellen Walsh');
    expect(deriveCoachDisplayName('coach_dave2@example.org')).toBe('Coach Coach Dave');
  });

  it('falls back to something true rather than to an empty signature', () => {
    // An unsigned compliment reads as a system notification, which is the one
    // thing this feature must not be.
    expect(deriveCoachDisplayName(null)).toBe('Your coach');
    expect(deriveCoachDisplayName('')).toBe('Your coach');
    expect(deriveCoachDisplayName('12345@example.org')).toBe('Your coach');
  });
});

describe('milestones', () => {
  it('refuses a key that is not in the catalogue', async () => {
    await expect(awardMilestone({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      milestoneKey: 'conditioning.made_this_up',
      awardedByRole: 'coach',
    })).rejects.toBeInstanceOf(InvalidAchievementInput);
  });

  it('refuses an awarder role outside the vocabulary', async () => {
    await expect(awardMilestone({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      milestoneKey: 'conditioning.mile_unbroken',
      awardedByRole: 'shadow',
    })).rejects.toBeInstanceOf(InvalidAchievementInput);
  });

  it('is idempotent and keeps the first date', async () => {
    mockQueryOne.mockResolvedValueOnce({
      athlete_id: 'ath-1',
      milestone_key: 'conditioning.mile_unbroken',
      awarded_by_role: 'self',
      note: '',
      awarded_at: '2026-05-01T00:00:00.000Z',
    });

    const award = await awardMilestone({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      milestoneKey: 'conditioning.mile_unbroken',
      awardedByRole: 'self',
    });

    // `do nothing`, so a second tap does not move the day it happened -- and
    // one row per milestone per athlete means no countable quantity ever
    // accumulates that two athletes could be compared on.
    expect(lastSql()).toContain('on conflict (organization_id, athlete_id, milestone_key) do nothing');
    expect(award?.awarded_at).toBe('2026-05-01T00:00:00.000Z');
  });

  it('counts completed sessions and nothing else about them', async () => {
    mockQueryOne.mockResolvedValueOnce({ completed: '41' });
    expect(await countCompletedSessions('org-1', 'ath-1')).toBe(41);

    const sql = String(mockQueryOne.mock.calls[0][0]).replace(/\s+/g, ' ');
    // A count cannot see a date, so nothing derived from it can see a gap.
    expect(sql).toContain('count(*)');
    expect(sql).toContain('completed_flag = true');
    expect(sql).not.toMatch(/date|created_at|order by/i);
  });

  it('reports zero rather than throwing when there is nothing to count', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await countCompletedSessions('org-1', 'ath-1')).toBe(0);
  });
});

describe('personal goals', () => {
  it('needs the words and nothing else', async () => {
    mockQuery.mockResolvedValueOnce([{ goal_id: 'goal_1' }]);

    await createPersonalGoal({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      ownWords: 'Show up on the days I do not want to',
      setByRole: 'athlete',
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[3]).toBe('Show up on the days I do not want to');
    // No date. A goal like this one has none, and requiring one turns it into
    // something a calendar can fail.
    expect(params[4]).toBeNull();
    expect(lastSql()).toContain("'own_words'");
  });

  it('refuses an empty goal and an essay', async () => {
    await expect(createPersonalGoal({
      organizationId: 'org-1', athleteId: 'ath-1', ownWords: '   ', setByRole: 'athlete',
    })).rejects.toBeInstanceOf(InvalidAchievementInput);

    await expect(createPersonalGoal({
      organizationId: 'org-1', athleteId: 'ath-1', ownWords: 'x'.repeat(500), setByRole: 'athlete',
    })).rejects.toBeInstanceOf(InvalidAchievementInput);
  });

  it('marks one reached without ever moving the day it happened', async () => {
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({
      goal_id: 'goal_1',
      athlete_id: 'ath-1',
      reached_at: '2026-06-01T00:00:00.000Z',
    });

    const goal = await markPersonalGoalReached('org-1', 'goal_1', 'ath-1');

    // The update predicate carries `reached_at is null`, so a second tap
    // matches nothing and the read-back returns the original date.
    expect(lastSql()).toContain('reached_at is null');
    expect(goal?.reached_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('reads only own-words goals, leaving the SMART path untouched', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await markPersonalGoalReached('org-1', 'goal_1', 'ath-1');
    expect(lastSql()).toContain("goal_kind = 'own_words'");
  });

  /*
   * The write is keyed on the AUTHORIZED OWNER, not on goal_id alone.
   *
   * Before this, the UPDATE matched `organization_id and goal_id` only, and the
   * route compared the returned row's athlete_id to the caller's payload
   * afterwards. That comparison could only ever report a mutation that had
   * already committed: a caller authorized for their own athlete could name any
   * other athlete's goal_id and permanently stamp that child's goal
   * reached_at/status='completed'. Putting the owner in the WHERE clause makes
   * the authorization and the write one statement, so an unauthorized row is
   * not reached at all rather than reached and then reported as absent.
   */
  it('scopes both the write and the idempotent read-back to the named athlete', async () => {
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce(null);

    await markPersonalGoalReached('org-1', 'goal_1', 'ath-1');

    const updateSql = String(mockQuery.mock.calls[0]?.[0] ?? '').replace(/\s+/g, ' ');
    expect(updateSql).toContain('update pilot.goals');
    expect(updateSql).toContain('athlete_id = $4');
    expect(mockQuery.mock.calls[0]?.[1]).toContain('ath-1');

    // The fallback read-back is the same statement's twin: without the same
    // predicate it would hand another athlete's goal text back to the caller.
    const readBackSql = String(mockQueryOne.mock.calls[0]?.[0] ?? '').replace(/\s+/g, ' ');
    expect(readBackSql).toContain('athlete_id = $3');
    expect(mockQueryOne.mock.calls[0]?.[1]).toContain('ath-1');
  });
});

describe('mentorship', () => {
  it('refuses a self-pairing before it reaches the database', async () => {
    await expect(createMentorship({
      organizationId: 'org-1',
      mentorAthleteId: 'ath-1',
      menteeAthleteId: 'ath-1',
      createdByAccountId: 'acc-1',
    })).rejects.toBeInstanceOf(InvalidAchievementInput);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('turns the unique-index violation into an outcome a coach can act on', async () => {
    // Only the partial unique index can hold one open pairing per couple -- two
    // concurrent creates each read no existing row and both write.
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    await expect(createMentorship({
      organizationId: 'org-1',
      mentorAthleteId: 'ath-1',
      menteeAthleteId: 'ath-2',
      createdByAccountId: 'acc-1',
    })).rejects.toBeInstanceOf(MentorshipAlreadyOpenError);
  });
});

describe('the programme somebody came for', () => {
  it('defaults to the general path when nobody has been asked', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    // Not 'competitive'. A system that assumes everybody is on the fight path
    // is the system this work replaces.
    expect(await getAthleteProgram('org-1', 'ath-1')).toBe('recreational');
  });

  it('ignores a value that is not one of the four', async () => {
    mockQueryOne.mockResolvedValueOnce({ program: 'elite_squad' });
    expect(await getAthleteProgram('org-1', 'ath-1')).toBe('recreational');

    await expect(setAthleteProgram({
      organizationId: 'org-1', athleteId: 'ath-1', program: 'elite_squad',
    })).rejects.toBeInstanceOf(InvalidAchievementInput);
  });

  it('never reads the programme off body data', async () => {
    mockQueryOne.mockResolvedValueOnce({ program: 'fitness' });
    await getAthleteProgram('org-1', 'ath-1');

    // pilot.athletes.gym_status is already classified as a record about a
    // person's body; a training path read off it would be readable back as a
    // medical fact.
    const sql = String(mockQueryOne.mock.calls[0][0]);
    expect(sql).toContain('pilot.athlete_programs');
    expect(sql).not.toContain('gym_status');
  });
});
