import { buildRosterCsv } from '@/app/api/pilot/admin/export/roster/csv';
import { parseCsv, parseRosterCsv, planRosterImport } from './rosterImport';
import { query } from './db';

jest.mock('./db', () => ({ query: jest.fn() }));
jest.mock('./entities', () => ({ insertAthleteIfAbsent: jest.fn() }));

const mockQuery = query as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  mockQuery.mockResolvedValue([]);
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
});
