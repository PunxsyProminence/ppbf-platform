jest.mock('./db', () => {
  const query = jest.fn(async () => []);
  // A restore runs in a transaction: its client records every statement, in
  // order, and routes all but the lineage lock through `query`, so the tests
  // below read a restore's guarded UPDATE exactly where they always have.
  const transactionStatements: string[] = [];
  return {
    query,
    queryOne: jest.fn(async () => null),
    transactionStatements,
    withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
      query: async (text: string, params: unknown[]) => {
        transactionStatements.push(text);
        if (/\bfor update\b/i.test(text)) return { rows: [] };
        return { rows: await (query as jest.Mock)(text, params) };
      },
    })),
  };
});

import {
  DrillNameTakenError,
  DrillRestoreRefusedError,
  createDrill,
  getDrill,
  listDrills,
  updateDrill,
} from './drills';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

function drillRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    drill_id: 'drill-1',
    name: 'Straight Jab Retraction Snap',
    category: 'Striking',
    focus: 'Quick fist return to protect the chin.',
    cues: ['Elbow tucked'],
    difficulty: 'intermediate',
    active: true,
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

// The shape pg reports when pilot_drills_one_name_per_org refuses a write.
function uniqueViolation() {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'pilot_drills_one_name_per_org',
  });
}

// The statements are laid out across lines for reading; the assertions below
// are about what they say, so whitespace is collapsed before comparing.
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('listDrills', () => {
  test('reads one organization only, and leaves retired drills out of the library', async () => {
    mockQuery.mockResolvedValueOnce([drillRow()]);

    await listDrills('org-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('where organization_id = $1');
    expect(params).toEqual(['org-1', false]);
  });

  test('includes retired drills only when the caller asks for them', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listDrills('org-1', { includeRetired: true });

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', true]);
  });
});

describe('getDrill', () => {
  test('is scoped by organization, so another gym drill_id reads as absent', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const drill = await getDrill('org-1', 'drill-from-org-2');

    expect(drill).toBeNull();
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('where organization_id = $1 and drill_id = $2');
    expect(params).toEqual(['org-1', 'drill-from-org-2']);
  });
});

describe('createDrill', () => {
  test('a drill nobody wrote cues for is stored with no cues, not a null to render', async () => {
    mockQuery.mockResolvedValueOnce([drillRow({ cues: [] })]);

    const drill = await createDrill({
      organizationId: 'org-1',
      name: 'Stance Width Stability',
      category: 'Footwork',
      focus: 'Wide base under movement.',
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('org-1');
    expect(params[5]).toEqual([]);
    expect(params[6]).toBe('intermediate');
    expect(drill.cues).toEqual([]);
  });

  // Only the unique index can hold one-name-per-gym; a read-then-write check
  // loses that race. The caller has to be able to act on the index's refusal.
  test('turns the unique-name violation into an outcome the caller can report', async () => {
    mockQuery.mockRejectedValueOnce(uniqueViolation());

    await expect(
      createDrill({
        organizationId: 'org-1',
        name: 'Straight Jab Retraction Snap',
        category: 'Striking',
        focus: 'Quick fist return.',
      }),
    ).rejects.toBeInstanceOf(DrillNameTakenError);
  });

  test('any other database failure is left alone', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '57P01' }));

    await expect(
      createDrill({ organizationId: 'org-1', name: 'X', category: 'Y', focus: 'Z' }),
    ).rejects.not.toBeInstanceOf(DrillNameTakenError);
  });
});

describe('updateDrill', () => {
  test('writes only the fields the caller sent', async () => {
    mockQuery.mockResolvedValueOnce([drillRow({ cues: ['Elbow tucked', 'Snap on contact'] })]);

    await updateDrill({
      organizationId: 'org-1',
      drillId: 'drill-1',
      cues: ['Elbow tucked', 'Snap on contact'],
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('cues = $3::text[]');
    expect(sql).not.toContain('focus =');
    expect(sql).not.toContain('name =');
    expect(params).toEqual(['org-1', 'drill-1', ['Elbow tucked', 'Snap on contact']]);
  });

  test('retiring keeps the drill and only takes it out of the library', async () => {
    mockQuery.mockResolvedValueOnce([drillRow({ active: false })]);

    const drill = await updateDrill({ organizationId: 'org-1', drillId: 'drill-1', active: false });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('update pilot.drills');
    expect(sql).not.toContain('delete');
    expect(params).toEqual(['org-1', 'drill-1', false]);
    expect(drill?.active).toBe(false);
  });

  // A no-op update that reported success would tell a coach their edit landed.
  test('refuses an update that names no field', async () => {
    await expect(updateDrill({ organizationId: 'org-1', drillId: 'drill-1' })).rejects.toThrow(/Missing/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('reports a miss rather than a silent success', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const drill = await updateDrill({ organizationId: 'org-1', drillId: 'drill-missing', active: false });

    expect(drill).toBeNull();
  });

  test('renaming onto a name the gym already uses is refused the same way', async () => {
    mockQuery.mockRejectedValueOnce(uniqueViolation());

    await expect(
      updateDrill({ organizationId: 'org-1', drillId: 'drill-1', name: 'Slip and Lateral Pivot Step' }),
    ).rejects.toBeInstanceOf(DrillNameTakenError);
  });
});

/**
 * W-D4C. Restore brings back the same operational identity -- the retired
 * lineage's newest version -- and nothing else. The rule is held in the UPDATE's
 * own WHERE clause so no concurrent write can land between a check and the
 * change; these tests pin where the rule is written and what happens when it
 * refuses. Whether Postgres then applies it to real rows is the pg suite's job.
 */
describe('updateDrill: a restore locks the lineage before its guard reads it', () => {
  const db = jest.requireMock('./db') as { transactionStatements: string[]; withTransaction: jest.Mock };
  const flatten = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  beforeEach(() => {
    db.transactionStatements.length = 0;
  });

  test('in one transaction: first the lock on every version of the lineage, then the guarded UPDATE', async () => {
    mockQuery.mockResolvedValueOnce([drillRow()]);

    await updateDrill({ organizationId: 'org-1', drillId: 'drill-1', active: true });

    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(db.transactionStatements.map(flatten)).toEqual([
      'select 1 from pilot.drills l where l.organization_id = $1 and l.lineage_id = ( '
        + 'select d.lineage_id from pilot.drills d where d.organization_id = $1 and d.drill_id = $2 ) for update',
      expect.stringMatching(/^update pilot\.drills d set active = \$3, updated_at = now\(\) where d\.organization_id = \$1 and d\.drill_id = \$2 and \( d\.active or/),
    ]);
  });

  test.each([
    ['a retire', { active: false }],
    ['an edit', { name: 'Renamed' }],
  ] as const)('%s takes no lineage lock and opens no transaction', async (_case, change) => {
    mockQuery.mockResolvedValueOnce([drillRow()]);

    await updateDrill({ organizationId: 'org-1', drillId: 'drill-1', ...change });

    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(db.transactionStatements).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('updateDrill: the restore guard', () => {
  const GUARD_ACTIVE_OR_LATEST =
    'where d.organization_id = $1 and d.drill_id = $2 and ( d.active or ( d.version = ( '
    + 'select max(l.version) from pilot.drills l '
    + 'where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id )';
  const GUARD_NO_ACTIVE_VERSION =
    'and not exists ( select 1 from pilot.drills l '
    + 'where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id and l.active )';
  const GUARD_REFERENCE_STILL_ACTIVE =
    'and ( d.reference_drill_id is null or exists ( select 1 from pilot.drill_library r '
    + 'where r.organization_id = d.organization_id and r.drill_id = d.reference_drill_id and r.active ) ) ) )';
  const RETURNING =
    'returning d.organization_id, d.drill_id, d.name, d.category, d.focus, d.cues, d.difficulty, '
    + 'd.active, d.created_at, d.updated_at, d.reference_drill_id';

  // The guard's subqueries name pilot.drills again (as l), so the row being
  // updated has to be named unambiguously everywhere the statement refers to it.
  test('the statement names the updated row d, in the target, the WHERE and the RETURNING', async () => {
    mockQuery.mockResolvedValueOnce([drillRow({ name: 'Renamed' })]);

    await updateDrill({ organizationId: 'org-1', drillId: 'drill-1', name: 'Renamed' });

    const sql = flat(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/^update pilot\.drills d set /);
    expect(sql).toContain('where d.organization_id = $1 and d.drill_id = $2');
    expect(sql.endsWith(RETURNING)).toBe(true);
  });

  test('a restore carries the whole guard in its WHERE clause, and adds no parameters', async () => {
    mockQuery.mockResolvedValueOnce([drillRow({ active: true })]);

    const drill = await updateDrill({ organizationId: 'org-1', drillId: 'drill-1', active: true });

    const [rawSql, params] = mockQuery.mock.calls[0];
    const sql = flat(rawSql);
    // Newest version of the lineage (or already active, which is an ordinary edit)...
    expect(sql).toContain(GUARD_ACTIVE_OR_LATEST);
    // ...with no version of that lineage active...
    expect(sql).toContain(GUARD_NO_ACTIVE_VERSION);
    // ...and a reference, if it has one, that has not been withdrawn.
    expect(sql).toContain(GUARD_REFERENCE_STILL_ACTIVE);
    // In the WHERE, before RETURNING -- not a read somewhere else.
    expect(sql.indexOf(GUARD_REFERENCE_STILL_ACTIVE)).toBeLessThan(sql.indexOf('returning '));
    expect(sql.endsWith(RETURNING)).toBe(true);
    expect(params).toEqual(['org-1', 'drill-1', true]);
    // It landed, so there is nothing to explain and no refusal read.
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(drill?.active).toBe(true);
  });

  // Retiring is always allowed, and an edit that does not touch `active` is not
  // a restore -- guarding either would refuse edits the lifecycle permits.
  test.each([
    ['a retire (active: false)', { active: false }],
    ['an edit that does not send active', { focus: 'Snap the fist back to the chin.' }],
  ] as const)('%s carries no guard', async (_label, fields) => {
    mockQuery.mockResolvedValueOnce([drillRow()]);

    await updateDrill({ organizationId: 'org-1', drillId: 'drill-1', ...fields });

    const sql = flat(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('where d.organization_id = $1 and d.drill_id = $2 returning ');
    expect(sql).not.toContain('lineage_id');
    expect(sql).not.toContain('max(');
    expect(sql).not.toContain('drill_library');
  });

  test('a retire that matches no row is a miss, and never asks why', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const drill = await updateDrill({ organizationId: 'org-1', drillId: 'drill-missing', active: false });

    expect(drill).toBeNull();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  describe('a restore the guard refuses', () => {
    test('reads the drill\'s lineage state, scoped to this organization', async () => {
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce({ latest: false, lineage_active: false, reference_withdrawn: false });

      await expect(
        updateDrill({ organizationId: 'org-1', drillId: 'drill-1', active: true }),
      ).rejects.toBeInstanceOf(DrillRestoreRefusedError);

      expect(mockQueryOne).toHaveBeenCalledTimes(1);
      const [rawSql, params] = mockQueryOne.mock.calls[0];
      const sql = flat(rawSql);
      expect(params).toEqual(['org-1', 'drill-1']);
      expect(sql).toContain('from pilot.drills d where d.organization_id = $1 and d.drill_id = $2');
      // The same three rules the guard holds, read back so the refusal can be named.
      expect(sql).toContain(
        'd.version = ( select max(l.version) from pilot.drills l '
        + 'where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id ) as latest',
      );
      expect(sql).toContain(
        'exists ( select 1 from pilot.drills l '
        + 'where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id and l.active ) as lineage_active',
      );
      expect(sql).toContain(
        '( d.reference_drill_id is not null and not exists ( select 1 from pilot.drill_library r '
        + 'where r.organization_id = d.organization_id and r.drill_id = d.reference_drill_id and r.active ) ) '
        + 'as reference_withdrawn',
      );
    });

    // Each state is read with every LATER rule also failing, so the reason
    // reported is the first rule in order -- an earlier version is told to use
    // the newest one even if that newest one is itself blocked.
    test.each([
      [
        'an earlier version',
        'not_latest_version',
        { latest: false, lineage_active: true, reference_withdrawn: true },
        'This is an earlier version of the drill. Restore its newest version instead.',
      ],
      [
        'a lineage that already has an active version',
        'another_version_active',
        { latest: true, lineage_active: true, reference_withdrawn: true },
        'Another version of this drill is already in use in this gym.',
      ],
      [
        'a drill whose reference was withdrawn',
        'reference_withdrawn',
        { latest: true, lineage_active: false, reference_withdrawn: true },
        "This drill's reference has been withdrawn, so it cannot be restored.",
      ],
    ] as const)('%s is refused as %s', async (_label, reason, state, message) => {
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce(state);

      const outcome = updateDrill({ organizationId: 'org-1', drillId: 'drill-1', active: true });

      await expect(outcome).rejects.toBeInstanceOf(DrillRestoreRefusedError);
      await expect(outcome).rejects.toMatchObject({ reason, message });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    // W-D4C round-1 repair R2. The guarded write refused, yet the read that
    // follows finds the drill with every rule clear: its state moved between
    // the two statements. Before the repair this fell through to `return null`
    // and the route answered 404 for a drill that plainly exists -- telling the
    // coach it was gone when a reload and a retry would have worked. It is a
    // conflict with a reason of its own now, and the message says what to do.
    test('a drill the read finds with nothing refusing it is refused as state_changed, not reported missing', async () => {
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce({ latest: true, lineage_active: false, reference_withdrawn: false });

      const outcome = updateDrill({ organizationId: 'org-1', drillId: 'drill-1', active: true });

      await expect(outcome).rejects.toBeInstanceOf(DrillRestoreRefusedError);
      await expect(outcome).rejects.toMatchObject({
        name: 'DrillRestoreRefusedError',
        reason: 'state_changed',
        message: 'This drill changed while it was being restored. Reload the page and try again.',
      });
      // One guarded write and one read, scoped to this gym. The refusal does
      // not quietly retry the write on the coach's behalf.
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
      expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'drill-1']);
    });

    // Another gym's drill, or a drill that does not exist, gives the refusal
    // read nothing to explain: that is still a miss, reported as before.
    test('a restore of a drill the read cannot find is a miss, not a refusal', async () => {
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce(null);

      const drill = await updateDrill({ organizationId: 'org-1', drillId: 'drill-from-org-2', active: true });

      expect(drill).toBeNull();
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
      expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'drill-from-org-2']);
    });
  });

  describe('a name collision', () => {
    // A restore sends no name. If the retired drill's name has since been
    // given to another drill, the coach has to be told WHICH name -- not
    // 'This gym already has a drill named ""'.
    test('on a restore without a name reports the drill\'s own name, read from this gym', async () => {
      mockQuery.mockRejectedValueOnce(uniqueViolation());
      mockQueryOne.mockResolvedValueOnce(drillRow({ name: 'Slip and Lateral Pivot Step', active: false }));

      const outcome = updateDrill({ organizationId: 'org-1', drillId: 'drill-1', active: true });

      await expect(outcome).rejects.toBeInstanceOf(DrillNameTakenError);
      await expect(outcome).rejects.toMatchObject({
        drillName: 'Slip and Lateral Pivot Step',
        message: 'This gym already has a drill named "Slip and Lateral Pivot Step"',
      });
      // The name comes from getDrill -- organization-scoped -- and a write the
      // index refused never goes on to the restore-refusal read.
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQueryOne.mock.calls[0];
      expect(flat(sql)).toContain('from pilot.drills where organization_id = $1 and drill_id = $2');
      expect(params).toEqual(['org-1', 'drill-1']);
    });

    test('on a rename reports the name that was sent, without a read', async () => {
      mockQuery.mockRejectedValueOnce(uniqueViolation());

      await expect(
        updateDrill({ organizationId: 'org-1', drillId: 'drill-1', name: 'Slip and Lateral Pivot Step' }),
      ).rejects.toMatchObject({ drillName: 'Slip and Lateral Pivot Step' });
      expect(mockQueryOne).not.toHaveBeenCalled();
    });
  });
});
