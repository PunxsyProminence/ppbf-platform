import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { readAthleteHeights, recordAndSummarize } from '@/src/server/pilot/athleteHeights';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The route over athleteHeights.ts. Who may reach which athlete is proven against real rows in
 * athleteHeights.pg.test.ts; with the module mocked, this file asserts what only the route
 * decides: which roles are refused before the module runs, that the identity handed down is the
 * SESSION's and never anything in the body, how the body is parsed, and that a retry says it
 * wrote nothing. The audit row is the module's (athleteHeights.pg.test.ts).
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteHeights', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteHeights');
  return { ...actual, readAthleteHeights: jest.fn(), recordAndSummarize: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readAthleteHeights as jest.Mock;
const mockRecord = recordAndSummarize as jest.Mock;

const COACH = {
  accountId: 'acct-coach',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'secret-token',
  authProvider: 'microsoft',
};
const ACTOR = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };

const READING = {
  height_id: '11111111-1111-4111-8111-111111111111',
  measured_on: '2026-10-16',
  height_cm: 151.4,
  recorded_by_role: 'coach',
  recorded_at: '2026-10-16T18:00:00.000Z',
  supersedes_height_id: null,
  superseded: false,
};
const SUMMARY = { readings: [READING], latest: READING, growth: null };

function get(query: string) {
  return new NextRequest(`http://localhost/api/pilot/coach/athlete-height${query}`);
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/pilot/coach/athlete-height', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID = { athlete_id: 'ath-1', height_cm: 151.4, measured_on: '2026-10-16', request_key: 'save-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue(COACH);
  mockRead.mockResolvedValue(SUMMARY);
  mockRecord.mockResolvedValue({ reading: READING, created: true, summary: SUMMARY });
});

describe.each(['athlete', 'parent', 'board', 'volunteer', 'platform_owner', 'staff'])('a %s session', (role) => {
  test('is refused before the module runs, on both methods', async () => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    expect((await GET(get('?athlete_id=ath-1'))).status).toBe(403);
    expect((await POST(post(VALID))).status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

test('GET hands the session identity and the athlete id to the module and answers the summary', async () => {
  const response = await GET(get('?athlete_id=ath-1'));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(mockRead).toHaveBeenCalledWith(ACTOR, 'ath-1');
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, readings: [READING], latest: READING, growth: null, growth_min_days: 60 });
});

test('GET without an athlete id is a 400', async () => {
  expect((await GET(get(''))).status).toBe(400);
  expect(mockRead).not.toHaveBeenCalled();
});

test('POST records with the session identity; nothing in the body can change who records', async () => {
  const response = await POST(post({ ...VALID, account_id: 'acct-someone-else', role: 'admin', organization_id: 'org-2' }));
  expect(response.status).toBe(201);
  expect(mockRecord).toHaveBeenCalledWith(ACTOR, {
    athleteId: 'ath-1',
    heightCm: 151.4,
    measuredOn: '2026-10-16',
    requestKey: 'save-1',
    supersedesHeightId: null,
  });
  expect((await response.json()).created).toBe(true);
});

test('a retry the module says wrote nothing answers created: false', async () => {
  mockRecord.mockResolvedValue({ reading: READING, created: false, summary: SUMMARY });
  const response = await POST(post(VALID));
  expect(response.status).toBe(201);
  expect((await response.json()).created).toBe(false);
});

test('a correction hands the reading it replaces to the module', async () => {
  const replaced = '22222222-2222-4222-8222-222222222222';
  await POST(post({ ...VALID, supersedes_height_id: replaced.toUpperCase() }));
  expect(mockRecord.mock.calls[0][1]).toMatchObject({ supersedesHeightId: replaced });
});

test.each([
  ['a height as text', { height_cm: '151.4' }],
  ['a height below the bounds', { height_cm: 49.9 }],
  ['a height above the bounds', { height_cm: 250.1 }],
  ['no request key', { request_key: undefined }],
  ['a blank request key', { request_key: '   ' }],
  ['a date that is not a date', { measured_on: '2026-02-30' }],
  ['a date before 2000', { measured_on: '1999-12-31' }],
  ['a correction id that is not a reading id', { supersedes_height_id: 'not-a-uuid' }],
  ['no athlete', { athlete_id: '' }],
])('%s is a 400 and nothing is recorded', async (_label, change) => {
  const response = await POST(post({ ...VALID, ...change }));
  expect(response.status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

test('a date in the future at the gym is refused', async () => {
  const response = await POST(post({ ...VALID, measured_on: '2999-01-01' }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatch(/has not happened yet/);
});

test('no measured_on means today at the gym', async () => {
  const { measured_on: _omitted, ...withoutDate } = VALID;
  await POST(post(withoutDate));
  expect(mockRecord.mock.calls[0][1].measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('one decimal is kept and a longer one is rounded', async () => {
  await POST(post({ ...VALID, height_cm: 151.46 }));
  await POST(post({ ...VALID, height_cm: 151.44 }));
  expect(mockRecord.mock.calls.map((call) => call[1].heightCm)).toEqual([151.5, 151.4]);
});
