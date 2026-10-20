import { NextRequest } from 'next/server';

import { POST } from './route';
import { heightAccessibleAthleteIds } from '@/src/server/pilot/athleteHeights';
import { requirePrincipal } from '@/src/server/pilot/http';
import { recordTestDay } from '@/src/server/pilot/testDay';

/*
 * The route over testDay.ts. Who may record for whom, all-or-nothing and once are proven against
 * real rows in testDay.pg.test.ts; with the module mocked, this file asserts what only the route
 * and the parser decide: roles refused first, the session identity handed down, the body parsed
 * whole (one bad cell refuses the save). The audit rows are the module's (testDay.pg.test.ts).
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/athleteHeights', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteHeights');
  return { ...actual, heightAccessibleAthleteIds: jest.fn() };
});
jest.mock('@/src/server/pilot/testDay', () => {
  const actual = jest.requireActual('@/src/server/pilot/testDay');
  return { ...actual, recordTestDay: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRecord = recordTestDay as jest.Mock;
const mockAccessible = heightAccessibleAthleteIds as jest.Mock;

const COACH = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null, sessionToken: 't', authProvider: 'microsoft' };
const ACTOR = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };

const FORM = {
  administered_on: '2026-10-16',
  request_key: 'save-1',
  rows: [{ athlete_id: 'ath-1', height_cm: 151.4, cmj_cm: 31.5, broad_cm: '', shuttle_level: 7, shuttle_number: 4 }],
};

function post(body: unknown) {
  return new NextRequest('http://localhost/api/pilot/coach/test-day', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue(COACH);
  mockRecord.mockResolvedValue({ written: 3, already_saved: 0, earlier_not_on_form: [] });
  mockAccessible.mockResolvedValue(new Set(['ath-1']));
});

test.each(['athlete', 'parent', 'board', 'volunteer', 'platform_owner'])('a %s session is refused before anything runs', async (role) => {
  mockPrincipal.mockResolvedValue({ ...COACH, role });
  expect((await POST(post(FORM))).status).toBe(403);
  expect((await POST(post({ action: 'accessible_athletes', athlete_ids: ['ath-1'] }))).status).toBe(403);
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockAccessible).not.toHaveBeenCalled();
});

test('the save hands the session identity and the parsed form down', async () => {
  const response = await POST(post({ ...FORM, account_id: 'someone-else' }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ ok: true, written: 3, already_saved: 0, earlier_not_on_form: [] });
  expect(mockRecord).toHaveBeenCalledWith(ACTOR, {
    administeredOn: '2026-10-16',
    requestKey: 'save-1',
    rows: [{
      athleteId: 'ath-1',
      heightCm: 151.4,
      jumps: [{ protocolId: 'ppbf-jump-cmj-height', valueCm: 31.5 }],
      shuttle: { level: 7, shuttle: 4 },
    }],
  });
});

test('a retry answers what the module found, including cells an earlier attempt saved', async () => {
  mockRecord.mockResolvedValue({ written: 0, already_saved: 2, earlier_not_on_form: [{ athlete_id: 'ath-1', measure: 'ppbf-jump-cmj-height' }] });
  const response = await POST(post(FORM));
  expect(await response.json()).toMatchObject({ written: 0, already_saved: 2, earlier_not_on_form: [{ athlete_id: 'ath-1' }] });
});

test('an unknown action is refused, not saved', async () => {
  expect((await POST(post({ ...FORM, action: 'delete_everything' }))).status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

test.each([
  ['no rows', { rows: [] }],
  ['a row with nothing in it', { rows: [{ athlete_id: 'ath-1', height_cm: '', cmj_cm: null }] }],
  ['the same athlete twice', { rows: [FORM.rows[0], FORM.rows[0]] }],
  ['a height out of bounds', { rows: [{ athlete_id: 'ath-1', height_cm: 251 }] }],
  ['a jump as text', { rows: [{ athlete_id: 'ath-1', cmj_cm: '31.5' }] }],
  ['a jump in millimetres', { rows: [{ athlete_id: 'ath-1', broad_cm: 1720 }] }],
  ['a shuttle level with no shuttle', { rows: [{ athlete_id: 'ath-1', shuttle_level: 7 }] }],
  ['a shuttle with no level', { rows: [{ athlete_id: 'ath-1', shuttle_number: 4 }] }],
  ['a shuttle level of 0', { rows: [{ athlete_id: 'ath-1', shuttle_level: 0, shuttle_number: 4 }] }],
  ['a shuttle level of 22', { rows: [{ athlete_id: 'ath-1', shuttle_level: 22, shuttle_number: 4 }] }],
  ['a shuttle of 17', { rows: [{ athlete_id: 'ath-1', shuttle_level: 7, shuttle_number: 17 }] }],
  ['a fractional shuttle', { rows: [{ athlete_id: 'ath-1', shuttle_level: 7.5, shuttle_number: 4 }] }],
  ['no request key', { request_key: '' }],
  ['a future date', { administered_on: '2999-01-01' }],
  ['a row with no athlete', { rows: [{ athlete_id: ' ', height_cm: 150 }] }],
  ['101 rows', { rows: Array.from({ length: 101 }, (_, i) => ({ athlete_id: `ath-${i}`, height_cm: 150 })) }],
])('%s refuses the whole save and nothing is recorded', async (_label, change) => {
  const response = await POST(post({ ...FORM, ...change }));
  expect(response.status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

test('accessible_athletes answers the subset the seat may record for, in the order asked', async () => {
  mockAccessible.mockResolvedValue(new Set(['ath-3', 'ath-1']));
  const response = await POST(post({ action: 'accessible_athletes', athlete_ids: ['ath-1', 'ath-2', 'ath-3'] }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, athlete_ids: ['ath-1', 'ath-3'], max_rows: 100 });
  expect(mockAccessible).toHaveBeenCalledWith(ACTOR, ['ath-1', 'ath-2', 'ath-3']);
  expect((await POST(post({ action: 'accessible_athletes', athlete_ids: 'ath-1' }))).status).toBe(400);
});
