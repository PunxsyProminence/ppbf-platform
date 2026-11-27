import { listStoppedComing, setStoppedComingReachedOut } from './stoppedComing';
import type { ActorIdentity } from './access';
import { getAttendanceLast28Days } from './attendancePrecedence';
import { organizationActionableRoster } from './coachAthleteRoster';
import { query, withTransaction } from './db';
import { readCurrentReachedOut, setReachedOutMark } from './reachedOutMarks';
import { lockStaffMembership, staffNoteRoleInOrganization } from './sessionStaffNotes';
import { readStoppedComingPolicy } from './stoppedComingPolicy';

/*
 * Who has stopped coming (lane W4-6, SC-1). The database half is
 * stoppedComing.pg.test.ts. These pin, with the reads mocked: the staff
 * membership refusal (403, never an empty list), who is listed (OW27-31 A,
 * OW27-32 A; Overwatch W4-6 Q2 A, and on #2172 the program-membership rule),
 * the boundary, the order, and the two reads' own SQL (program memberships
 * with none active; here marks the register does not hold). And the
 * reached-out mark (SC-3a-2): which marks the list asks for, and who may mark,
 * for which athlete, with the last day they came read on the mark's own
 * transaction (Overwatch on #2163, answer A). The mark's own rules are
 * reachedOutMarks.pg.test.ts.
 */

jest.mock('./db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('./sessionStaffNotes', () => ({
  staffNoteRoleInOrganization: jest.fn(),
  lockStaffMembership: jest.fn(),
}));
jest.mock('./coachAthleteRoster', () => ({ organizationActionableRoster: jest.fn() }));
jest.mock('./attendancePrecedence', () => ({ getAttendanceLast28Days: jest.fn() }));
jest.mock('./stoppedComingPolicy', () => ({ readStoppedComingPolicy: jest.fn() }));
jest.mock('./reachedOutMarks', () => ({ readCurrentReachedOut: jest.fn(), setReachedOutMark: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockTransaction = withTransaction as jest.Mock;
const mockStaffRole = staffNoteRoleInOrganization as jest.Mock;
const mockLockMembership = lockStaffMembership as jest.Mock;
const mockRoster = organizationActionableRoster as jest.Mock;
const mockRegister = getAttendanceLast28Days as jest.Mock;
const mockPolicy = readStoppedComingPolicy as jest.Mock;
const mockReadMarks = readCurrentReachedOut as jest.Mock;
const mockSetMark = setReachedOutMark as jest.Mock;

const TODAY = '2026-11-25';
const coach: ActorIdentity = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };

function athlete(athlete_id: string, full_name: string, active_flag = true) {
  return { athlete_id, full_name, active_flag, dob: '2012-01-01', coach_id: 'acct-coach' };
}

/** `days` before TODAY, as a gym-local ISO day. */
function daysAgo(days: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

function register(entries: Record<string, string | null>) {
  return new Map(Object.entries(entries).map(([id, day]) => [id, { athlete_id: id, last_present_day: day }]));
}

// The module's two reads go through `query`; each is answered by the table it names.
const MEMBERSHIPS = 'from pilot.program_memberships pm';
const MARKS = 'from pilot.session_run_athletes m';
let membershipRows: Array<{ athlete_id: string }> = [];
let marksRows: Array<{ athlete_id: string; last_day: string }> = [];
/** The athlete row as the write's transaction locks and reads it; null: no row. */
let athleteRow: { deleted_at: string | null; active_flag: boolean } | null = null;
/** Overwatch on #2206: the gym row, held before the gym's number of days is read. */
const GYM_LOCK = 'select 1 from pilot.organizations where organization_id = $1 for share';
/** Reviewer J: the staff account row on its own, before the membership, the order its writers take. */
const ACCOUNT_LOCK = 'select 1 from pilot.accounts where account_id = $1 for share';
/** The athlete row FOR UPDATE: deleted, left, and every new row naming the athlete wait on it. */
const ATHLETE_LOCK = 'select deleted_at, active_flag from pilot.athletes where organization_id = $1 and athlete_id = $2 for update';
/** The mark's hold on the athlete's membership rows (Codex on #2206). */
const MEMBERSHIP_LOCK = 'select 1 from pilot.program_memberships where organization_id = $1 and athlete_id = any($2::text[]) for share';
/** The mark write's transaction client: the list check's two reads and the here-marks read. */
const txClient = {
  query: jest.fn<Promise<{ rows: unknown[] }>, [string, unknown[]]>(async (sql) => {
    if (String(sql) === GYM_LOCK) return { rows: [{}] };
    if (String(sql) === ACCOUNT_LOCK) return { rows: [{}] };
    if (String(sql) === ATHLETE_LOCK) return { rows: athleteRow ? [athleteRow] : [] };
    if (String(sql) === MEMBERSHIP_LOCK) return { rows: [] };
    if (String(sql).includes(MEMBERSHIPS)) return { rows: membershipRows };
    if (String(sql).includes(MARKS)) return { rows: marksRows };
    throw new Error(`test bug: an unexpected read on the transaction: ${sql}`);
  }),
};
/** The order of the transaction client's reads that name `fragment`. */
const onTx = (fragment: string) => txClient.query.mock.calls
  .map((call, index) => ({ call, order: txClient.query.mock.invocationCallOrder[index] }))
  .filter(({ call }) => String(call[0]).includes(fragment));

function callFor(fromClause: string): unknown[] {
  const calls = mockQuery.mock.calls.filter(([sql]) => String(sql).includes(fromClause));
  expect(calls).toHaveLength(1);
  return calls[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStaffRole.mockResolvedValue('coach');
  mockPolicy.mockResolvedValue({ gap_days: 14, is_default: true });
  mockRoster.mockResolvedValue([]);
  mockRegister.mockResolvedValue(new Map());
  membershipRows = [];
  marksRows = [];
  athleteRow = { deleted_at: null, active_flag: true };
  mockQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes(MEMBERSHIPS)) return membershipRows;
    if (String(sql).includes(MARKS)) return marksRows;
    throw new Error(`test bug: an unexpected read: ${sql}`);
  });
  mockReadMarks.mockResolvedValue(new Map());
  mockTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(txClient));
  mockLockMembership.mockResolvedValue('coach');
  mockSetMark.mockResolvedValue('marked');
});

test('a caller with no active staff membership here is refused (403), and nothing is read', async () => {
  mockStaffRole.mockResolvedValue(null);
  await expect(listStoppedComing(coach, TODAY)).rejects.toMatchObject({ status: 403 });
  expect(mockStaffRole).toHaveBeenCalledWith(coach);
  expect(mockPolicy).not.toHaveBeenCalled();
  expect(mockRoster).not.toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();
  expect(mockQuery).not.toHaveBeenCalled();
});

test('who is listed: came before, not for the gym\'s days; open gym counts as coming; left the gym and never came are not listed', async () => {
  mockRoster.mockResolvedValue([
    athlete('a-reg-20', 'Ada'), // register 20 days ago: listed
    athlete('a-reg-20-gym-3', 'Ben'), // register 20 days ago, open gym 3 days ago: came recently
    athlete('a-never', 'Cy'), // never came: not listed
    athlete('a-left', 'Dee', false), // marked as left the gym: not listed, and not read
    athlete('a-gym-16', 'Eve'), // open gym only, 16 days ago: listed
    athlete('a-gym-30-reg-18', 'Fay'), // the later of the two counts: 18
  ]);
  mockRegister.mockResolvedValue(register({
    'a-reg-20': daysAgo(20), 'a-reg-20-gym-3': daysAgo(20), 'a-never': null, 'a-gym-16': null, 'a-gym-30-reg-18': daysAgo(18),
  }));
  marksRows = [
    { athlete_id: 'a-reg-20-gym-3', last_day: daysAgo(3) },
    { athlete_id: 'a-gym-16', last_day: daysAgo(16) },
    { athlete_id: 'a-gym-30-reg-18', last_day: daysAgo(30) },
  ];

  const list = await listStoppedComing(coach, TODAY);

  expect(list).toEqual({
    gap_days: 14,
    is_default: true,
    today: TODAY,
    athletes: [
      { athlete_id: 'a-reg-20', full_name: 'Ada', last_came_day: daysAgo(20), days_since_came: 20, reached_out: null },
      { athlete_id: 'a-gym-30-reg-18', full_name: 'Fay', last_came_day: daysAgo(18), days_since_came: 18, reached_out: null },
      { athlete_id: 'a-gym-16', full_name: 'Eve', last_came_day: daysAgo(16), days_since_came: 16, reached_out: null },
    ],
  });
  const activeIds = ['a-reg-20', 'a-reg-20-gym-3', 'a-never', 'a-gym-16', 'a-gym-30-reg-18'];
  expect(callFor(MEMBERSHIPS)[1]).toEqual(['org-1', activeIds]);
  expect(mockRegister).toHaveBeenCalledWith('org-1', activeIds, TODAY);
  expect(callFor(MARKS)[1]).toEqual(['org-1', activeIds, TODAY, 'America/New_York']);
});

test('program memberships (Overwatch on #2172): an athlete whose recorded memberships are none of them active is not listed, and their days are not read; no membership recorded is decided by active_flag alone', async () => {
  mockRoster.mockResolvedValue([
    athlete('a-active', 'Ada'), // an active membership: listed
    athlete('a-lapsed', 'Ben'), // lapsed or ended only: not listed
    athlete('a-none', 'Cy'), // no membership recorded: listed
    athlete('a-left', 'Dee', false), // left the gym: not listed, and not read at all
  ]);
  mockRegister.mockResolvedValue(register({ 'a-active': daysAgo(20), 'a-none': daysAgo(20) }));
  membershipRows = [{ athlete_id: 'a-lapsed' }];

  const list = await listStoppedComing(coach, TODAY);

  expect(list.athletes.map((a) => a.athlete_id)).toEqual(['a-active', 'a-none']);
  // The membership read sees only athletes not marked as left; the day reads only those it keeps.
  expect(callFor(MEMBERSHIPS)[1]).toEqual(['org-1', ['a-active', 'a-lapsed', 'a-none']]);
  expect(mockRegister).toHaveBeenCalledWith('org-1', ['a-active', 'a-none'], TODAY);
  expect(callFor(MARKS)[1]).toEqual(['org-1', ['a-active', 'a-none'], TODAY, 'America/New_York']);
  // The membership read comes first.
  expect(String(mockQuery.mock.calls[0][0])).toContain(MEMBERSHIPS);
});

test('the membership read: this gym, these athletes, ids only, an athlete returned only when none of their memberships is active', async () => {
  mockRoster.mockResolvedValue([athlete('a-1', 'Ada')]);
  await listStoppedComing(coach, TODAY);

  const sql = String(callFor(MEMBERSHIPS)[0]).replace(/\s+/g, ' ').trim();
  expect(sql).toBe(
    'select pm.athlete_id from pilot.program_memberships pm where pm.organization_id = $1 and pm.athlete_id = any($2::text[]) '
    + "group by pm.athlete_id having not bool_or(pm.status = 'active')",
  );
});

test('the boundary: exactly the gym\'s number of days is listed, one fewer is not', async () => {
  mockPolicy.mockResolvedValue({ gap_days: 21, is_default: false });
  mockRoster.mockResolvedValue([athlete('a-21', 'Ada'), athlete('a-20', 'Ben'), athlete('a-today', 'Cy')]);
  mockRegister.mockResolvedValue(register({ 'a-21': daysAgo(21), 'a-20': daysAgo(20), 'a-today': TODAY }));

  const list = await listStoppedComing(coach, TODAY);

  expect(list.gap_days).toBe(21);
  expect(list.is_default).toBe(false);
  expect(list.athletes.map((a) => [a.athlete_id, a.days_since_came])).toEqual([['a-21', 21]]);
});

test('longest gone first; names, then ids, break ties', async () => {
  mockRoster.mockResolvedValue([athlete('z', 'Zed'), athlete('b', 'Bea'), athlete('a2', 'Al'), athlete('a1', 'Al'), athlete('old', 'Old')]);
  mockRegister.mockResolvedValue(register({ z: daysAgo(15), b: daysAgo(15), a2: daysAgo(15), a1: daysAgo(15), old: daysAgo(40) }));

  const list = await listStoppedComing(coach, TODAY);

  expect(list.athletes.map((a) => a.athlete_id)).toEqual(['old', 'a1', 'a2', 'b', 'z']);
});

test('a roster with no active athlete answers an empty list without reading marks', async () => {
  mockRoster.mockResolvedValue([athlete('a-left', 'Dee', false)]);
  const list = await listStoppedComing(coach, TODAY);
  expect(list.athletes).toEqual([]);
  expect(mockRegister).toHaveBeenCalledWith('org-1', [], TODAY);
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockReadMarks).toHaveBeenCalledWith('org-1', new Map());
});

test('the marks read: this gym, these athletes, standing marks the register does not hold, up to today, in gym time', async () => {
  mockRoster.mockResolvedValue([athlete('a-1', 'Ada')]);
  await listStoppedComing(coach, TODAY);

  const sql = String(callFor(MARKS)[0]).replace(/\s+/g, ' ');
  expect(sql).toContain('from pilot.session_run_athletes m');
  expect(sql).toContain('join pilot.session_script_runs r on r.organization_id = m.organization_id and r.run_id = m.run_id');
  expect(sql).toContain('where m.organization_id = $1');
  expect(sql).toContain('and m.athlete_id = any($2::text[])');
  expect(sql).toContain('and m.removed_at is null');
  expect(sql).toContain('left join pilot.scheduler_classes c on c.organization_id = m.organization_id and c.class_id = m.register_class_id');
  // Overwatch on #2172 (A): untied, or the register write did not happen, or that class is cancelled.
  expect(sql).toContain("and (r.class_id is null or m.register_written_at is null or c.status = 'cancelled')");
  expect(sql).toContain('and (m.marked_at at time zone $4)::date <= $3::date');
  // One day per athlete leaves the read: no run, mark or marker.
  expect(sql).toMatch(/^ ?select m\.athlete_id, max\(\(m\.marked_at at time zone \$4\)::date\)::text as last_day from/);
});

describe('the reached-out mark on the list (SC-3a-2)', () => {
  test('the marks are asked for the listed athletes only, each with their last day they came, and shown as the module answers', async () => {
    mockRoster.mockResolvedValue([athlete('a-1', 'Ada'), athlete('a-2', 'Ben'), athlete('a-recent', 'Cy')]);
    mockRegister.mockResolvedValue(register({ 'a-1': daysAgo(20), 'a-2': daysAgo(30), 'a-recent': daysAgo(2) }));
    marksRows = [{ athlete_id: 'a-1', last_day: daysAgo(25) }];
    mockReadMarks.mockResolvedValue(new Map([['a-2', { by_name: 'Coach Jordan', by_role: 'coach', on_day: daysAgo(3) }]]));

    const list = await listStoppedComing(coach, TODAY);

    expect(mockReadMarks).toHaveBeenCalledTimes(1);
    expect(mockReadMarks).toHaveBeenCalledWith('org-1', new Map([['a-2', daysAgo(30)], ['a-1', daysAgo(20)]]));
    expect(list.athletes).toEqual([
      { athlete_id: 'a-2', full_name: 'Ben', last_came_day: daysAgo(30), days_since_came: 30, reached_out: { by_name: 'Coach Jordan', by_role: 'coach', on_day: daysAgo(3) } },
      { athlete_id: 'a-1', full_name: 'Ada', last_came_day: daysAgo(20), days_since_came: 20, reached_out: null },
    ]);
  });
});

describe('setStoppedComingReachedOut (SC-3a-2)', () => {
  test('a caller with no active staff membership here is refused (403), and nothing is read or written', async () => {
    mockStaffRole.mockResolvedValue(null);
    await expect(setStoppedComingReachedOut(coach, 'a-1', true, TODAY)).rejects.toMatchObject({ status: 403 });
    expect(mockStaffRole).toHaveBeenCalledWith(coach);
    expect(mockRoster).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSetMark).not.toHaveBeenCalled();
  });

  test('an athlete who is not a live athlete of this gym (another gym\'s, deleted, or no such id) is not found (404), before any transaction', async () => {
    mockRoster.mockResolvedValue([athlete('a-1', 'Ada'), athlete('a-left', 'Dee', false)]);
    await expect(setStoppedComingReachedOut(coach, 'a-elsewhere', true, TODAY)).rejects.toMatchObject({ status: 404 });
    expect(mockRoster).toHaveBeenCalledWith('org-1');
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSetMark).not.toHaveBeenCalled();
  });

  test('membership and athlete are checked again under lock in the transaction: either gone refuses, nothing written', async () => {
    mockRoster.mockResolvedValue([athlete('a-1', 'Ada')]);
    mockLockMembership.mockResolvedValueOnce(null);
    await expect(setStoppedComingReachedOut(coach, 'a-1', true, TODAY)).rejects.toMatchObject({ status: 403 });
    expect(onTx(ATHLETE_LOCK)).toHaveLength(0);
    // Soft-deleted, or no row, as the transaction reads it under its lock: 404, whatever the roster said.
    for (const row of [{ deleted_at: '2026-11-24T12:00:00Z', active_flag: true }, null]) {
      for (const reachedOut of [true, false]) {
        athleteRow = row;
        await expect(setStoppedComingReachedOut(coach, 'a-1', reachedOut, TODAY)).rejects.toMatchObject({ status: 404 });
      }
    }
    expect(onTx(ATHLETE_LOCK).map(({ call }) => call[1])).toEqual(Array(4).fill(['org-1', 'a-1']));
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockSetMark).not.toHaveBeenCalled();
  });

  test('both day reads run on the transaction client: the register read gets it as its 4th argument, the open-gym read runs on it, not on the pool', async () => {
    mockRoster.mockResolvedValue([athlete('a-1', 'Ada'), athlete('a-2', 'Ben')]);
    mockLockMembership.mockResolvedValue('organization_admin');
    mockRegister.mockResolvedValue(register({ 'a-1': daysAgo(30) }));
    marksRows = [{ athlete_id: 'a-1', last_day: daysAgo(20) }];
    mockSetMark.mockResolvedValue('already_marked');

    await expect(setStoppedComingReachedOut(coach, 'a-1', true, TODAY)).resolves.toBe('already_marked');

    expect(mockLockMembership).toHaveBeenCalledWith(txClient, coach);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister.mock.calls[0]).toEqual(['org-1', ['a-1'], TODAY, txClient]);
    const onClient = txClient.query.mock.calls.filter(([sql]) => String(sql).includes(MARKS));
    expect(onClient).toHaveLength(1);
    expect(onClient[0][1]).toEqual(['org-1', ['a-1'], TODAY, 'America/New_York']);
    // Nothing of the list check or the days was read on the pool.
    expect(mockQuery).not.toHaveBeenCalled();
    // The later of the two days, with the membership role.
    expect(mockSetMark).toHaveBeenCalledWith(txClient, {
      actor: coach, role: 'organization_admin', athleteId: 'a-1', lastCameDay: daysAgo(20), reachedOut: true,
    });
  });

  describe('a mark only for an athlete on the list now, by the list\'s rules (409, nothing written); reviewers J and K', () => {
    const refused = { status: 409, code: 'NOT_ON_STOPPED_COMING_LIST' };

    test('the whole list check runs on the transaction, each fact under its lock, parents first, before the day reads (reviewer J; Overwatch on #2206)', async () => {
      mockRoster.mockResolvedValue([athlete('a-1', 'Ada')]);
      mockRegister.mockResolvedValue(register({ 'a-1': daysAgo(30) }));
      await expect(setStoppedComingReachedOut(coach, 'a-1', true, TODAY)).resolves.toBe('marked');

      const [gymLock] = onTx(GYM_LOCK);
      const [accountLock] = onTx(ACCOUNT_LOCK);
      const [athleteLock] = onTx(ATHLETE_LOCK);
      const [membershipLock] = onTx(MEMBERSHIP_LOCK);
      const [membership] = onTx(MEMBERSHIPS);
      const [marks] = onTx(MARKS);
      expect(gymLock.call[1]).toEqual(['org-1']);
      // The gym's number of days is read on the transaction, after its row is held; never on the pool.
      expect(mockPolicy.mock.calls).toEqual([['org-1', txClient]]);
      expect(accountLock.call[1]).toEqual(['acct-coach']);
      expect(athleteLock.call[1]).toEqual(['org-1', 'a-1']);
      // Codex on #2206: the athlete's membership rows are held FOR SHARE, on the transaction, before they are read.
      expect(membershipLock.call[1]).toEqual(['org-1', ['a-1']]);
      expect(membership.call[1]).toEqual(['org-1', ['a-1']]);
      const order = [
        gymLock.order,
        mockPolicy.mock.invocationCallOrder[0],
        accountLock.order,
        mockLockMembership.mock.invocationCallOrder[0],
        athleteLock.order,
        membershipLock.order,
        membership.order,
        mockRegister.mock.invocationCallOrder[0],
        marks.order,
        mockSetMark.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['marked as left (read on the transaction, whatever the roster said before it)', false, []],
      ['only lapsed or ended memberships (read on the transaction)', true, [{ athlete_id: 'a-1' }]],
    ])('%s: refused (409) before the days are read or the mark is touched', async (_label, flag, lapsed) => {
      mockRoster.mockResolvedValue([athlete('a-1', 'Ada')]); // the roster, before the transaction, says active
      athleteRow = { deleted_at: null, active_flag: flag };
      membershipRows = lapsed;
      await expect(setStoppedComingReachedOut(coach, 'a-1', true, TODAY)).rejects.toMatchObject(refused);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(onTx(ATHLETE_LOCK)).toHaveLength(1);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockRegister).not.toHaveBeenCalled();
      expect(mockSetMark).not.toHaveBeenCalled();
    });

    it.each([
      ['never came', null, null, 14],
      ['came today', TODAY, null, 14],
      ['came within the gym\'s days (13 of 14)', daysAgo(13), null, 14],
      ['open gym within the gym\'s days, the register long ago', daysAgo(40), daysAgo(5), 14],
      ['came within the gym\'s own number (20 of 21)', daysAgo(20), null, 21],
    ])('%s: refused inside the transaction, after the same-transaction read, before the mark is touched', async (_label, registerDay, openGymDay, gapDays) => {
      mockPolicy.mockResolvedValue({ gap_days: gapDays, is_default: gapDays === 14 });
      mockRoster.mockResolvedValue([athlete('a-1', 'Ada')]);
      mockRegister.mockResolvedValue(register({ 'a-1': registerDay }));
      marksRows = openGymDay ? [{ athlete_id: 'a-1', last_day: openGymDay }] : [];
      await expect(setStoppedComingReachedOut(coach, 'a-1', true, TODAY)).rejects.toMatchObject(refused);
      expect(mockRegister).toHaveBeenCalledWith('org-1', ['a-1'], TODAY, txClient);
      expect(mockSetMark).not.toHaveBeenCalled();
    });

    test('exactly the gym\'s number of days is on the list, and marks', async () => {
      mockPolicy.mockResolvedValue({ gap_days: 21, is_default: false });
      mockRoster.mockResolvedValue([athlete('a-1', 'Ada')]);
      mockRegister.mockResolvedValue(register({ 'a-1': daysAgo(21) }));
      await expect(setStoppedComingReachedOut(coach, 'a-1', true, TODAY)).resolves.toBe('marked');
      expect(mockSetMark).toHaveBeenCalledWith(txClient, expect.objectContaining({ lastCameDay: daysAgo(21), reachedOut: true }));
    });

    test('a take-back needs no list check: no policy or membership read, even for an athlete marked as left; the athlete row is still held', async () => {
      mockRoster.mockResolvedValue([athlete('a-left', 'Dee', false)]);
      mockRegister.mockResolvedValue(register({ 'a-left': TODAY }));
      mockSetMark.mockResolvedValue('taken_back');
      athleteRow = { deleted_at: null, active_flag: false };
      await expect(setStoppedComingReachedOut(coach, 'a-left', false, TODAY)).resolves.toBe('taken_back');
      expect(mockPolicy).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
      expect([...onTx(GYM_LOCK), ...onTx(MEMBERSHIPS)]).toEqual([]);
      // The take-back rests on the staff member and the last day they came: the account, then the
      // membership, then the athlete row (FOR UPDATE), each before the day is read.
      expect(onTx(ACCOUNT_LOCK)[0].order).toBeLessThan(mockLockMembership.mock.invocationCallOrder[0]);
      expect(onTx(ATHLETE_LOCK)[0].order).toBeLessThan(onTx(MARKS)[0].order);
      expect(mockSetMark).toHaveBeenCalledWith(txClient, expect.objectContaining({ lastCameDay: TODAY, reachedOut: false }));
    });
  });

  test('a take-back for an athlete who never came passes no last day', async () => {
    mockRoster.mockResolvedValue([athlete('a-1', 'Ada')]);
    mockSetMark.mockResolvedValue('not_marked');
    await expect(setStoppedComingReachedOut(coach, 'a-1', false, TODAY)).resolves.toBe('not_marked');
    expect(mockSetMark).toHaveBeenCalledWith(txClient, expect.objectContaining({ lastCameDay: null, reachedOut: false }));
  });
});
