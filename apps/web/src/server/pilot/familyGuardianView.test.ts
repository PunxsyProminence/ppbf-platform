import type { PilotRole } from './contracts';
import { query } from './db';
import {
  GUARDIAN_FAMILY_COLUMNS,
  GUARDIAN_WITHHELD_FROM_FAMILY_COLUMNS,
  WAIVER_FAMILY_COLUMNS,
  listFamilyGuardians,
  listFamilyWaivers,
  readsStaffGuardianRows,
  resolveFamilyReader,
  toFamilyGuardians,
  toFamilyWaivers,
} from './familyGuardianView';
import { WAIVER_IDENTITY_COLUMNS, WAIVER_STAFF_COLUMNS } from './intake';

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

/* The rows carry MORE than the family may have -- a record id, an account id,
   a phone -- although the real query never selects them. A projection that
   spread its row, or copied one extra key, hands them straight through, and
   every assertion below is equality on the whole object so that it would show. */
const OWN = {
  you: true, full_name: 'Guardian One', relationship_to_athlete: 'mother',
  parent_id: 'par-guardian.one@example.test', account_id: 'guardian.one@example.test', phone: '555-0100',
};
const OTHER = {
  you: false, full_name: 'Guardian Two', relationship_to_athlete: 'father',
  parent_id: 'par-guardian.two@example.test', account_id: 'guardian.two@example.test', phone: '555-0200',
};

const NON_STAFF_NON_ATHLETE: Array<PilotRole | null> = ['parent', 'volunteer', 'staff', 'board', 'platform_owner', null];

describe('readsStaffGuardianRows', () => {
  test('coach and organization admin read the storage columns; nobody else, and no unnamed reader', () => {
    expect((['coach', 'organization_admin', 'admin'] as PilotRole[]).map(readsStaffGuardianRows)).toEqual([true, true, true]);
    for (const role of ['athlete', ...NON_STAFF_NON_ATHLETE] as Array<PilotRole | null>) {
      expect(readsStaffGuardianRows(role)).toBe(false);
    }
  });
});

describe('resolveFamilyReader', () => {
  test('a parent is asked which guardian records their own account backs, in their own organization', async () => {
    mockQuery.mockResolvedValue([{ parent_id: 'par-one' }, { parent_id: 'par-one-second-child' }]);

    const reader = await resolveFamilyReader('org-1', 'parent', 'guardian.one@example.test');

    expect(reader).toEqual({ role: 'parent', ownParentIds: ['par-one', 'par-one-second-child'] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('from pilot.parents where organization_id = $1 and account_id = $2');
    expect(params).toEqual(['org-1', 'guardian.one@example.test']);
  });

  test.each([
    ['athlete', 'acct-athlete'],
    ['volunteer', 'acct-volunteer'],
    ['coach', 'acct-coach'],
    [null, null],
    ['parent', null],
  ] as Array<[PilotRole | null, string | null]>)('%s (account %s) has no guardian row of their own, and nothing is read', async (role, accountId) => {
    expect(await resolveFamilyReader('org-1', role, accountId)).toEqual({ role, ownParentIds: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('toFamilyGuardians', () => {
  test('a parent receives their own row by name, marked you, and of the co-guardian only the relationship', () => {
    expect(toFamilyGuardians([OWN, OTHER], 'parent')).toEqual([
      { you: true, full_name: 'Guardian One', relationship_to_athlete: 'mother' },
      { you: false, relationship_to_athlete: 'father' },
    ]);
  });

  test('the athlete receives each guardian by name and relationship, with no id and no you flag', () => {
    expect(toFamilyGuardians([OWN, OTHER], 'athlete')).toEqual([
      { full_name: 'Guardian One', relationship_to_athlete: 'mother' },
      { full_name: 'Guardian Two', relationship_to_athlete: 'father' },
    ]);
  });

  test.each(NON_STAFF_NON_ATHLETE)('any other reader (%s) is treated as a parent: a name only on a row that is theirs', (role) => {
    expect(toFamilyGuardians([OTHER], role)).toEqual([{ you: false, relationship_to_athlete: 'father' }]);
  });

  test('a row whose you flag is anything but true is not the reader\'s own', () => {
    for (const you of [null, undefined, 'true', 1]) {
      expect(toFamilyGuardians([{ ...OWN, you: you as never }], 'parent')).toEqual([
        { you: false, relationship_to_athlete: 'mother' },
      ]);
    }
  });

  /* THE PIN (#1558 done-when). A field added to a family guardian is a
     decision: it has to change this list, in a test that says why. */
  test('the family guardian carries exactly the decided fields, whatever the row grows', () => {
    const keys = new Set<string>();
    for (const role of ['athlete', 'parent', null] as Array<PilotRole | null>) {
      for (const view of toFamilyGuardians([OWN, OTHER], role)) {
        Object.keys(view).forEach((key) => keys.add(key));
      }
    }
    expect([...keys].sort()).toEqual(['full_name', 'relationship_to_athlete', 'you']);
    expect([...GUARDIAN_FAMILY_COLUMNS]).toEqual(['full_name', 'relationship_to_athlete']);
    for (const column of GUARDIAN_WITHHELD_FROM_FAMILY_COLUMNS) {
      expect(keys.has(column)).toBe(false);
      expect(GUARDIAN_FAMILY_COLUMNS as readonly string[]).not.toContain(column);
    }
  });
});

describe('listFamilyGuardians', () => {
  test('selects no guardian id and no account id, and answers "is it mine" in SQL from the reader\'s own guardian records', async () => {
    mockQuery.mockResolvedValue([OWN, OTHER]);

    const result = await listFamilyGuardians('org-1', 'ath-1', { role: 'parent', ownParentIds: ['par-one'] });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const selectList = (/select\s+([\s\S]*?)\s+from\s/i.exec(sql)?.[1] ?? '')
      .split(',').map((column) => column.trim().replace(/\s+/g, ' '));
    expect(selectList).toEqual([
      '(g.parent_id = any($3::text[])) as you',
      'p.full_name',
      'g.relationship_to_athlete',
    ]);
    expect(sql).toContain('where g.organization_id = $1 and g.athlete_id = $2');
    // The WHOLE statement, by equality: a column slipped into the select list,
    // or an ORDER BY on a name or an id the reader is not sent, fails here.
    expect(sql.replace(/\s+/g, ' ').trim()).toBe(
      'select (g.parent_id = any($3::text[])) as you, p.full_name, g.relationship_to_athlete '
      + 'from pilot.guardian_links g join pilot.parents p on p.organization_id = g.organization_id and p.parent_id = g.parent_id '
      + 'where g.organization_id = $1 and g.athlete_id = $2 '
      + 'order by you desc, g.relationship_to_athlete asc, g.created_at asc',
    );
    expect(params).toEqual(['org-1', 'ath-1', ['par-one']]);
    expect(JSON.stringify(result)).not.toContain('par-');
    expect(JSON.stringify(result)).not.toContain('Guardian Two');
  });

  test('a reader with no guardian record of their own matches no row', async () => {
    mockQuery.mockResolvedValue([]);
    await listFamilyGuardians('org-1', 'ath-1', { role: null, ownParentIds: [] });
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['org-1', 'ath-1', []]);
  });
});

const WAIVER = {
  waiver_id: 'w-1', athlete_id: 'ath-1', waiver_type: 'photo_media', signed_by_name: 'Guardian Two',
  signed_by_role: 'parent', signed_at: '2026-08-01T00:00:00Z', consent_version: 'v1', status: 'signed',
  covers_video: false, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  you: false, latest_of_signer: true,
  // Never selected for a family reader; here so a spread would show.
  parent_id: 'par-guardian.two@example.test', organization_id: 'org-1', notes: 'staff note', recorded_by_account_id: 'coach@example.test',
};
const DETAIL = {
  waiver_id: 'w-1', athlete_id: 'ath-1', waiver_type: 'photo_media', signed_by_name: 'Guardian Two', signed_by_role: 'parent',
  signed_at: '2026-08-01T00:00:00Z', consent_version: 'v1', status: 'signed', covers_video: false,
  public_use_allowed: false, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

describe('toFamilyWaivers', () => {
  test('a parent reads their own waiver whole, marked you', () => {
    expect(toFamilyWaivers([{ ...WAIVER, you: true }], 'parent')).toEqual([{ you: true, ...DETAIL }]);
  });

  // OD-2026-10-05-024 item 4: the other guardian's consent status, nothing more.
  test('a parent reads of a waiver that is not theirs its type and status only', () => {
    expect(toFamilyWaivers([WAIVER], 'parent')).toEqual([
      { you: false, waiver_type: 'photo_media', status: 'signed' },
    ]);
  });

  test('a parent keeps every row of their own history, and only the current status of anyone else\'s', () => {
    const rows = [
      { ...WAIVER, waiver_id: 'other-new', status: 'withdrawn', latest_of_signer: true },
      { ...WAIVER, waiver_id: 'own-new', status: 'signed', you: true, latest_of_signer: true },
      { ...WAIVER, waiver_id: 'other-old', status: 'signed', latest_of_signer: false },
      { ...WAIVER, waiver_id: 'own-old', status: 'declined', you: true, latest_of_signer: false },
      { ...WAIVER, waiver_id: 'paper', waiver_type: 'general', status: 'signed', latest_of_signer: true },
    ];

    // Own rows first, in the order read; then the others by type -- not
    // interleaved by date, so nothing dates the other guardian's decision.
    expect(toFamilyWaivers(rows, 'parent')).toEqual([
      { you: true, ...DETAIL, waiver_id: 'own-new', status: 'signed' },
      { you: true, ...DETAIL, waiver_id: 'own-old', status: 'declined' },
      { you: false, waiver_type: 'general', status: 'signed' },
      { you: false, waiver_type: 'photo_media', status: 'withdrawn' },
    ]);
  });

  test('a row that does not say it is the newest of its signer is not sent to a parent', () => {
    for (const latest of [false, null, undefined, 'true', 1]) {
      expect(toFamilyWaivers([{ ...WAIVER, latest_of_signer: latest as never }], 'parent')).toEqual([]);
    }
  });

  test('a row whose you flag is anything but true is not the reader\'s own', () => {
    for (const you of [null, undefined, 'true', 1]) {
      expect(toFamilyWaivers([{ ...WAIVER, you: you as never }], 'parent')).toEqual([
        { you: false, waiver_type: 'photo_media', status: 'signed' },
      ]);
    }
  });

  test('the athlete reads every waiver, history included, by the name it was signed under and with no guardian id', () => {
    expect(toFamilyWaivers([WAIVER, { ...WAIVER, waiver_id: 'w-0', latest_of_signer: false }], 'athlete')).toEqual([
      DETAIL,
      { ...DETAIL, waiver_id: 'w-0' },
    ]);
  });

  test.each(NON_STAFF_NON_ATHLETE)('any other reader (%s) is read as a parent with no row of their own', (role) => {
    expect(toFamilyWaivers([WAIVER], role)).toEqual([{ you: false, waiver_type: 'photo_media', status: 'signed' }]);
  });

  /* THE PIN, for waivers. */
  test('the family waiver carries exactly the decided fields: no parent_id, organization_id or staff column', () => {
    const keys = new Set<string>();
    for (const role of ['athlete', 'parent'] as PilotRole[]) {
      for (const you of [true, false]) {
        Object.keys(toFamilyWaivers([{ ...WAIVER, you }], role)[0]).forEach((key) => keys.add(key));
      }
    }
    expect([...keys].sort()).toEqual([...WAIVER_FAMILY_COLUMNS, 'you'].sort());
    expect([...WAIVER_FAMILY_COLUMNS]).toEqual([
      'waiver_id', 'athlete_id', 'waiver_type', 'signed_by_name', 'signed_by_role', 'signed_at',
      'consent_version', 'status', 'covers_video', 'public_use_allowed', 'created_at', 'updated_at',
    ]);
    // Every family column is one staff already read as identity; none is a staff column.
    for (const column of WAIVER_FAMILY_COLUMNS) {
      expect(WAIVER_IDENTITY_COLUMNS as readonly string[]).toContain(column);
      expect(WAIVER_STAFF_COLUMNS as readonly string[]).not.toContain(column);
    }
  });
});

describe('listFamilyWaivers', () => {
  test('selects the family columns and two booleans; parent_id is compared, never returned', async () => {
    mockQuery.mockResolvedValue([]);

    await listFamilyWaivers('org-1', 'ath-1', { role: 'parent', ownParentIds: ['par-one'] });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ').trim();
    // The WHOLE statement, by equality: exactly the family columns and the two
    // booleans. parent_id appears only inside a comparison and the window.
    expect(flat).toBe(
      `select ${WAIVER_FAMILY_COLUMNS.map((c) => `w.${c}`).join(', ')}, `
      + '(w.parent_id = any($3::text[])) is true as you, '
      + '(row_number() over ( partition by w.parent_id, w.waiver_type order by w.created_at desc, w.waiver_id desc ) = 1) as latest_of_signer '
      + 'from pilot.waivers w where w.organization_id = $1 and w.athlete_id = $2 order by w.created_at desc',
    );
    expect(params).toEqual(['org-1', 'ath-1', ['par-one']]);
  });
});
