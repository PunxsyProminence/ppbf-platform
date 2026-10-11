import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getOrganizationClearedTonight, type ClearedTonight } from '@/src/server/pilot/clearedTonight';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/clearedTonight', () => ({
  getOrganizationClearedTonight: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGetStatus = jest.mocked(getOrganizationClearedTonight);

// One athlete's answer, as clearedTonight.ts hands it over (already in the
// shape the route sends).
const TONIGHT: ClearedTonight = {
  answer: 'cleared_no_contact',
  hold: { scope: 'contact_only', athlete_explanation: 'No sparring this week.', lift_condition_text: 'Coach sign-off.', expires_at: null },
  medical: { status: 'cleared', current: true, expires_at: null },
  waivers: [
    { type: 'general', status: 'signed', recorded_on: '2026-09-02' },
    { type: 'medical_release', status: 'missing', recorded_on: null },
    { type: 'travel', status: 'missing', recorded_on: null },
  ],
  media_consent: { basis: 'guardian', status: 'signed' },
  open_violations: 0,
};

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-admin',
    role: 'admin' as const,
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    ...overrides,
  };
}

function get(): Promise<Response> {
  return GET(new NextRequest('http://localhost/api/pilot/admin/waiver-status'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStatus.mockResolvedValue([]);
});

test('an admin gets the org-wide waiver status, snake_cased at the boundary', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGetStatus.mockResolvedValueOnce([
    {
      athleteId: 'ath-1',
      athleteName: 'Jordan T.',
      activeFlag: true,
      waivers: { general: 'signed', medical_release: 'missing', photo_media: 'signed', travel: 'missing' },
      tonight: TONIGHT,
    },
  ]);

  const response = await get();

  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.items).toEqual([
    {
      athlete_id: 'ath-1',
      athlete_name: 'Jordan T.',
      active_flag: true,
      waivers: { general: 'signed', medical_release: 'missing', photo_media: 'signed', travel: 'missing' },
      // The one cleared-tonight answer rides on the same row, copied as given.
      tonight: TONIGHT,
    },
  ]);
  expect(mockGetStatus).toHaveBeenCalledWith('org-a');
});

test.each(['organization_admin'] as const)('allows the %s role', async (role) => {
  mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

  const response = await get();

  expect(response.status).toBe(200);
});

test.each(['coach', 'athlete', 'parent', 'board', 'platform_owner', 'volunteer'] as const)(
  'denies the %s role',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, athleteId: role === 'athlete' ? 'ath-1' : null }));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mockGetStatus).not.toHaveBeenCalled();
  },
);
