import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { listFamilyInjuries } from '@/src/server/pilot/athleteInjuries';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/athleteInjuries', () => ({
  ...jest.requireActual('@/src/server/pilot/athleteInjuries'),
  listFamilyInjuries: jest.fn(),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listFamilyInjuries as jest.Mock;

const ORG = 'org-1';
const FAMILY_FIELDS = [
  'body_area',
  'context',
  'expected_return_date',
  'injury_date',
  'injury_id',
  'injury_type',
  'reported_by',
  'returned_on',
];

// A data-layer row WIDER than the projection, as a regression there would
// produce: the route must still send none of the staff fields.
const WIDE_ROW = {
  injury_id: 'inj-1',
  injury_date: '2026-09-01',
  body_area: 'wrist',
  injury_type: 'sprain_strain',
  context: 'training',
  reported_by: 'athlete',
  expected_return_date: '2026-09-10',
  returned_on: null,
  staff_note: 'Coach thinks he exaggerates.',
  recorded_by_account_id: 'acct-coach-1',
  updated_by_account_id: 'acct-coach-1',
  linked_hold_id: 'hold-1',
  organization_id: ORG,
};

function as(role: string, athleteId: string | null = null) {
  mockPrincipal.mockResolvedValue({ accountId: `acct-${role}`, role, organizationId: ORG, athleteId });
}

function req(query = '') {
  return new NextRequest(`http://localhost/api/pilot/athlete/injuries${query}`);
}

beforeEach(() => {
  jest.resetAllMocks();
  mockAccess.mockResolvedValue(undefined);
  mockList.mockResolvedValue([WIDE_ROW]);
});

describe.each(['coach', 'organization_admin', 'admin', 'platform_owner', 'board', 'volunteer', 'staff'])(
  'role %s',
  (role) => {
    test('is refused before anything is read', async () => {
      as(role);
      const res = await GET(req('?athlete_id=ATH-1'));
      expect(res.status).toBe(403);
      expect(mockAccess).not.toHaveBeenCalled();
      expect(mockList).not.toHaveBeenCalled();
    });
  },
);

describe('an athlete', () => {
  test('reads only their own record, whatever athlete_id the URL names, with no staff field', async () => {
    as('athlete', 'ATH-SELF');
    const res = await GET(req('?athlete_id=ATH-OTHER'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ role: 'athlete' }), 'ATH-SELF');
    expect(mockList).toHaveBeenCalledWith(ORG, 'ATH-SELF');
    const body = await res.json();
    expect(Object.keys(body.injuries[0]).sort()).toEqual(FAMILY_FIELDS);
    expect(JSON.stringify(body)).not.toContain('exaggerates');
  });

  test('an account with no athlete record is a 400 and nothing is read', async () => {
    as('athlete', null);
    expect((await GET(req())).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('a refused athlete (record deleted) gets 403, not an empty list', async () => {
    as('athlete', 'ATH-SELF');
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
    expect((await GET(req())).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('a parent', () => {
  test('reads a linked child with no staff field', async () => {
    as('parent');
    const res = await GET(req('?athlete_id=ATH-CHILD'));
    expect(res.status).toBe(200);
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ role: 'parent' }), 'ATH-CHILD');
    const body = await res.json();
    expect(Object.keys(body.injuries[0]).sort()).toEqual(FAMILY_FIELDS);
    expect(JSON.stringify(body)).not.toContain('exaggerates');
    expect(JSON.stringify(body)).not.toContain('acct-coach-1');
  });

  test('is refused a child they are not linked to, and nothing is read', async () => {
    as('parent');
    mockAccess.mockRejectedValue(new Error('Forbidden: parent not linked to athlete'));
    const res = await GET(req('?athlete_id=ATH-NOT-MINE'));
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('must name the child', async () => {
    as('parent');
    expect((await GET(req())).status).toBe(400);
    expect(mockAccess).not.toHaveBeenCalled();
  });
});
