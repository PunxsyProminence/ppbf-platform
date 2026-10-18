import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listSupportForStaff, recordSupport, retireSupport } from '@/src/server/pilot/familySupportRecords';
import { ForbiddenError } from '@/src/server/pilot/errors';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/familySupportRecords', () => {
  const actual = jest.requireActual('@/src/server/pilot/familySupportRecords');
  return { ...actual, listSupportForStaff: jest.fn(), recordSupport: jest.fn(), retireSupport: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listSupportForStaff as jest.Mock;
const mockRecord = recordSupport as jest.Mock;
const mockRetire = retireSupport as jest.Mock;

const RECORD_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const URL_BASE = 'http://localhost/api/pilot/admin/family-support';
const getRequest = (query = '?athlete_id=ath-1') => new NextRequest(`${URL_BASE}${query}`);
const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest(URL_BASE, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('only the office reaches it: coaches, parents, athletes and staff are refused before any read or write', async () => {
  for (const role of ['coach', 'parent', 'athlete', 'staff', 'volunteer'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBe(403);
    expect((await POST(bodyRequest('POST', { athlete_id: 'a', support_kind: 'Gloves', provided_on: '2026-10-01' }))).status).toBe(403);
    expect((await PATCH(bodyRequest('PATCH', { record_id: RECORD_ID, action: 'retire' }))).status).toBe(403);
  }
  expect(mockList).not.toHaveBeenCalled();
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockRetire).not.toHaveBeenCalled();
});

test('the list reads the session gym for the athlete asked for, and needs an athlete', async () => {
  for (const role of ['organization_admin', 'admin'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role, organizationId: 'org-session' }));
    mockList.mockResolvedValue([]);
    expect((await GET(getRequest('?athlete_id=%20ath-1%20&organization_id=org-other'))).status).toBe(200);
    expect(mockList).toHaveBeenLastCalledWith('org-session', 'ath-1');
  }
  expect((await GET(getRequest(''))).status).toBe(400);
});

test('a record is filed by the signed-in principal; another gym\'s athlete is a hidden not-found', async () => {
  const actor = principal({ organizationId: 'org-session' });
  mockRequirePrincipal.mockResolvedValue(actor);
  mockRecord.mockResolvedValueOnce({ record_id: RECORD_ID });

  const ok = await POST(bodyRequest('POST', { athlete_id: ' ath-1 ', support_kind: 'Gloves', provided_on: '2026-10-01', organization_id: 'org-other' }));
  expect(ok.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledWith(actor, 'ath-1', 'Gloves', '2026-10-01');

  mockRecord.mockResolvedValueOnce(null);
  expect((await POST(bodyRequest('POST', { athlete_id: 'ath-x', support_kind: 'Gloves', provided_on: '2026-10-01' }))).status).toBe(404);
  expect((await POST(bodyRequest('POST', { support_kind: 'Gloves', provided_on: '2026-10-01' }))).status).toBe(400);
});

test('a future date and a blank kind are 400s from the module, a seat refusal is a 403', async () => {
  mockRequirePrincipal.mockResolvedValue(principal());
  mockRecord.mockImplementation(jest.requireActual('@/src/server/pilot/familySupportRecords').recordSupport);
  expect((await POST(bodyRequest('POST', { athlete_id: 'a', support_kind: '   ', provided_on: '2026-10-01' }))).status).toBe(400);
  expect((await POST(bodyRequest('POST', { athlete_id: 'a', support_kind: 'Gloves', provided_on: '2999-01-01' }))).status).toBe(400);
  expect((await POST(bodyRequest('POST', { athlete_id: 'a', support_kind: 'Gloves', provided_on: '2026-02-30' }))).status).toBe(400);

  mockRecord.mockRejectedValueOnce(new ForbiddenError('Only an organization admin or admin of this gym records family support.'));
  expect((await POST(bodyRequest('POST', { athlete_id: 'a', support_kind: 'Gloves', provided_on: '2026-10-01' }))).status).toBe(403);
});

test('the one change is retire, by record id; anything else is refused before any write', async () => {
  const actor = principal();
  mockRequirePrincipal.mockResolvedValue(actor);
  mockRetire.mockResolvedValueOnce({ record_id: RECORD_ID });

  expect((await PATCH(bodyRequest('PATCH', { record_id: RECORD_ID, action: 'retire' }))).status).toBe(200);
  expect(mockRetire).toHaveBeenCalledWith(actor, RECORD_ID);

  expect((await PATCH(bodyRequest('PATCH', { record_id: RECORD_ID, action: 'edit', support_kind: 'x' }))).status).toBe(400);
  expect((await PATCH(bodyRequest('PATCH', { record_id: 'not-a-uuid', action: 'retire' }))).status).toBe(400);
  expect(mockRetire).toHaveBeenCalledTimes(1);

  mockRetire.mockResolvedValueOnce(null);
  expect((await PATCH(bodyRequest('PATCH', { record_id: RECORD_ID, action: 'retire' }))).status).toBe(404);
});

test('a malformed or non-object body is a 400, never a 500, and reaches no write', async () => {
  mockRequirePrincipal.mockResolvedValue(principal());
  const rawRequest = (method: 'POST' | 'PATCH', body: string) =>
    new NextRequest(URL_BASE, { method, headers: { 'content-type': 'application/json' }, body });

  for (const body of ['{not json', '', 'null', '[]', '"retire"', '42']) {
    for (const [method, handler] of [['POST', POST], ['PATCH', PATCH]] as const) {
      const response = await handler(rawRequest(method, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'The request body must be a JSON object.' });
    }
  }
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockRetire).not.toHaveBeenCalled();
});
