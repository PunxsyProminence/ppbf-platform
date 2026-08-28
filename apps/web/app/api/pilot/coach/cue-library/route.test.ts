import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listCueLibrary } from '@/src/server/pilot/drillLibraryV3';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillLibraryV3', () => {
  const actual = jest.requireActual('@/src/server/pilot/drillLibraryV3');
  return { ...actual, listCueLibrary: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listCueLibrary as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/coach/cue-library${query ? `?${query}` : ''}`);

test('the read is scoped to the caller organization with the filters passed through', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockList.mockResolvedValue([]);

  const response = await GET(getRequest('focus_type=external&search=floor'));

  expect(response.status).toBe(200);
  expect(mockList).toHaveBeenCalledWith('org-1', { focusType: 'external', search: 'floor' });
});

test('ignores an organization supplied in the query', async () => {
  // Mirrors the drill-library case of the same name, for the same reason and by
  // the same construction -- the two are one family and should read as one.
  //
  // Every other case in this file passes benign input, so none of them can tell
  // "never reads an organization out of the request" apart from "was never
  // asked to". Measured on 2026-08-28, before this case existed: changing the
  // route to
  //
  //     listCueLibrary(searchParams.get('org') ?? principal.organizationId, ...)
  //
  // -- one query parameter, and a caller reads another gym's cue library --
  // left this suite at 13 passed, 0 failed. drill-library catches that exact
  // mutation because drill-library has this case. Same defect class, same two
  // routes, one of them covered.
  //
  // Three spellings because the route reads its parameters by name, and a
  // future one could plausibly be called any of them.
  const hostile = 'org=org-victim&organization_id=org-victim&organizationId=org-victim';

  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockList.mockResolvedValue([]);

  const response = await GET(getRequest(`focus_type=external&${hostile}`));

  expect(response.status).toBe(200);
  // Exact object rather than a partial match: it pins the organization to the
  // caller's own AND pins that no hostile parameter was smuggled into the
  // filter alongside the two the route is supposed to read.
  expect(mockList).toHaveBeenCalledWith('org-1', { focusType: 'external', search: undefined });
});

test('an unknown focus_type is a 400, not a query', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await GET(getRequest('focus_type=telepathic'))).status).toBe(400);
  expect(mockList).not.toHaveBeenCalled();
});

test('an unauthenticated caller is refused', async () => {
  mockRequirePrincipal.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));

  expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  expect(mockList).not.toHaveBeenCalled();
});

// CHARACTERIZATION, NOT ENDORSEMENT.
//
// Every case above fixes `role: 'coach'` through the principal() default, so
// none of them varied the role and this route's posture was unpinned.
//
// This route claims parity with /api/pilot/drill-library in its own header --
// "the same access posture as the drill-library browse it is a view over" --
// under a recorded owner decision of 2026-08-16. That claim is true of
// drill-library and false of /api/pilot/drills, which gates the same class of
// content to seven roles and excludes board and platform_owner with a written
// reason of its own.
//
// Which posture is right is an OPEN OWNER DECISION; module 114's own "Roles
// that may read / write" checklist is still unticked. These cases record what
// the route does so a change becomes visible, and settle nothing.

const ALL_ROLES: PilotRole[] = [
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'board',
  'volunteer',
  'staff',
];

describe('who may read the cue library today', () => {
  it.each(ALL_ROLES)('%s is admitted', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));
  });

  it('parity with drill-library is a fact about the code, not only a comment', () => {
    // The header asserts the two routes share a posture. If either grew a role
    // gate the claim would silently become false, so the absence is asserted
    // on both files rather than trusted.
    const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, relative), 'utf8');

    expect(read('./route.ts')).not.toMatch(/requireRole/);
    expect(read('../../drill-library/route.ts')).not.toMatch(/requireRole/);
  });
});
