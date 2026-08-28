import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import { WELLNESS_COLUMNS, checkIn } from '@/src/server/pilot/athleteCheckIns';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/athleteCheckIns', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteCheckIns');
  return {
    ...actual,
    checkIn: jest.fn(),
    getTodayCheckIn: jest.fn().mockResolvedValue(null),
    listRecentCheckIns: jest.fn().mockResolvedValue([]),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCheckIn = checkIn as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/athlete/check-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const getRequest = () => new NextRequest('http://localhost/api/pilot/athlete/check-in');

test('self only: no other role has a path, and there is no athlete_id parameter to aim elsewhere', async () => {
  for (const role of ['coach', 'parent', 'admin', 'organization_admin', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
    expect((await POST(postRequest({}))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockCheckIn).not.toHaveBeenCalled();

  // Even as an athlete, a body athlete_id is ignored -- the principal's own
  // athlete id is the only target.
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCheckIn.mockResolvedValue({ row: { check_in_id: 'ci-1', checked_in_on: '2026-08-16' }, created: true });
  await POST(postRequest({ athlete_id: 'ath-someone-else', energy: 4 }));
  expect(mockCheckIn).toHaveBeenCalledWith(expect.objectContaining({ athleteId: 'ath-1' }));
});

test('an athlete account with no athlete record cannot check in', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ athleteId: undefined }));
  expect((await POST(postRequest({}))).status).toBe(400);
  expect(mockCheckIn).not.toHaveBeenCalled();
});

test('wellness self-reports are optional; present values must be whole 1-5', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(postRequest({ energy: 8.2 }))).status).toBe(400);
  expect((await POST(postRequest({ soreness: 0 }))).status).toBe(400);
  expect((await POST(postRequest({ focus: 'good' }))).status).toBe(400);
  expect(mockCheckIn).not.toHaveBeenCalled();

  mockCheckIn.mockResolvedValue({ row: { check_in_id: 'ci-1', checked_in_on: '2026-08-16' }, created: true });
  const response = await POST(postRequest({ energy: 4, note: 'ready to work' }));
  expect(response.status).toBe(200);
  // Skipped fields go through as absent, never defaulted.
  expect(mockCheckIn).toHaveBeenCalledWith(expect.objectContaining({ energy: 4, soreness: undefined, focus: undefined }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ entity_type: 'athlete_check_in' }));
});

test('EVERY wellness column is validated, not just the three that shipped first', async () => {
  // Swept from WELLNESS_COLUMNS rather than listed by hand, because a list
  // written by hand here is exactly what the route used to have: the next
  // measure migration adds a column, the route forgets to validate it, and
  // the only thing that refuses a hydration of 47 is the database -- which
  // returns a Postgres error instead of the stated reason the contract
  // promises. This case fails the moment a column is added without validation.
  mockRequirePrincipal.mockResolvedValue(principal({}));

  for (const column of WELLNESS_COLUMNS) {
    for (const bad of [0, 6, 2.5, 'lots']) {
      const response = await POST(postRequest({ [column]: bad }));
      expect({ column, bad, status: response.status }).toEqual({ column, bad, status: 400 });
    }
  }
  expect(mockCheckIn).not.toHaveBeenCalled();
});

test('sleep is hours, so it takes half hours and refuses impossible days', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(postRequest({ sleep_hours: -1 }))).status).toBe(400);
  expect((await POST(postRequest({ sleep_hours: 25 }))).status).toBe(400);
  expect((await POST(postRequest({ sleep_hours: 'eight' }))).status).toBe(400);
  expect(mockCheckIn).not.toHaveBeenCalled();

  // 7.5 is the case the 1-5 wellness rule would have rejected: sleep is a
  // quantity and must not inherit the rating validator.
  mockCheckIn.mockResolvedValue({ row: { check_in_id: 'ci-1', checked_in_on: '2026-08-16' }, created: true });
  expect((await POST(postRequest({ sleep_hours: 7.5 }))).status).toBe(200);
  expect(mockCheckIn).toHaveBeenCalledWith(expect.objectContaining({ sleepHours: 7.5 }));
});

test('the extended measures reach the data layer under their own names', async () => {
  // The API speaks snake_case and the module speaks camelCase, so every one of
  // these crosses a rename. A field dropped in that crossing is stored as null
  // while the athlete is told it was saved -- silent, and indistinguishable
  // from having skipped the question.
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCheckIn.mockResolvedValue({ row: { check_in_id: 'ci-1', checked_in_on: '2026-08-16' }, created: true });

  await POST(postRequest({
    energy: 4, soreness: 2, focus: 3, sleep_hours: 8,
    hydration: 5, motivation: 4, mental_clarity: 3, stress: 1, nutrition_compliance: 2,
  }));

  expect(mockCheckIn).toHaveBeenCalledWith(expect.objectContaining({
    energy: 4,
    soreness: 2,
    focus: 3,
    sleepHours: 8,
    hydration: 5,
    motivation: 4,
    mentalClarity: 3,
    stress: 1,
    nutritionCompliance: 2,
  }));
});

test('a repeat check-in is idempotent: acknowledged, not double-counted, not re-audited', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCheckIn.mockResolvedValue({ row: { check_in_id: 'ci-1', checked_in_on: '2026-08-16' }, created: false });

  const response = await POST(postRequest({}));
  const payload = await response.json();
  expect(payload.already_checked_in).toBe(true);
  expect(mockAudit).not.toHaveBeenCalled();
});
