import { NextRequest } from 'next/server';

import { GET } from './route';
import { getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getCoachIntelligence } from '@/src/server/pilot/coachIntelligence';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthletesForCoach: jest.fn(),
  getAthletesByOrganization: jest.fn(),
}));

jest.mock('@/src/server/pilot/coachIntelligence', () => {
  const actual = jest.requireActual('@/src/server/pilot/coachIntelligence');
  return { ...actual, getCoachIntelligence: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockForCoach = getAthletesForCoach as jest.Mock;
const mockByOrg = getAthletesByOrganization as jest.Mock;
const mockDigest = getCoachIntelligence as jest.Mock;

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

const getRequest = () => new NextRequest('http://localhost/api/pilot/coach/intelligence');

test('a coach reads their own roster, not the organization', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockForCoach.mockResolvedValue([{ athlete_id: 'ath-1' }]);
  mockDigest.mockResolvedValue({ stalled_gaps: [] });

  expect((await GET(getRequest())).status).toBe(200);
  expect(mockForCoach).toHaveBeenCalledWith('org-1', 'acct-1');
  expect(mockByOrg).not.toHaveBeenCalled();
  expect(mockDigest).toHaveBeenCalledWith('org-1', ['ath-1']);
});

test('an admin reads the organization roster', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  mockByOrg.mockResolvedValue([{ athlete_id: 'ath-2' }]);
  mockDigest.mockResolvedValue({ stalled_gaps: [] });

  await GET(getRequest());

  expect(mockByOrg).toHaveBeenCalledWith('org-1');
});

test('the safety registers reach the caller unfiltered', async () => {
  // The route is a pass-through by design: the digest already applied every
  // scope and exclusion. Pinned because a well-meaning "tidy the payload"
  // edit here would silently restore the exact defect items 6 and 7 fixed --
  // a coach reading an empty morning read over an open safeguarding record.
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockForCoach.mockResolvedValue([{ athlete_id: 'ath-1' }]);
  mockDigest.mockResolvedValue({
    open_safety_escalations: [{ athlete_id: 'ath-1', escalation_id: 'esc-1', severity: 'critical' }],
    open_compliance_violations: [{ athlete_id: 'ath-1', violation_id: 'violation_1', severity: 'high' }],
    stalled_gaps: [],
  });

  const response = await GET(getRequest());
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.open_safety_escalations).toHaveLength(1);
  expect(body.open_compliance_violations).toHaveLength(1);
});

test('parents, athletes, and platform_owner get nothing -- this is a staff lens', async () => {
  for (const role of ['parent', 'athlete', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockDigest).not.toHaveBeenCalled();
});
