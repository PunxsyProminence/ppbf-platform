// A gym's capability flags are gym work: the gym's admin reads and saves them
// for the gym of its own session, and the platform owner does not
// (OD-2026-10-10-004 ruling 3). One use is platform work and is kept: the
// new-gym wizard, where the platform owner sets the flags of a gym it NAMES.
// So the platform owner is refused on GET, refused on a POST that names no
// gym, and admitted on a POST that names one; that write is audited under the
// gym acted on, in the same transaction.

import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { PLATFORM_LIBRARY_ORGANIZATION_ID } from '@/src/server/pilot/platformLibraryScope';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockTransaction = jest.mocked(withTransaction);
const mockAudit = jest.mocked(writePilotAuditEvent);

const URL_BASE = 'http://localhost/api/pilot/admin/gym-capabilities';
const FLAGS = { attendance: true, sparring: false };

// A transaction model: a write lands only if the whole body completes.
const clientQuery = jest.fn();
const client = { query: clientQuery };
let committed: Array<{ sql: string; params: unknown[] }> = [];

function as(role: string, organizationId = 'org-session') {
  mockPrincipal.mockResolvedValue({ accountId: `${role}-1`, organizationId, role } as never);
}

function get(search = '') {
  return GET(new NextRequest(`${URL_BASE}${search}`));
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function expectNothingTouched() {
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockQueryOne).not.toHaveBeenCalled();
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(clientQuery).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.resetAllMocks();
  committed = [];
  mockQueryOne.mockResolvedValue({ capability_access: FLAGS } as never);
  mockAudit.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (body) => {
    const pending: Array<{ sql: string; params: unknown[] }> = [];
    clientQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      pending.push({ sql, params });
      return { rows: [] };
    });
    const result = await body(client as never);
    committed.push(...pending);
    return result;
  });
});

describe('GET: the gym admin only', () => {
  test.each([
    ['with no organization named', ''],
    ['naming another gym', '?organization_id=org-gym-2'],
    ['naming the gym of its own session', '?organization_id=org-session'],
  ])('refuses the platform owner %s, and reads nothing', async (_label, search) => {
    as('platform_owner');

    const response = await get(search);

    expect(response.status).toBe(403);
    expectNothingTouched();
  });

  test.each(['organization_admin', 'admin'])('%s reads the flags of its own gym', async (role) => {
    as(role, 'org-gym-1');

    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, capabilityAccess: FLAGS });
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-gym-1']);
  });

  test('a gym admin read ignores an organization named in the query', async () => {
    as('organization_admin', 'org-gym-1');

    const response = await get('?organization_id=org-gym-2');

    expect(response.status).toBe(200);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-gym-1']);
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'])(
    '%s is refused, as before',
    async (role) => {
      as(role);

      expect((await get()).status).toBe(403);
      expectNothingTouched();
    },
  );
});

describe('POST: the platform owner only for a gym it names', () => {
  test.each([
    ['no organization_id', { capabilityAccess: FLAGS }],
    ['an empty organization_id', { capabilityAccess: FLAGS, organization_id: '' }],
    ['a blank organization_id', { capabilityAccess: FLAGS, organization_id: '   ' }],
    ['a null organization_id', { capabilityAccess: FLAGS, organization_id: null }],
    ['an organization_id that is not text', { capabilityAccess: FLAGS, organization_id: 7 }],
    ['an organization_id that is a list', { capabilityAccess: FLAGS, organization_id: ['org-gym-2'] }],
  ])('refuses the platform owner with %s, and writes nothing', async (_label, body) => {
    as('platform_owner');

    const response = await post(body);

    expect(response.status).toBe(403);
    expectNothingTouched();
    expect(committed).toEqual([]);
  });

  test('the platform owner sets the flags of the gym it names, audited under that gym', async () => {
    as('platform_owner', 'org-session');

    const response = await post({ capabilityAccess: FLAGS, organization_id: '  org-new-gym  ' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    // The write names the gym acted on, never the gym of the session.
    expect(committed).toHaveLength(1);
    expect(committed[0].sql).toContain('insert into pilot.admin_gym_capability_access');
    expect(committed[0].params).toEqual(['org-new-gym', JSON.stringify(FLAGS), 'platform_owner-1']);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toEqual({
      event_type: 'update',
      actor_account_id: 'platform_owner-1',
      actor_role: 'platform_owner',
      organization_id: 'org-new-gym',
      entity_type: 'gym_capability_access',
      entity_id: 'org-new-gym',
      details: { capability_access: FLAGS },
    });
    // On the transaction's own client, so the record and the write share it.
    expect(mockAudit.mock.calls[0][1]).toBe(client);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a failed audit record leaves the gym\'s flags unchanged', async () => {
    as('platform_owner');
    mockAudit.mockRejectedValue(new Error('audit insert failed'));

    const response = await post({ capabilityAccess: FLAGS, organization_id: 'org-new-gym' });

    expect(response.status).toBe(500);
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(committed).toEqual([]);
  });

  // The route does not ask whether the named gym is new. Naming an established
  // gym, or the gym of its own session, is admitted like any other named gym,
  // and leaves its record in that gym's log.
  test('the platform owner naming the gym of its own session writes it, audited under that gym', async () => {
    as('platform_owner', 'org-session');

    const response = await post({ capabilityAccess: FLAGS, organization_id: 'org-session' });

    expect(response.status).toBe(200);
    expect(committed).toHaveLength(1);
    expect(committed[0].params[0]).toBe('org-session');
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      actor_role: 'platform_owner',
      organization_id: 'org-session',
      entity_id: 'org-session',
    });
  });

  test('a gym that does not exist: the write fails, nothing is committed or audited', async () => {
    as('platform_owner');
    mockTransaction.mockImplementation(async (body) => {
      clientQuery.mockRejectedValue(new Error('violates foreign key constraint'));
      return body(client as never);
    });

    const response = await post({ capabilityAccess: FLAGS, organization_id: 'no-such-gym' });

    expect(response.status).toBe(500);
    expect(committed).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test.each(['platform_owner', 'organization_admin'])(
    '%s: a body that is not a JSON object is refused, and no flags are overwritten',
    async (role) => {
      as(role, 'org-gym-1');

      for (const raw of ['null', '[]', '[{"organization_id":"org-gym-2"}]', '"org-gym-2"', '7', '{not json']) {
        const response = await POST(new NextRequest(URL_BASE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        }));
        expect([raw, response.status]).toEqual([raw, 400]);
      }
      expectNothingTouched();
      expect(committed).toEqual([]);
    },
  );

  test('the platform evidence shelf is not a gym: refused, nothing written', async () => {
    as('platform_owner');

    const response = await post({
      capabilityAccess: FLAGS,
      organization_id: PLATFORM_LIBRARY_ORGANIZATION_ID,
    });

    expect(response.status).toBe(400);
    expectNothingTouched();
  });

  test.each(['organization_admin', 'admin'])('%s saves the flags of its own gym, unaudited as before', async (role) => {
    as(role, 'org-gym-1');

    const response = await post({ capabilityAccess: FLAGS });

    expect(response.status).toBe(200);
    expect(committed).toHaveLength(1);
    expect(committed[0].params).toEqual(['org-gym-1', JSON.stringify(FLAGS), `${role}-1`]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test.each(['organization_admin', 'admin'])(
    '%s cannot reach another gym by naming it: the write stays on its own',
    async (role) => {
      as(role, 'org-gym-1');

      const response = await post({ capabilityAccess: FLAGS, organization_id: 'org-gym-2' });

      expect(response.status).toBe(200);
      expect(committed).toHaveLength(1);
      expect(committed[0].params[0]).toBe('org-gym-1');
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  test('only boolean flags are stored', async () => {
    as('organization_admin', 'org-gym-1');

    await post({ capabilityAccess: { attendance: true, sparring: 'yes', notes: null } });

    expect(committed[0].params[1]).toBe(JSON.stringify({ attendance: true }));
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'])(
    '%s is refused even when it names a gym',
    async (role) => {
      as(role);

      const response = await post({ capabilityAccess: FLAGS, organization_id: 'org-gym-2' });

      expect(response.status).toBe(403);
      expectNothingTouched();
    },
  );
});
