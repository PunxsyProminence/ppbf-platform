import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { ConflictError } from '@/src/server/pilot/errors';
import {
  archiveProgram,
  createProgram,
  listProgramsWithCounts,
  reactivateProgram,
} from '@/src/server/pilot/programs';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/programs', () => {
  const actual = jest.requireActual('@/src/server/pilot/programs');
  return {
    ...actual,
    archiveProgram: jest.fn(),
    createProgram: jest.fn(),
    listProgramsWithCounts: jest.fn(),
    reactivateProgram: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockArchive = archiveProgram as jest.Mock;
const mockCreate = createProgram as jest.Mock;
const mockList = listProgramsWithCounts as jest.Mock;
const mockReactivate = reactivateProgram as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = () => new NextRequest('http://localhost/api/pilot/admin/programs');

const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/admin/programs', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// What createProgram returns: the catalog row, no count.
const CATALOG_ROW = {
  organization_id: 'org-1',
  program_id: 'prog-1',
  program_name: 'Junior Boxing',
  status: 'active',
  notes: 'admin-only field',
  created_at: '2026-08-01T00:00:00Z',
};

// What listProgramsWithCounts returns: the counted shape the UI consumes.
const PROGRAM = {
  ...CATALOG_ROW,
  active_member_count: 7,
};

test('athletes and parents have no access to the catalog in any direction', async () => {
  for (const role of ['athlete', 'parent'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
    expect((await POST(bodyRequest('POST', { program_name: 'Fight Camp' }))).status).toBeGreaterThanOrEqual(400);
    expect((await PATCH(bodyRequest('PATCH', { program_id: 'prog-1', status: 'archived' }))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockList).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockArchive).not.toHaveBeenCalled();
});

test('a coach may READ names and counts -- with the admin notes field stripped -- but may not create or archive', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockList.mockResolvedValue([PROGRAM]);

  const response = await GET(getRequest());
  expect(response.status).toBe(200);
  expect(mockList).toHaveBeenCalledWith('org-1');
  const payload = await response.json();
  expect(payload.items).toEqual([{
    program_id: 'prog-1',
    program_name: 'Junior Boxing',
    status: 'active',
    active_member_count: 7,
  }]);

  expect((await POST(bodyRequest('POST', { program_name: 'Fight Camp' }))).status).toBe(403);
  expect((await PATCH(bodyRequest('PATCH', { program_id: 'prog-1', status: 'archived' }))).status).toBe(403);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockArchive).not.toHaveBeenCalled();
});

test('an admin reads the full catalog rows, notes included', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockList.mockResolvedValue([PROGRAM]);

  const payload = await (await GET(getRequest())).json();
  expect(payload.items).toEqual([PROGRAM]);
});

test('a create is filed under the caller organization and account, name trimmed, and answers the counted row shape', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue(CATALOG_ROW);

  const response = await POST(bodyRequest('POST', { program_name: '  Junior Boxing  ' }));

  expect(response.status).toBe(200);
  expect(mockCreate).toHaveBeenCalledWith({
    organizationId: 'org-1',
    programName: 'Junior Boxing',
    notes: undefined,
    createdByAccountId: 'acct-1',
  });
  // POST rows are interchangeable with GET rows: a just-created program
  // carries its (definitionally zero) live headcount.
  const payload = await response.json();
  expect(payload.item).toEqual({ ...CATALOG_ROW, active_member_count: 0 });
});

test('a blank name is refused before any write', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(bodyRequest('POST', { program_name: '   ' }))).status).toBe(400);
  expect((await POST(bodyRequest('POST', {}))).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a duplicate name surfaces as the module 409, so spelling drift is a readable refusal', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockRejectedValue(new ConflictError(
    'A program with this name already exists in this organization (it may be archived). Use the existing program or reactivate it.',
    'PROGRAM_NAME_TAKEN',
  ));

  const response = await POST(bodyRequest('POST', { program_name: 'Junior Boxing' }));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(payload.error).toMatch(/already exists/i);
});

test('PATCH routes archived to archiveProgram and active to reactivateProgram, in the caller org only', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockArchive.mockResolvedValue({ ...PROGRAM, status: 'archived' });
  mockReactivate.mockResolvedValue(PROGRAM);

  expect((await PATCH(bodyRequest('PATCH', { program_id: 'prog-1', status: 'archived' }))).status).toBe(200);
  expect(mockArchive).toHaveBeenCalledWith('org-1', 'prog-1');

  expect((await PATCH(bodyRequest('PATCH', { program_id: 'prog-1', status: 'active' }))).status).toBe(200);
  expect(mockReactivate).toHaveBeenCalledWith('org-1', 'prog-1');
});

test('an unknown status or missing id is a 400; a program outside the org is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await PATCH(bodyRequest('PATCH', { program_id: 'prog-1', status: 'deleted' }))).status).toBe(400);
  expect((await PATCH(bodyRequest('PATCH', { status: 'archived' }))).status).toBe(400);
  expect(mockArchive).not.toHaveBeenCalled();

  mockArchive.mockResolvedValue(null);
  expect((await PATCH(bodyRequest('PATCH', { program_id: 'prog-other-org', status: 'archived' }))).status).toBe(404);
});
