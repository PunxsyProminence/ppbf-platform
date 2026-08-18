import { buildRosterCsv } from '@/app/api/pilot/admin/export/roster/csv';
import { applyRosterImport, parseCsv, parseRosterCsv, planRosterImport, type RosterImportRow, type RosterRowPlan } from './rosterImport';
import { query } from './db';
import { insertAthleteIfAbsent } from './entities';
import { insertClubMemberIfAbsent } from './clubMembers';

jest.mock('./db', () => ({ query: jest.fn() }));
jest.mock('./entities', () => ({ insertAthleteIfAbsent: jest.fn() }));
jest.mock('./clubMembers', () => ({ insertClubMemberIfAbsent: jest.fn() }));

const mockQuery = query as jest.Mock;
// Two names for the same mock: the batch-insert tests below (ported from the
// perf-batching PR) call it mockInsertIfAbsent, the club-members tests call
// it mockInsertAthlete. Both stay so neither test block needs renaming.
const mockInsertIfAbsent = insertAthleteIfAbsent as jest.Mock;
const mockInsertAthlete = insertAthleteIfAbsent as jest.Mock;
const mockInsertClubMember = insertClubMemberIfAbsent as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  mockQuery.mockResolvedValue([]);
  mockInsertAthlete.mockResolvedValue(true);
  mockInsertClubMember.mockResolvedValue(true);
});

describe('parseCsv', () => {
  // A roster is exactly the file that breaks a naive split: a name with a
  // comma in it, a note containing a quoted phrase, an address over two lines.
  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('a,b\n"Smith, Junior",x\n')).toEqual([
      ['a', 'b'],
      ['Smith, Junior', 'x'],
    ]);
  });

  it('reads a doubled quote as one quote', () => {
    expect(parseCsv('a\n"She said ""hello"""\n')).toEqual([['a'], ['She said "hello"']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('a,b\n"12 High St\nApt 4",x\n')).toEqual([
      ['a', 'b'],
      ['12 High St\nApt 4', 'x'],
    ]);
  });

  it('handles CRLF, LF, and a file with no trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  // Excel writes one, and without stripping it the first header becomes
  // "﻿Athlete ID" and matches nothing.
  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿Athlete ID\nath-1\n')).toEqual([['Athlete ID'], ['ath-1']]);
  });

  it('drops blank lines rather than treating them as athletes', () => {
    expect(parseCsv('a\n1\n\n\n2\n')).toEqual([['a'], ['1'], ['2']]);
  });
});

describe('parseRosterCsv', () => {
  it('refuses a file with no athlete id or name column', () => {
    const parsed = parseRosterCsv('Weight class,Gym status\nlightweight,active\n');
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.fatal).toMatch(/athlete id column and a full name column/i);
  });

  it('accepts the headers a hand-typed roster would use', () => {
    const parsed = parseRosterCsv('id,name,dob\nath-1,A Name,2012-03-14\n');
    expect(parsed.fatal).toBe('');
    expect(parsed.rows[0]).toMatchObject({
      athlete_id: 'ath-1',
      full_name: 'A Name',
      date_of_birth: '2012-03-14',
    });
  });

  // The real membership export's own Member ID / Mbr Type / address headers.
  // NOTE: the export splits the name into Last Name/First Name/MI columns
  // rather than one "Full name" column -- this importer still requires a
  // combined full-name column, unchanged by this extension (see the roster
  // import report's open question about name splitting).
  it('accepts the real membership export headers', () => {
    const parsed = parseRosterCsv(
      'Member ID,Full name,Address,City,State,Zip,Mbr Type\n'
      + 'mbr-1,Jason Neale,1 Main St,Punxsutawney,PA,15767,Non-Athlete\n',
    );
    expect(parsed.fatal).toBe('');
    expect(parsed.rows[0]).toMatchObject({
      athlete_id: 'mbr-1',
      full_name: 'Jason Neale',
      address_line1: '1 Main St',
      city: 'Punxsutawney',
      state: 'PA',
      postal_code: '15767',
      member_type: 'Non-Athlete',
    });
  });

  // The whole point of matching the export's columns.
  it('round-trips a file this platform exported', () => {
    const csv = buildRosterCsv([
      {
        athlete_id: 'ath-1',
        full_name: 'A Name',
        date_of_birth: '2012-03-14',
        weight_class: 'lightweight',
        gym_status: 'training',
        active: true,
        coach_account_id: 'coach-1',
        coach_email: 'coach@example.org',
        emergency_contact_note: 'Aunt, 555-0100',
        emergency_contact_name: null,
        emergency_contact_relationship: null,
        emergency_contact_phone: null,
        emergency_contact_email: null,
        guardian_count: 1,
        guardians: 'A Guardian',
        athlete_login_id: null,
        athlete_login_active: null,
        attendance_rate: null,
        created_at: null,
        updated_at: null,
      },
    ]);

    const parsed = parseRosterCsv(csv);

    expect(parsed.fatal).toBe('');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      athlete_id: 'ath-1',
      full_name: 'A Name',
      date_of_birth: '2012-03-14',
      weight_class: 'lightweight',
      gym_status: 'training',
      // The comma survived the round trip.
      emergency_contact_note: 'Aunt, 555-0100',
      coach_account_id: 'coach-1',
    });
  });

  // The export prefixes an apostrophe to anything a spreadsheet would evaluate
  // as a formula. Reading it back has to remove it, or a value gains one
  // apostrophe per export/import cycle.
  it('undoes the export formula guard rather than accumulating apostrophes', () => {
    const csv = buildRosterCsv([
      {
        athlete_id: 'ath-1',
        full_name: '-Odd Name',
        date_of_birth: '2012-03-14',
        weight_class: null,
        gym_status: null,
        active: true,
        coach_account_id: null,
        coach_email: null,
        emergency_contact_note: '=SUM(A1)',
        emergency_contact_name: null,
        emergency_contact_relationship: null,
        emergency_contact_phone: null,
        emergency_contact_email: null,
        guardian_count: null,
        guardians: null,
        athlete_login_id: null,
        athlete_login_active: null,
        attendance_rate: null,
        created_at: null,
        updated_at: null,
      },
    ]);

    // The guard is really in the file...
    expect(csv).toContain("'-Odd Name");
    // ...and gone again on the way back.
    const parsed = parseRosterCsv(csv);
    expect(parsed.rows[0].full_name).toBe('-Odd Name');
    expect(parsed.rows[0].emergency_contact_note).toBe('=SUM(A1)');
  });
});

describe('planRosterImport', () => {
  const row = (over: Partial<Record<string, string>> = {}) => ({
    athlete_id: 'ath-1',
    full_name: 'A Name',
    date_of_birth: '2012-03-14',
    weight_class: '',
    gym_status: '',
    emergency_contact_note: '',
    coach_account_id: '',
    member_type: '',
    address_line1: '',
    city: '',
    state: '',
    postal_code: '',
    ...over,
  });

  it('plans a clean row as a creation', async () => {
    const plan = await planRosterImport('org-1', [row()]);
    expect(plan.counts).toEqual({ create: 1, skip_exists: 0, reject: 0 });
  });

  // pilot.athletes.dob is `date not null`, so a blank one is a row Postgres
  // will refuse. Caught in planning so the operator sees it in the preview
  // rather than as a failure after pressing the button.
  it('rejects a missing date of birth in the preview, not at insert time', async () => {
    const plan = await planRosterImport('org-1', [row({ date_of_birth: '' })]);
    expect(plan.counts.reject).toBe(1);
    expect(plan.rows[0].reason).toMatch(/date of birth/i);
  });

  it('rejects a date of birth a spreadsheet would write', async () => {
    const plan = await planRosterImport('org-1', [row({ date_of_birth: '3/14/12' })]);
    expect(plan.rows[0].outcome).toBe('reject');
    expect(plan.rows[0].reason).toMatch(/2012-03-14/);
  });

  it('rejects a gym status outside the vocabulary', async () => {
    const plan = await planRosterImport('org-1', [row({ gym_status: 'Active ' })]);
    // Trimmed by the parser in real use; here the raw value is invalid.
    expect(plan.rows[0].outcome).toBe('reject');
  });

  it('rejects the same athlete id appearing twice in one file', async () => {
    const plan = await planRosterImport('org-1', [row(), row({ full_name: 'Someone Else' })]);
    expect(plan.counts).toEqual({ create: 1, skip_exists: 0, reject: 1 });
    expect(plan.rows[1].reason).toMatch(/more than once/i);
  });

  // The most important one. An athlete already on the roster must be reported
  // and left alone -- an import that overwrote a child's name, date of birth
  // and coach assignment because a spreadsheet reused an id is the worst
  // outcome available here.
  it('never plans to overwrite an athlete already on the roster', async () => {
    mockQuery.mockResolvedValue([{ athlete_id: 'ath-1' }]);

    const plan = await planRosterImport('org-1', [row()]);

    expect(plan.counts).toEqual({ create: 0, skip_exists: 1, reject: 0 });
    expect(plan.rows[0].reason).toMatch(/left exactly as it is/i);
  });

  it('scopes the existing-athlete lookup to the caller gym', async () => {
    await planRosterImport('org-1', [row()]);
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', ['ath-1']]);
  });

  it('reports each row by its line number in the operator file', async () => {
    const plan = await planRosterImport('org-1', [
      row({ athlete_id: 'ath-1' }),
      row({ athlete_id: '', full_name: 'No Id' }),
      row({ athlete_id: 'ath-3' }),
    ]);
    expect(plan.rows.map((r) => r.line)).toEqual([1, 2, 3]);
    expect(plan.rows[1].outcome).toBe('reject');
  });

  // The real 30-row membership export this importer round-trips with: most
  // rows are Athlete, but the gym owner and other adults are Non-Athlete --
  // a member with no training record at all. None of the athlete-only
  // requirements apply to them.
  it('accepts a Non-Athlete row with no date of birth, weight class or gym status', async () => {
    const plan = await planRosterImport('org-1', [
      row({ athlete_id: 'mbr-1', date_of_birth: '', member_type: 'Non-Athlete' }),
    ]);
    expect(plan.counts).toEqual({ create: 1, skip_exists: 0, reject: 0 });
  });

  it('accepts the fitness-only membership categories from the real export', async () => {
    const plan = await planRosterImport('org-1', [
      row({ athlete_id: 'mbr-1', date_of_birth: '', member_type: 'Junior Fitness Non-Contact' }),
      row({ athlete_id: 'mbr-2', date_of_birth: '', member_type: 'Adult Fitness Non-Contact' }),
    ]);
    expect(plan.counts).toEqual({ create: 2, skip_exists: 0, reject: 0 });
  });

  it('rejects a membership type outside the known vocabulary', async () => {
    const plan = await planRosterImport('org-1', [row({ member_type: 'Board Member' })]);
    expect(plan.rows[0].outcome).toBe('reject');
    expect(plan.rows[0].reason).toMatch(/Non-Athlete/);
  });

  // A blank member_type column (every roster that predates this feature)
  // must keep meaning "Athlete" -- the athlete-only checks still apply.
  it('still requires a date of birth when member_type is blank', async () => {
    const plan = await planRosterImport('org-1', [row({ date_of_birth: '', member_type: '' })]);
    expect(plan.rows[0].outcome).toBe('reject');
    expect(plan.rows[0].reason).toMatch(/date of birth/i);
  });

  // A non-athlete member id must never be silently overwritten either --
  // the same "never overwrite" property the athlete path already has.
  it('never plans to overwrite a non-athlete member already on the roster', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('pilot.club_members')) {
        return Promise.resolve([{ member_id: 'mbr-1' }]);
      }
      return Promise.resolve([]);
    });

    const plan = await planRosterImport('org-1', [
      row({ athlete_id: 'mbr-1', date_of_birth: '', member_type: 'Non-Athlete' }),
    ]);

    expect(plan.counts).toEqual({ create: 0, skip_exists: 1, reject: 0 });
  });

  it('checks pilot.club_members for a collision in addition to pilot.athletes', async () => {
    await planRosterImport('org-1', [row()]);
    const queriedTables = mockQuery.mock.calls.map((call) => call[0] as string);
    expect(queriedTables.some((sql) => sql.includes('pilot.athletes'))).toBe(true);
    expect(queriedTables.some((sql) => sql.includes('pilot.club_members'))).toBe(true);
  });
});

describe('applyRosterImport', () => {
  const row = (over: Partial<Record<string, string>> = {}) => ({
    athlete_id: 'ath-1',
    full_name: 'A Name',
    date_of_birth: '2012-03-14',
    weight_class: '',
    gym_status: '',
    emergency_contact_note: '',
    coach_account_id: '',
    member_type: '',
    address_line1: '',
    city: '',
    state: '',
    postal_code: '',
    ...over,
  });

  it('creates the athlete only when the file has no membership/address data', async () => {
    const rows = [row()];
    const plan = await planRosterImport('org-1', rows);

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(mockInsertAthlete).toHaveBeenCalledTimes(1);
    expect(mockInsertClubMember).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ create: 1, skip_exists: 0, reject: 0 });
  });

  // membership_type does not belong on pilot.athletes -- it lives on
  // pilot.club_members, linked by athlete_id, for an Athlete-type row too.
  it('creates a linked club_members row for an Athlete row that carries an address', async () => {
    const rows = [row({ address_line1: '12 High St', city: 'Punxsutawney', state: 'PA', postal_code: '15767' })];
    const plan = await planRosterImport('org-1', rows);

    await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(mockInsertAthlete).toHaveBeenCalledTimes(1);
    expect(mockInsertClubMember).toHaveBeenCalledTimes(1);
    expect(mockInsertClubMember.mock.calls[0][1]).toMatchObject({
      member_id: 'ath-1',
      athlete_id: 'ath-1',
      full_name: null,
      membership_type: 'athlete',
      address_line1: '12 High St',
      city: 'Punxsutawney',
      state: 'PA',
      postal_code: '15767',
      created_by_account_id: 'admin-1',
    });
  });

  // The design's core case: an adult with a home address and no training
  // record at all -- e.g. the owner, listed Non-Athlete on the real roster.
  it('creates a club_members-only row for a Non-Athlete row, never touching pilot.athletes', async () => {
    const rows = [row({
      athlete_id: 'mbr-owner',
      full_name: 'Jason Neale',
      date_of_birth: '',
      member_type: 'Non-Athlete',
      address_line1: '1 Main St',
      city: 'Punxsutawney',
      state: 'PA',
      postal_code: '15767',
    })];
    const plan = await planRosterImport('org-1', rows);

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(mockInsertAthlete).not.toHaveBeenCalled();
    expect(mockInsertClubMember).toHaveBeenCalledTimes(1);
    expect(mockInsertClubMember.mock.calls[0][1]).toMatchObject({
      member_id: 'mbr-owner',
      athlete_id: null,
      full_name: 'Jason Neale',
      membership_type: 'non_athlete',
    });
    expect(result.counts).toEqual({ create: 1, skip_exists: 0, reject: 0 });
  });

  // Same race-lost honesty as the athlete path: planning said create, the
  // insert says otherwise, the outcome reported must be the true one.
  it('reports skip_exists when a non-athlete member insert loses a race', async () => {
    mockInsertClubMember.mockResolvedValue(false);
    const rows = [row({ athlete_id: 'mbr-1', date_of_birth: '', member_type: 'Non-Athlete' })];
    const plan = await planRosterImport('org-1', rows);

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(result.counts).toEqual({ create: 0, skip_exists: 1, reject: 0 });
  });

  it('never writes a club_members row for a legacy athlete-only file', async () => {
    const rows = [row(), row({ athlete_id: 'ath-2', full_name: 'Another' })];
    const plan = await planRosterImport('org-1', rows);

    await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(mockInsertClubMember).not.toHaveBeenCalled();
  });
});

// applyRosterImport batches every `create` row into one insert instead of
// one round trip per row (up to MAX_ROWS = 500), but must reproduce the
// original row-by-row semantics exactly: per-row error isolation, races
// lost against another writer reported as skip_exists, and file order
// preserved in the result.
describe('applyRosterImport', () => {
  const row = (over: Partial<RosterImportRow> = {}): RosterImportRow => ({
    athlete_id: 'ath-1',
    full_name: 'A Name',
    date_of_birth: '2012-03-14',
    weight_class: '',
    gym_status: '',
    emergency_contact_note: '',
    coach_account_id: '',
    // Blank member_type/address fields, matching a legacy roster that
    // predates the club_members columns entirely -- every row here is
    // batch-eligible (a plain athlete, per resolveMemberType's own
    // documented blank-means-athlete rule), which is what this whole
    // describe block exists to exercise.
    member_type: '',
    address_line1: '',
    city: '',
    state: '',
    postal_code: '',
    ...over,
  });

  const planned = (over: Partial<RosterRowPlan> = {}): RosterRowPlan => ({
    line: 1,
    athlete_id: 'ath-1',
    full_name: 'A Name',
    outcome: 'create',
    reason: '',
    ...over,
  });

  it('does nothing and calls neither query nor insertAthleteIfAbsent when there is nothing to create', async () => {
    const rows = [row({ athlete_id: '' })];
    const plan = { rows: [planned({ outcome: 'reject', reason: 'No athlete id.' })], counts: { create: 0, skip_exists: 0, reject: 1 } };

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(result.counts).toEqual({ create: 0, skip_exists: 0, reject: 1 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockInsertIfAbsent).not.toHaveBeenCalled();
  });

  it('a single creatable row goes straight through insertAthleteIfAbsent -- nothing to batch', async () => {
    mockInsertIfAbsent.mockResolvedValueOnce(true);
    const rows = [row()];
    const plan = { rows: [planned()], counts: { create: 1, skip_exists: 0, reject: 0 } };

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(result.rows[0]).toMatchObject({ outcome: 'create', reason: '' });
    expect(mockInsertIfAbsent).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('batches multiple creatable rows into ONE insert call, not one per row', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-2' }, { athlete_id: 'ath-3' }]);
    const rows = [row({ athlete_id: 'ath-1' }), row({ athlete_id: 'ath-2' }), row({ athlete_id: 'ath-3' })];
    const plan = {
      rows: [
        planned({ line: 1, athlete_id: 'ath-1' }),
        planned({ line: 2, athlete_id: 'ath-2' }),
        planned({ line: 3, athlete_id: 'ath-3' }),
      ],
      counts: { create: 3, skip_exists: 0, reject: 0 },
    };

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockInsertIfAbsent).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ create: 3, skip_exists: 0, reject: 0 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('on conflict (organization_id, athlete_id) do nothing');
    expect(params).toContain('ath-1');
    expect(params).toContain('ath-3');
  });

  it('a row the batch insert did not return (lost the race) reports skip_exists, not create', async () => {
    // Only ath-1 and ath-3 came back from RETURNING -- ath-2 was taken by
    // another writer between planning and this call.
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-3' }]);
    const rows = [row({ athlete_id: 'ath-1' }), row({ athlete_id: 'ath-2' }), row({ athlete_id: 'ath-3' })];
    const plan = {
      rows: [
        planned({ line: 1, athlete_id: 'ath-1' }),
        planned({ line: 2, athlete_id: 'ath-2' }),
        planned({ line: 3, athlete_id: 'ath-3' }),
      ],
      counts: { create: 3, skip_exists: 0, reject: 0 },
    };

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(result.counts).toEqual({ create: 2, skip_exists: 1, reject: 0 });
    const raced = result.rows.find((r) => r.athlete_id === 'ath-2');
    expect(raced).toMatchObject({ outcome: 'skip_exists' });
    expect(raced!.reason).toMatch(/left exactly as it is/i);
  });

  it('falls back to one insert per row when the batch statement itself fails, isolating the one bad row', async () => {
    mockQuery.mockRejectedValueOnce(new Error('insert or update on table "athletes" violates foreign key constraint'));
    mockInsertIfAbsent
      .mockResolvedValueOnce(true) // ath-1: fine
      .mockRejectedValueOnce(new Error('bad coach id')) // ath-2: the actual culprit
      .mockResolvedValueOnce(true); // ath-3: fine
    const rows = [row({ athlete_id: 'ath-1' }), row({ athlete_id: 'ath-2' }), row({ athlete_id: 'ath-3' })];
    const plan = {
      rows: [
        planned({ line: 1, athlete_id: 'ath-1' }),
        planned({ line: 2, athlete_id: 'ath-2' }),
        planned({ line: 3, athlete_id: 'ath-3' }),
      ],
      counts: { create: 3, skip_exists: 0, reject: 0 },
    };

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    // The failed batch is the ONE query call; recovery is per-row from there.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockInsertIfAbsent).toHaveBeenCalledTimes(3);
    expect(result.counts).toEqual({ create: 2, skip_exists: 0, reject: 1 });
    const failed = result.rows.find((r) => r.athlete_id === 'ath-2');
    expect(failed).toMatchObject({ outcome: 'reject', reason: 'bad coach id' });
    // The rows on either side of the bad one still landed -- the whole file
    // was not discarded for one row's sake.
    expect(result.rows.find((r) => r.athlete_id === 'ath-1')).toMatchObject({ outcome: 'create' });
    expect(result.rows.find((r) => r.athlete_id === 'ath-3')).toMatchObject({ outcome: 'create' });
  });

  it('preserves file order in the result, interleaving planning-time rejections with newly created rows', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-2' }, { athlete_id: 'ath-4' }]);
    const rows = [
      row({ athlete_id: '' }),
      row({ athlete_id: 'ath-2' }),
      row({ athlete_id: 'ath-2' }), // duplicate id in the file: rejected in planning
      row({ athlete_id: 'ath-4' }),
    ];
    const plan = {
      rows: [
        planned({ line: 1, athlete_id: '', outcome: 'reject', reason: 'No athlete id.' }),
        planned({ line: 2, athlete_id: 'ath-2' }),
        planned({ line: 3, athlete_id: 'ath-2', outcome: 'reject', reason: 'This athlete id appears more than once in the file.' }),
        planned({ line: 4, athlete_id: 'ath-4' }),
      ],
      counts: { create: 2, skip_exists: 0, reject: 2 },
    };

    const result = await applyRosterImport('org-1', rows, plan, 'admin-1');

    expect(result.rows.map((r) => r.line)).toEqual([1, 2, 3, 4]);
    expect(result.rows.map((r) => r.outcome)).toEqual(['reject', 'create', 'reject', 'create']);
  });
});
