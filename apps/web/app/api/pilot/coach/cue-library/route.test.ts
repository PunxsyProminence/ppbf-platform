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

// WHO MAY READ, now that it is decided.
//
// Every case above fixes `role: 'coach'` through the principal() default, so
// none of them varies the role. This block is what pins the posture.
//
// This route claims parity with /api/pilot/drill-library in its own header --
// "the same access posture as the drill-library browse it is a view over".
// That claim was true of drill-library and false of /api/pilot/drills, which
// gated the same class of content to seven roles and excluded board and
// platform_owner with a written reason of its own. Module 114's own "Roles
// that may read / write" checklist was unticked while all three files asserted
// a posture.
//
// The owner decided on 2026-08-27: board DENIED, platform_owner ALLOWED and
// organization-scoped, the seven organization member roles preserved. Parity
// is now a shared constant rather than a shared intention, and it is asserted
// on both files below rather than trusted.

/**
 * Listed in full rather than derived from COACHING_CONTENT_READER_ROLES: a
 * test that asks the policy what the policy says cannot notice the policy
 * changing.
 */
const ADMITTED_ROLES: PilotRole[] = [
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'volunteer',
  'staff',
];

const DENIED_ROLES: PilotRole[] = ['board'];

/**
 * The vocabulary, READ OUT OF contracts.ts rather than restated here.
 *
 * It was restated, which made the exhaustiveness case below a comparison of
 * three literals in one file -- they agree by construction. Measured: adding a
 * tenth member to the PilotRole union left all 61 cases in the four affected
 * suites green. Parsing the union is what makes the case fail when the
 * vocabulary grows, under `npx jest`; jest does not typecheck, so nothing
 * type-level would.
 */
function roleVocabulary(): PilotRole[] {
  const contracts = fs.readFileSync(
    path.resolve(__dirname, '../../../../../src/server/pilot/contracts.ts'),
    'utf8',
  );
  const union = /export type PilotRole =([\s\S]*?);/.exec(contracts);
  if (!union) {
    throw new Error('PilotRole union not found in contracts.ts -- this parser needs updating');
  }

  const roles = Array.from(union[1].matchAll(/'([a-z_]+)'/g), (match) => match[1] as PilotRole);
  if (roles.length === 0) {
    throw new Error('PilotRole union parsed to no roles -- this parser needs updating');
  }

  return roles;
}

const ALL_ROLES: PilotRole[] = roleVocabulary();

describe('who may read the cue library', () => {
  it('accounts for every role in the vocabulary, so a new one cannot default in', () => {
    // ALL_ROLES comes from the PilotRole union itself, so a role added there
    // lands on neither side of this partition and fails here.
    expect([...ADMITTED_ROLES, ...DENIED_ROLES].sort()).toEqual([...ALL_ROLES].sort());
  });

  it.each(ADMITTED_ROLES)('%s is admitted', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));
  });

  it.each(DENIED_ROLES)('%s is refused, and the read never runs', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    // A refusal that has already read the cue library is not a refusal.
    expect(mockList).not.toHaveBeenCalled();
  });

  it('refuses the board BEFORE validating the query, so the gate is not reachable around', async () => {
    // focus_type is validated inside the same try block. If the gate sat after
    // that validation, a board caller sending a bad focus_type would get a 400
    // -- a different answer to "may I read this?" depending on how well-formed
    // the request was, and a disclosure that the parameter exists.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'board' }));

    const response = await GET(getRequest('focus_type=telepathic'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('parity with drill-library is a fact about the code, not only a comment', () => {
    // The header asserts the two routes share a posture. Previously that was
    // asserted as the ABSENCE of requireRole in both files -- true, and the
    // reason the disagreement with /api/pilot/drills could persist. Now it is
    // asserted as both files reaching the same named policy, which is a
    // stronger claim: two local literals holding the same eight roles would
    // pass a role sweep and still be free to drift apart.
    const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, relative), 'utf8');

    for (const file of ['./route.ts', '../../drill-library/route.ts']) {
      expect(read(file)).toMatch(
        /import \{ COACHING_CONTENT_READER_ROLES \} from '@\/src\/server\/pilot\/coachingContentAccess'/,
      );
      expect(read(file)).toMatch(/requireRole\(principal, \[\.\.\.COACHING_CONTENT_READER_ROLES\]\)/);
    }
  });
});
