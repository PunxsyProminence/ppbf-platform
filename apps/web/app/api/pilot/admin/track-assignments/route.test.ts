// Track assignments are per athlete of one gym. Three things are pinned here:
//   who may reach the route (the gym's admin; not the platform owner,
//     OD-2026-10-08-003 R2);
//   what the route will store (live athletes of the caller's gym and known
//     track ids, or nothing at all; OD-2026-10-07-010 ruling 3 -- tracks are
//     for real athletes);
//   that every stored change leaves an audit record with a before and after.

import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';

// requireRole (access.ts) and jsonError stay real.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

const URL_BASE = 'http://localhost/api/pilot/admin/track-assignments';

function as(role: string, organizationId = 'org-1') {
  mockPrincipal.mockResolvedValue({ accountId: `${role}-1`, organizationId, role } as never);
}

function get() {
  return new NextRequest(URL_BASE);
}

function post(body: unknown) {
  return new NextRequest(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The gym has these live athletes; the lookup returns whichever of them were asked about. */
function gymHasAthletes(...athleteIds: string[]) {
  mockQuery.mockImplementation(async (_sql: string, params: [string, string[]]) =>
    params[1].filter((id) => athleteIds.includes(id)).map((athlete_id) => ({ athlete_id })));
}

function upsertCalls() {
  return mockQueryOne.mock.calls.filter(([sql]) => /insert into pilot\.admin_track_assignments/.test(sql));
}

beforeEach(() => {
  jest.resetAllMocks();
  as('organization_admin');
  gymHasAthletes('ath-1', 'ath-2');
  mockQueryOne.mockResolvedValue({ assignments: {}, previous_assignments: null });
  mockAudit.mockResolvedValue(undefined as never);
});

describe('platform owner is kept off track assignments', () => {
  test('GET is refused before anything is read', async () => {
    as('platform_owner');

    const response = await GET(get());

    expect(response.status).toBe(403);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('POST is refused before anything is read, written or audited', async () => {
    as('platform_owner');

    const response = await POST(post({ assignments: { 'ath-1': ['non_contact'] } }));

    expect(response.status).toBe(403);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// Unchanged by this lane: a coach was never on this list.
test.each(['coach', 'athlete', 'parent', 'board'])('role %s is refused on both verbs', async (role) => {
  as(role);

  expect((await GET(get())).status).toBe(403);
  expect((await POST(post({ assignments: {} }))).status).toBe(403);
  expect(mockQueryOne).not.toHaveBeenCalled();
});

describe.each(['organization_admin', 'admin'])('the gym admin (%s)', (role) => {
  test('reads the gym\'s assignments', async () => {
    as(role);
    mockQueryOne.mockResolvedValueOnce({ assignments: { 'ath-1': ['non_contact', 'usa_boxing'] } });

    const response = await GET(get());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      assignments: { 'ath-1': ['non_contact', 'usa_boxing'] },
    });
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1']);
  });

  test('saves a map of real athletes to known tracks', async () => {
    as(role);

    const response = await POST(post({ assignments: { 'ath-1': ['non_contact'], 'ath-2': ['pro', 'a2p'] } }));

    expect(response.status).toBe(200);
    expect(upsertCalls()).toHaveLength(1);
    expect(upsertCalls()[0][1]).toEqual([
      'org-1',
      JSON.stringify({ 'ath-1': ['non_contact'], 'ath-2': ['pro', 'a2p'] }),
      `${role}-1`,
    ]);
  });
});

describe('GET shows only rows for athletes the gym has today', () => {
  test('a stored row for an invented or deleted athlete is left out', async () => {
    mockQueryOne.mockResolvedValueOnce({
      assignments: { 'ath-1': ['pro'], 'athlete-001': ['non_contact'], 'ath-gone': ['a2p'] },
    });

    const response = await GET(get());

    await expect(response.json()).resolves.toEqual({ ok: true, assignments: { 'ath-1': ['pro'] } });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/from pilot\.athletes\s+where organization_id = \$1\s+and athlete_id = any\(\$2::text\[\]\)\s+and deleted_at is null/);
    expect(params).toEqual(['org-1', ['ath-1', 'athlete-001', 'ath-gone']]);
  });

  test('no stored row answers an empty map without an athlete lookup', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const response = await GET(get());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, assignments: {} });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('POST refuses anything that is not a real athlete with known tracks', () => {
  async function expectRefused(body: unknown) {
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    expect(upsertCalls()).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
    return response;
  }

  test('an athlete id that is not in this gym: nothing is saved, not even the valid rows', async () => {
    const response = await expectRefused({
      assignments: { 'ath-1': ['non_contact'], 'athlete-001': ['non_contact'] },
    });

    await expect(response.json()).resolves.toEqual({
      error: 'Unsupported assignments: 1 athlete id(s) are not athletes of this gym. Nothing was saved.',
    });
  });

  test('the athlete lookup is scoped to the caller\'s gym and to live athletes', async () => {
    as('organization_admin', 'org-2');

    await POST(post({ assignments: { 'ath-1': ['non_contact'] } }));

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/where organization_id = \$1\s+and athlete_id = any\(\$2::text\[\]\)\s+and deleted_at is null/);
    expect(params).toEqual(['org-2', ['ath-1']]);
  });

  test('an athlete of ANOTHER gym is not one of this gym\'s', async () => {
    // The lookup is by the caller's organization, so the other gym's athlete
    // is simply not returned.
    gymHasAthletes('ath-1');

    await expectRefused({ assignments: { 'other-gym-athlete': ['non_contact'] } });
  });

  test.each([
    ['an unknown track id', { assignments: { 'ath-1': ['non_contact', 'heavyweight_champion'] } }],
    ['a non-string track', { assignments: { 'ath-1': [7] } }],
    ['tracks that are not a list', { assignments: { 'ath-1': 'non_contact' } }],
    ['a blank athlete id', { assignments: { ' ': ['non_contact'] } }],
    ['a padded athlete id', { assignments: { ' ath-1': ['non_contact'] } }],
    ['assignments as a list', { assignments: [['ath-1', ['non_contact']]] }],
    ['assignments as a string', { assignments: 'ath-1' }],
    ['no assignments key', {}],
    ['a body that is not JSON', 'not json'],
    ['a null body', null],
  ])('%s is a 400 before any lookup or write', async (_name, body) => {
    await expectRefused(body);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('more athletes than the cap is a 400 before any lookup', async () => {
    const assignments = Object.fromEntries(
      Array.from({ length: 2001 }, (_, index) => [`ath-${index}`, ['non_contact']]),
    );

    await expectRefused({ assignments });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('an empty map is a real save: it clears the gym\'s assignments', async () => {
    const response = await POST(post({ assignments: {} }));

    expect(response.status).toBe(200);
    expect(upsertCalls()[0][1][1]).toBe('{}');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a track listed twice is stored once', async () => {
    await POST(post({ assignments: { 'ath-1': ['pro', 'pro'] } }));

    expect(upsertCalls()[0][1][1]).toBe(JSON.stringify({ 'ath-1': ['pro'] }));
  });
});

describe('every stored change is audited with a before and after', () => {
  test('the audit row names the gym, the actor, and what changed', async () => {
    mockQueryOne.mockResolvedValueOnce({
      previous_assignments: { 'ath-1': ['non_contact'], 'ath-2': ['pro'] },
    });

    await POST(post({ assignments: { 'ath-1': ['usa_boxing'], 'ath-2': ['pro'] } }));

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith({
      event_type: 'update',
      actor_account_id: 'organization_admin-1',
      actor_role: 'organization_admin',
      organization_id: 'org-1',
      entity_type: 'admin_track_assignments',
      entity_id: 'org-1',
      details: {
        action: 'track_assignments_replaced',
        changed_athlete_ids: ['ath-1'],
        from: { 'ath-1': ['non_contact'], 'ath-2': ['pro'] },
        to: { 'ath-1': ['usa_boxing'], 'ath-2': ['pro'] },
      },
    });
  });

  test('the before-state comes from the statement that overwrote it', async () => {
    await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    const [sql] = upsertCalls()[0];
    expect(sql).toMatch(/with previous as \(\s*select assignments\s+from pilot\.admin_track_assignments\s+where organization_id = \$1/);
    expect(sql).toMatch(/returning \(select assignments from previous\) as previous_assignments/);
    // One read-and-write statement, and no separate read before it.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('a first save records an empty before', async () => {
    mockQueryOne.mockResolvedValueOnce({ previous_assignments: null });

    await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ from: {}, to: { 'ath-1': ['pro'] }, changed_athlete_ids: ['ath-1'] }),
    }));
  });

  test('a removed athlete and an added athlete are both named as changed', async () => {
    mockQueryOne.mockResolvedValueOnce({ previous_assignments: { 'ath-1': ['pro'] } });

    await POST(post({ assignments: { 'ath-2': ['pro'] } }));

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ changed_athlete_ids: ['ath-1', 'ath-2'] }),
    }));
  });

  test('the same tracks in another order are not a change to that athlete', async () => {
    mockQueryOne.mockResolvedValueOnce({ previous_assignments: { 'ath-1': ['pro', 'a2p'] } });

    await POST(post({ assignments: { 'ath-1': ['a2p', 'pro'] } }));

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ changed_athlete_ids: [] }),
    }));
  });

  test('the audit is written after the write, never before', async () => {
    const order: string[] = [];
    mockQueryOne.mockImplementation(async () => { order.push('write'); return { previous_assignments: null }; });
    mockAudit.mockImplementation(async () => { order.push('audit'); });

    await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    expect(order).toEqual(['write', 'audit']);
  });

  test('a failed write is not audited', async () => {
    mockQueryOne.mockRejectedValueOnce(new Error('connection lost'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    expect(response.status).toBe(500);
    expect(mockAudit).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
