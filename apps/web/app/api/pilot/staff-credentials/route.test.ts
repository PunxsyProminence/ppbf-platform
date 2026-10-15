import { NextRequest } from 'next/server';

import { GET } from './route';
import { listStaffCredentialStatus } from '@/src/server/pilot/clearanceRegister';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/clearanceRegister', () => {
  const actual = jest.requireActual('@/src/server/pilot/clearanceRegister');
  return { ...actual, listStaffCredentialStatus: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listStaffCredentialStatus as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'parent',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

const getReq = () => new NextRequest('http://localhost/api/pilot/staff-credentials');

// What provisioning actually produces. createOrUpdateMicrosoftStaffAccount
// falls back to the normalised login email when the caller supplies no account
// id hint, and the admin console's invite form supplies none, so a coach
// invited through the console has their work email FOR an account_id.
const STAFF_ACCOUNT_ID = 'jane.okafor@example.com';

const staffRows = () => [
  {
    account_id: STAFF_ACCOUNT_ID, role: 'coach', login_email: 'jane.okafor@example.com',
    clearance_type_id: 'ct-safesport', clearance_name: 'SafeSport Training',
    issuing_authority: 'U.S. Center for SafeSport', status: 'current', expires_on: '2027-01-01',
  },
  {
    account_id: STAFF_ACCOUNT_ID, role: 'coach', login_email: 'jane.okafor@example.com',
    clearance_type_id: 'ct-cpr', clearance_name: 'CPR/First Aid',
    issuing_authority: 'American Red Cross', status: 'not_started', expires_on: null,
  },
];

describe('GET /api/pilot/staff-credentials', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await GET(getReq())).status).toBe(401);
  });

  test('every signed-in role can read it -- a parent is not refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    mockList.mockResolvedValueOnce([]);
    expect((await GET(getReq())).status).toBe(200);
  });

  test('an athlete role is also allowed, matching the wall-of-names precedent', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete' }));
    mockList.mockResolvedValueOnce([]);
    expect((await GET(getReq())).status).toBe(200);
  });

  test('groups rows by account, resolves a display name, and never carries document_ref/verification_note', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockList.mockResolvedValueOnce(staffRows());

    const response = await GET(getReq());
    const body = (await response.json()) as { staff: Array<Record<string, unknown>> };

    expect(body.staff).toHaveLength(1);
    expect(body.staff[0]).toMatchObject({ display_name: 'Jane Okafor', role: 'coach' });
    const credentials = body.staff[0].credentials as Array<Record<string, unknown>>;
    expect(credentials).toHaveLength(2);
    expect(credentials.find((c) => c.clearance_type_id === 'ct-safesport')).toMatchObject({ band: 'current' });
    expect(credentials.find((c) => c.clearance_type_id === 'ct-cpr')).toMatchObject({ band: 'missing' });

    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/document_ref/);
    expect(raw).not.toMatch(/verification_note/);
    expect(raw).not.toMatch(/verified_by_account_id/);
  });

  // The account_id in the fixtures above is an email because that is what
  // provisioning produces: createOrUpdateMicrosoftStaffAccount falls back to
  // the normalised login email when no account id hint is supplied
  // (staffProvisioning.ts), and the admin console's invite form sends none.
  // An earlier version of this suite used 'coach-1' -- an id no provisioning
  // path in this repository produces -- and asserted it was PRESENT in the
  // body, which made a work-email disclosure look like a harmless row key.
  test('never emits the raw account_id, which provisioning makes the work email', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete' }));
    mockList.mockResolvedValueOnce(staffRows());

    const response = await GET(getReq());
    const body = (await response.json()) as { staff: Array<Record<string, unknown>> };
    const raw = JSON.stringify(body);

    expect(raw).not.toMatch(/jane\.okafor@example\.com/);
    expect(raw).not.toMatch(/@/);
    expect(body.staff[0]).not.toHaveProperty('account_id');
    expect(Object.values(body.staff[0])).not.toContain(STAFF_ACCOUNT_ID);
  });

  test('carries an opaque staff_key instead, stable across requests and distinct per person', async () => {
    const secondPerson = {
      account_id: 'marcus.ruiz@example.com', role: 'staff', login_email: 'marcus.ruiz@example.com',
      clearance_type_id: 'ct-cpr', clearance_name: 'CPR/First Aid',
      issuing_authority: 'American Red Cross', status: 'current', expires_on: '2027-06-01',
    };

    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockList.mockResolvedValueOnce([...staffRows(), secondPerson]);
    const first = (await (await GET(getReq())).json()) as { staff: Array<Record<string, unknown>> };

    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockList.mockResolvedValueOnce([...staffRows(), secondPerson]);
    const second = (await (await GET(getReq())).json()) as { staff: Array<Record<string, unknown>> };

    const keys = first.staff.map((person) => person.staff_key);
    // A client may use this as a React key or to correlate rows between two
    // reads, so a per-request random value would be worse than the leak.
    expect(keys).toEqual(second.staff.map((person) => person.staff_key));
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(typeof key).toBe('string');
      expect(key as string).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});

/*
 * #1558 item three. staffDisplayName falls back to the account id when the
 * login email gives no name, and keeps the login's digits; the account id is
 * the login email unless somebody chose otherwise. An athlete or a parent is
 * given the digit-free name, or "Staff member" (PROPOSED wording, accepted by
 * Overwatch for this lane; not an owner ruling). Every other reader of this
 * list reads the name as before.
 */
describe('the staff name an athlete or a parent is shown', () => {
  const STAFF_ID = 'staff.4411@example.test';
  const rowsWith = (loginEmail: string | null) => [
    {
      account_id: STAFF_ID, role: 'coach', login_email: loginEmail,
      clearance_type_id: 'ct-cpr', clearance_name: 'CPR/First Aid',
      issuing_authority: 'American Red Cross', status: 'current', expires_on: '2027-01-01',
    },
  ];
  const namesFor = async (role: PilotPrincipal['role'], loginEmail: string | null) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    mockList.mockResolvedValue(rowsWith(loginEmail));
    const response = await GET(getReq());
    const raw = await response.text();
    expect(response.status).toBe(200);
    return { names: JSON.parse(raw).staff.map((entry: { display_name: string }) => entry.display_name), raw };
  };

  test.each([
    ['parent', null, 'Staff member'],
    ['athlete', null, 'Staff member'],
    ['parent', '4411-77@example.test', 'Staff member'],
    ['athlete', '@example.test', 'Staff member'],
    ['parent', 'mike1987@example.test', 'Mike'],
    ['athlete', 'jane.okafor@example.test', 'Jane Okafor'],
  ] as const)('a %s reading a login of %s is shown %s, and no part of the id', async (role, email, expected) => {
    const { names, raw } = await namesFor(role, email);
    expect(names).toEqual([expected]);
    expect(raw).not.toContain(STAFF_ID);
    expect(raw).not.toMatch(/4411|1987/);
  });

  test.each(['coach', 'organization_admin', 'admin', 'staff', 'volunteer', 'board', 'platform_owner'] as const)(
    'a %s reads the name as before: the account id when the email gives none, the digits kept',
    async (role) => {
      expect((await namesFor(role, null)).names).toEqual([STAFF_ID]);
      expect((await namesFor(role, 'mike1987@example.test')).names).toEqual(['Mike1987']);
    },
  );
});
