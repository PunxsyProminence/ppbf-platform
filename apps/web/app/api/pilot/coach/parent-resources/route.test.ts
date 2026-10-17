import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { ConflictError, ForbiddenError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createResource,
  editResource,
  listResourcesForStaff,
  setResourceState,
} from '@/src/server/pilot/parentResourcesStaff';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// What is written, the seat check, links and programs are proved on Postgres
// in parentResourcesStaff.pg.test.ts. Here: the roles, that the gym and the
// writer come from the session, and which write each request makes (PH-11b).
jest.mock('@/src/server/pilot/parentResourcesStaff', () => ({
  createResource: jest.fn(),
  editResource: jest.fn(),
  listResourcesForStaff: jest.fn(),
  setResourceState: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockCreate = jest.mocked(createResource);
const mockEdit = jest.mocked(editResource);
const mockList = jest.mocked(listResourcesForStaff);
const mockState = jest.mocked(setResourceState);

function principal(role = 'coach') {
  return { accountId: 'acct-1', role, organizationId: 'org-1', athleteId: null, sessionToken: 'token', authProvider: 'microsoft' } as never;
}

const URL = 'http://localhost/api/pilot/coach/parent-resources';
const ITEM = { resource_id: 'r1', title: 'Hydration' } as never;
const FIELDS = { title: 'Hydration', summary: 'Drink.', resource_type: 'guide', destination: '/help', program_id: null };
const VERSION = '2026-10-17T12:00:00.123456Z';
const WRITER = { organizationId: 'org-1', accountId: 'acct-1', role: 'coach' };

function send(method: 'POST' | 'PATCH', body: unknown) {
  return new NextRequest(URL, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue(ITEM);
  mockEdit.mockResolvedValue(ITEM);
  mockState.mockResolvedValue(ITEM);
  mockList.mockResolvedValue({ items: [ITEM], programs: [] });
});

describe('/api/pilot/coach/parent-resources (PH-11b)', () => {
  test.each(['coach', 'organization_admin', 'admin'])('%s reads the gym from the session', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest(`${URL}?organization_id=org-other`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [ITEM], programs: [] });
    expect(mockList).toHaveBeenCalledWith('org-1');
  });

  test.each(['parent', 'athlete', 'board', 'platform_owner', 'staff', 'volunteer'])('%s is refused and nothing is read or written', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    for (const response of [
      await GET(new NextRequest(URL)),
      await POST(send('POST', FIELDS)),
      await PATCH(send('PATCH', { resource_id: 'r1', action: 'archive' })),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockState).not.toHaveBeenCalled();
  });

  test('a new resource is written as the caller, never as an account or gym the body names', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await POST(send('POST', { ...FIELDS, publish: true, organization_id: 'org-other', created_by_account_id: 'acct-x' }));
    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'acct-1', role: 'organization_admin' }, FIELDS, true);
  });

  test('only publish: true publishes at once', async () => {
    mockPrincipal.mockResolvedValue(principal());
    await POST(send('POST', { ...FIELDS, publish: 'true' }));
    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), FIELDS, false);
  });

  test('a missing field, a program that is not text, or a body that is not an object is a 400 and writes nothing', async () => {
    mockPrincipal.mockResolvedValue(principal());
    for (const body of [{ ...FIELDS, title: undefined }, { ...FIELDS, program_id: 7 }, ['x']]) {
      expect((await POST(send('POST', body))).status).toBe(400);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each([
    ['edit', () => expect(mockEdit).toHaveBeenCalledWith(WRITER, 'r1', VERSION, FIELDS)],
    ['publish', () => expect(mockState).toHaveBeenCalledWith(WRITER, 'r1', 'published', VERSION)],
    ['archive', () => expect(mockState).toHaveBeenCalledWith(WRITER, 'r1', 'archived', VERSION)],
  ])('PATCH %s makes that change as the caller, against the version it names', async (action, check) => {
    mockPrincipal.mockResolvedValue(principal());
    const response = await PATCH(send('PATCH', { ...FIELDS, resource_id: 'r1', updated_at: VERSION, action }));
    expect(response.status).toBe(200);
    check();
  });

  test('an edit passes on only the fields it sends; program_id null is every family', async () => {
    mockPrincipal.mockResolvedValue(principal());
    await PATCH(send('PATCH', { resource_id: 'r1', updated_at: VERSION, action: 'edit', title: 'Water' }));
    expect(mockEdit).toHaveBeenLastCalledWith(WRITER, 'r1', VERSION, { title: 'Water' });
    await PATCH(send('PATCH', { resource_id: 'r1', updated_at: VERSION, action: 'edit', program_id: null }));
    expect(mockEdit).toHaveBeenLastCalledWith(WRITER, 'r1', VERSION, { program_id: null });
  });

  test('a change with no version, or an edit field that is not text, is a 400 and changes nothing', async () => {
    mockPrincipal.mockResolvedValue(principal());
    for (const body of [
      { resource_id: 'r1', action: 'publish' },
      { resource_id: 'r1', action: 'edit', title: 'Water', updated_at: '' },
      { resource_id: 'r1', action: 'archive', updated_at: 7 },
      { resource_id: 'r1', action: 'edit', updated_at: VERSION, title: 7 },
      { resource_id: 'r1', action: 'edit', updated_at: VERSION, program_id: 7 },
    ]) {
      expect((await PATCH(send('PATCH', body))).status).toBe(400);
    }
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockState).not.toHaveBeenCalled();
  });

  test('a change made against an older version reaches the caller as a 409', async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockEdit.mockRejectedValue(new ConflictError('Someone else changed this resource. Reload to see their version.'));
    const response = await PATCH(send('PATCH', { resource_id: 'r1', updated_at: VERSION, action: 'edit', title: 'Water' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Someone else changed this resource. Reload to see their version.' });
  });

  test('no resource, an unknown action or delete is a 400 and changes nothing', async () => {
    mockPrincipal.mockResolvedValue(principal());
    for (const body of [{ action: 'archive', updated_at: VERSION }, { resource_id: 'r1', action: 'delete', updated_at: VERSION }, { resource_id: 'r1', updated_at: VERSION }]) {
      expect((await PATCH(send('PATCH', body))).status).toBe(400);
    }
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockState).not.toHaveBeenCalled();
  });

  test("the database's seat refusal reaches the caller as a 403", async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockState.mockRejectedValue(new ForbiddenError('Forbidden: your seat at this gym does not allow writing parent resources.'));
    const response = await PATCH(send('PATCH', { resource_id: 'r1', updated_at: VERSION, action: 'publish' }));
    expect(response.status).toBe(403);
  });
});
