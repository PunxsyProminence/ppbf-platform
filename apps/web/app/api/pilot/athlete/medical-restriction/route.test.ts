import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertAthleteBelongsToOrganization } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { familyMedicalRestriction } from '@/src/server/pilot/medicalRestrictions';

// The route's wiring: who reaches it, and whose record it reads. The three
// fields themselves are built and held to an exact key set against real rows
// in medicalRestrictions.pg.test.ts, through this route.

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertAthleteBelongsToOrganization: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/medicalRestrictions', () => ({
  familyMedicalRestriction: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockBelongs = jest.mocked(assertAthleteBelongsToOrganization);
const mockRead = jest.mocked(familyMedicalRestriction);

const IN_FORCE = { on_file: true as const, minimum_end_date: '2026-12-01', release_needed: true };

function principal(role: string, athleteId: string | null = null) {
  return {
    accountId: `acct-${role}`, role, organizationId: 'org-a', athleteId, sessionToken: 't', authProvider: 'microsoft',
  } as never;
}

function get(query = '') {
  return GET(new NextRequest(`http://localhost/api/pilot/athlete/medical-restriction${query}`));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBelongs.mockResolvedValue(undefined);
  mockRead.mockResolvedValue(null);
});

test("the member reads their own restriction, from the session's athlete id", async () => {
  mockPrincipal.mockResolvedValueOnce(principal('athlete', 'ath-1'));
  mockRead.mockResolvedValueOnce(IN_FORCE);

  const response = await get();

  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({ ok: true, medical_restriction: IN_FORCE });
  expect(mockBelongs).toHaveBeenCalledWith('org-a', 'ath-1');
  expect(mockRead).toHaveBeenCalledWith('org-a', 'ath-1');
});

test('an athlete_id parameter is ignored: there is no way to read another member', async () => {
  mockPrincipal.mockResolvedValueOnce(principal('athlete', 'ath-1'));

  await get('?athlete_id=ath-2');

  expect(mockRead.mock.calls).toEqual([['org-a', 'ath-1']]);
});

test('nothing in force reads as null', async () => {
  mockPrincipal.mockResolvedValueOnce(principal('athlete', 'ath-1'));

  expect(await (await get()).json()).toStrictEqual({ ok: true, medical_restriction: null });
});

test('an athlete login with no athlete record reads null without a read', async () => {
  mockPrincipal.mockResolvedValueOnce(principal('athlete', null));

  expect(await (await get()).json()).toStrictEqual({ ok: true, medical_restriction: null });
  expect(mockRead).not.toHaveBeenCalled();
});

test('a session whose athlete record is gone is refused before any read', async () => {
  mockPrincipal.mockResolvedValueOnce(principal('athlete', 'ath-1'));
  mockBelongs.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));

  expect((await get()).status).toBe(403);
  expect(mockRead).not.toHaveBeenCalled();
});

test.each(['coach', 'organization_admin', 'admin', 'parent', 'platform_owner', 'board'])(
  '%s is refused: the member route is self only',
  async (role) => {
    mockPrincipal.mockResolvedValueOnce(principal(role, 'ath-1'));

    expect((await get()).status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  },
);
