import { listStoppedComing } from './stoppedComing';
import type { ActorIdentity } from './access';
import { getAttendanceLast28Days } from './attendancePrecedence';
import { organizationActionableRoster } from './coachAthleteRoster';
import { query } from './db';
import { staffNoteRoleInOrganization } from './sessionStaffNotes';
import { readStoppedComingPolicy } from './stoppedComingPolicy';

/*
 * Who has stopped coming (lane W4-6, SC-1). The database half is
 * stoppedComing.pg.test.ts. These pin, with the reads mocked: the staff
 * membership refusal (403, never an empty list), who is listed (OW27-31 A,
 * OW27-32 A; Overwatch W4-6 Q2 A, and on #2172 the program-membership rule),
 * the boundary, the order, and the two reads' own SQL (program memberships
 * with none active; here marks the register does not hold).
 */

jest.mock('./db', () => ({ query: jest.fn() }));
jest.mock('./sessionStaffNotes', () => ({ staffNoteRoleInOrganization: jest.fn() }));
jest.mock('./coachAthleteRoster', () => ({ organizationActionableRoster: jest.fn() }));
jest.mock('./attendancePrecedence', () => ({ getAttendanceLast28Days: jest.fn() }));
jest.mock('./stoppedComingPolicy', () => ({ readStoppedComingPolicy: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockStaffRole = staffNoteRoleInOrganization as jest.Mock;
const mockRoster = organizationActionableRoster as jest.Mock;
const mockRegister = getAttendanceLast28Days as jest.Mock;
const mockPolicy = readStoppedComingPolicy as jest.Mock;

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
  mockQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes(MEMBERSHIPS)) return membershipRows;
    if (String(sql).includes(MARKS)) return marksRows;
    throw new Error(`test bug: an unexpected read: ${sql}`);
  });
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
      { athlete_id: 'a-reg-20', full_name: 'Ada', last_came_day: daysAgo(20), days_since_came: 20 },
      { athlete_id: 'a-gym-30-reg-18', full_name: 'Fay', last_came_day: daysAgo(18), days_since_came: 18 },
      { athlete_id: 'a-gym-16', full_name: 'Eve', last_came_day: daysAgo(16), days_since_came: 16 },
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
