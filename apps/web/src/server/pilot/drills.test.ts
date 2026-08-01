jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
}));

import {
  DrillNameTakenError,
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
