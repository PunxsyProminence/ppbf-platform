// Track assignments are per athlete of one gym. Three things are pinned here:
//   who may reach the route (the gym's admin; not the platform owner,
//     OD-2026-10-08-003 R2);
//   what the route will store (live athletes of the caller's gym and known
//     track ids, or nothing at all; OD-2026-10-07-010 ruling 3 -- tracks are
//     for real athletes);
//   that every stored change leaves an audit record with a before and after,
//     written in the same transaction as the change.
//
// The database is mocked, so the SQL is asserted as text and is not executed
// here. What Postgres does with it is not proven by this file.

import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';

// requireRole (access.ts) and jsonError stay real.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockTransaction = withTransaction as jest.Mock;

const URL_BASE = 'http://localhost/api/pilot/admin/track-assignments';

/** The transaction's client. `stored` is the row the gym has before the POST. */
const client = { query: jest.fn() };
let stored: unknown;
/** Everything the transaction did, in order: 'lock', 'read', 'write', 'audit'. */
let steps: string[];

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

function clientCalls(pattern: RegExp) {
  return client.query.mock.calls.filter(([sql]) => pattern.test(sql));
}

const upserts = () => clientCalls(/insert into pilot\.admin_track_assignments/);

beforeEach(() => {
  jest.resetAllMocks();
  as('organization_admin');
  gymHasAthletes('ath-1', 'ath-2');
  stored = undefined;
  steps = [];
  mockQueryOne.mockResolvedValue(null);
  // A transaction that runs its body, and rethrows what the body throws (the
  // real one rolls back and rethrows; see db.ts).
  mockTransaction.mockImplementation(async (fn: (c: typeof client) => Promise<unknown>) => fn(client));
  client.query.mockImplementation(async (sql: string) => {
    if (/pg_advisory_xact_lock/.test(sql)) { steps.push('lock'); return { rows: [] }; }
    if (/^\s*select assignments/.test(sql)) {
      steps.push('read');
      return { rows: stored === undefined ? [] : [{ assignments: stored }] };
    }
    steps.push('write');
    return { rows: [] };
  });
  mockAudit.mockImplementation(async () => { steps.push('audit'); });
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
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// Unchanged by this lane: a coach was never on this list.
test.each(['coach', 'athlete', 'parent', 'board'])('role %s is refused on both verbs', async (role) => {
  as(role);

  expect((await GET(get())).status).toBe(403);
  expect((await POST(post({ assignments: {} }))).status).toBe(403);
  expect(mockQueryOne).not.toHaveBeenCalled();
  expect(mockTransaction).not.toHaveBeenCalled();
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
    expect(upserts()).toHaveLength(1);
    expect(upserts()[0][1]).toEqual([
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

  test('a stored key named like an object-prototype member is not read as one', async () => {
    mockQueryOne.mockResolvedValueOnce({ assignments: { constructor: ['pro'], 'ath-1': ['pro'] } });

    const response = await GET(get());

    await expect(response.json()).resolves.toEqual({ ok: true, assignments: { 'ath-1': ['pro'] } });
  });

  test('no stored row answers an empty map without an athlete lookup', async () => {
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
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
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

  // On an ordinary object a `__proto__` key sets the prototype and vanishes,
  // so the map would be saved without it and read as saved. It must be seen as
  // what it is: a key that names no athlete.
  test.each(['__proto__', 'constructor', 'toString'])(
    'a key named %s is an athlete id like any other, and is refused',
    async (key) => {
      const response = await expectRefused(`{"assignments":{"${key}":["usa_boxing"],"ath-1":["pro"]}}`);

      await expect(response.json()).resolves.toEqual({
        error: 'Unsupported assignments: 1 athlete id(s) are not athletes of this gym. Nothing was saved.',
      });
      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', [key, 'ath-1']]);
    },
  );

  test.each([
    ['an unknown track id', { assignments: { 'ath-1': ['non_contact', 'heavyweight_champion'] } }],
    ['a non-string track', { assignments: { 'ath-1': [7] } }],
    ['a null track', { assignments: { 'ath-1': [null] } }],
    ['tracks that are not a list', { assignments: { 'ath-1': 'non_contact' } }],
    ['a blank athlete id', { assignments: { ' ': ['non_contact'] } }],
    ['a padded athlete id', { assignments: { ' ath-1': ['non_contact'] } }],
    ['an athlete id with a NUL in it', { assignments: { 'ath\u00001': ['non_contact'] } }],
    ['an athlete id longer than the cap', { assignments: { ['a'.repeat(201)]: ['non_contact'] } }],
    ['assignments as a list', { assignments: [['ath-1', ['non_contact']]] }],
    ['assignments as a string', { assignments: 'ath-1' }],
    ['no assignments key', {}],
    ['a body that is not JSON', 'not json'],
    ['a null body', null],
  ])('%s is a 400 before any lookup or write', async (_name, body) => {
    await expectRefused(body);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('2001 athletes is a 400 before any lookup; 2000 is not refused for size', async () => {
    const many = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`ath-${index}`, ['non_contact']]),
    );

    await expectRefused({ assignments: many(2001) });
    expect(mockQuery).not.toHaveBeenCalled();

    // At the cap the size check passes and the athlete lookup runs.
    await POST(post({ assignments: many(2000) }));
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('a track listed twice is stored once', async () => {
    await POST(post({ assignments: { 'ath-1': ['pro', 'pro'] } }));

    expect(upserts()[0][1][1]).toBe(JSON.stringify({ 'ath-1': ['pro'] }));
  });
});

describe('every stored change is audited, in the same transaction as the change', () => {
  test('the audit row names the gym, the actor, and each changed athlete with before and after', async () => {
    stored = { 'ath-1': ['non_contact'], 'ath-2': ['pro'] };

    await POST(post({ assignments: { 'ath-1': ['usa_boxing'], 'ath-2': ['pro'] } }));

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toEqual({
      event_type: 'update',
      actor_account_id: 'organization_admin-1',
      actor_role: 'organization_admin',
      organization_id: 'org-1',
      entity_type: 'admin_track_assignments',
      entity_id: 'org-1',
      details: {
        action: 'track_assignments_replaced',
        changes: [{ athlete_id: 'ath-1', from: ['non_contact'], to: ['usa_boxing'] }],
      },
    });
  });

  test('lock, then read what is there, then write, then audit; all on the transaction\'s client', async () => {
    await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    expect(steps).toEqual(['lock', 'read', 'write', 'audit']);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // The audit row rides the same client, so it commits or rolls back with
    // the write.
    expect(mockAudit.mock.calls[0][1]).toBe(client);
    // Neither the read of the previous row nor the write goes through the
    // pool's autocommit helpers.
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1); // the athlete lookup only
  });

  test('the lock and the read are for the caller\'s gym', async () => {
    as('organization_admin', 'org-2');

    await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    const [lockSql, lockParams] = clientCalls(/pg_advisory_xact_lock/)[0];
    expect(lockSql).toContain("hashtext('ppbf.track-assignments:' || $1::text)");
    expect(lockParams).toEqual(['org-2']);
    const [readSql, readParams] = clientCalls(/^\s*select assignments/)[0];
    expect(readSql).toMatch(/from pilot\.admin_track_assignments\s+where organization_id = \$1/);
    expect(readParams).toEqual(['org-2']);
    expect(upserts()[0][1][0]).toBe('org-2');
  });

  test('a first save records each athlete with no before', async () => {
    await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    expect(mockAudit.mock.calls[0][0].details).toEqual({
      action: 'track_assignments_replaced',
      changes: [{ athlete_id: 'ath-1', from: null, to: ['pro'] }],
    });
  });

  test('a removed athlete and an added athlete are both recorded', async () => {
    stored = { 'ath-1': ['pro'] };

    await POST(post({ assignments: { 'ath-2': ['pro'] } }));

    expect(mockAudit.mock.calls[0][0].details.changes).toEqual([
      { athlete_id: 'ath-1', from: ['pro'], to: null },
      { athlete_id: 'ath-2', from: null, to: ['pro'] },
    ]);
  });

  test('clearing the map is a change: every stored athlete is recorded as removed', async () => {
    stored = { 'ath-1': ['pro'] };

    const response = await POST(post({ assignments: {} }));

    expect(response.status).toBe(200);
    expect(upserts()[0][1][1]).toBe('{}');
    expect(mockAudit.mock.calls[0][0].details.changes).toEqual([
      { athlete_id: 'ath-1', from: ['pro'], to: null },
    ]);
  });

  test('a changed order of the same tracks is a change', async () => {
    stored = { 'ath-1': ['pro', 'a2p'] };

    await POST(post({ assignments: { 'ath-1': ['a2p', 'pro'] } }));

    expect(upserts()).toHaveLength(1);
    expect(mockAudit.mock.calls[0][0].details.changes).toEqual([
      { athlete_id: 'ath-1', from: ['pro', 'a2p'], to: ['a2p', 'pro'] },
    ]);
  });

  test('a stored row keyed by an object-prototype name is recorded as a plain removed key', async () => {
    // A row stored before keys were checked. Read through a prototype it would
    // come back as a function and the comparison would throw.
    stored = { constructor: ['pro'], 'ath-1': ['pro'] };

    const response = await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    expect(response.status).toBe(200);
    expect(mockAudit.mock.calls[0][0].details.changes).toEqual([
      { athlete_id: 'constructor', from: ['pro'], to: null },
    ]);
  });
});

describe('a save that changes nothing', () => {
  // The screen saves once on load as well as on a click.
  test.each([
    ['the map already stored', { 'ath-1': ['pro'], 'ath-2': ['a2p'] }, { 'ath-2': ['a2p'], 'ath-1': ['pro'] }],
    ['an empty map over an empty row', {}, {}],
    ['an empty map when there is no row', undefined, {}],
  ])('%s writes nothing and audits nothing, and still answers ok', async (_name, before, sent) => {
    stored = before;

    const response = await POST(post({ assignments: sent }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(steps).toEqual(['lock', 'read']);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('when part of the save fails, the caller is told it did not save', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.mocked(console.error).mockRestore();
  });

  test('a failed write is a 500 and is not audited', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (/insert into/.test(sql)) throw new Error('connection lost');
      return { rows: [] };
    });

    const response = await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    expect(response.status).toBe(500);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a failed audit fails the transaction it shares with the write', async () => {
    // With the real withTransaction a throw inside the body is a ROLLBACK, so
    // the map is as it was and "not saved" is true. What this mock can show is
    // that the audit failure is thrown INSIDE the transaction body rather than
    // after it has returned.
    let bodyRejected = false;
    mockTransaction.mockImplementation(async (fn: (c: typeof client) => Promise<unknown>) => {
      try {
        return await fn(client);
      } catch (error) {
        bodyRejected = true;
        throw error;
      }
    });
    mockAudit.mockRejectedValueOnce(new Error('audit insert refused'));

    const response = await POST(post({ assignments: { 'ath-1': ['pro'] } }));

    expect(response.status).toBe(500);
    expect(bodyRejected).toBe(true);
  });
});
