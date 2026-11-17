import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getMedicalRestrictionById,
  recordLbcInformed,
  recordMedicalRestriction,
  recordRelease,
  voidMedicalRestriction,
} from '@/src/server/pilot/medicalRestrictions';

/*
 * The route over medicalRestrictions.ts with the module mocked. Who reaches
 * which athlete, the set-once writes and the database refusals are proven
 * against real rows in medicalRestrictions.pg.test.ts; this file asserts what
 * only the route decides: the role gate, the strict body, date parsing, that
 * a date on file cannot be in the future, that the actor is the SESSION's,
 * and that a coach is refused a void before any row is read.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/competenceCohorts', () => ({ gymToday: () => '2026-11-15' }));

jest.mock('@/src/server/pilot/medicalRestrictions', () => {
  const actual = jest.requireActual('@/src/server/pilot/medicalRestrictions');
  return {
    ...actual,
    getMedicalRestrictionById: jest.fn(),
    listMedicalRestrictions: jest.fn(async () => []),
    recordMedicalRestriction: jest.fn(),
    recordRelease: jest.fn(),
    recordLbcInformed: jest.fn(),
    voidMedicalRestriction: jest.fn(),
  };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockGet = getMedicalRestrictionById as jest.Mock;
const mockRecord = recordMedicalRestriction as jest.Mock;
const mockRelease = recordRelease as jest.Mock;
const mockLbc = recordLbcInformed as jest.Mock;
const mockVoid = voidMedicalRestriction as jest.Mock;

const as = (role: string) => ({
  accountId: `acct-${role}`, role, organizationId: 'org-1', athleteId: role === 'athlete' ? 'ath-1' : null,
  sessionToken: 'test-token', authProvider: 'microsoft',
});

const ID = '0b6b6c4e-6f43-4b8e-9b51-3c2f6d1e9a10';
const ROW = {
  restriction_id: ID, athlete_id: 'ath-1', source: 'other', loss_of_consciousness: 'none',
  start_date: '2026-10-01', minimum_end_date: '2026-10-30', release_signed_on: null, voided_at: null,
};

const RECORD = {
  action: 'record', athlete_id: 'ath-1', source: 'other', loss_of_consciousness: 'none',
  start_date: '2026-10-01', minimum_end_date: '2026-10-30',
};

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/coach/medical-restrictions', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
  mockGet.mockResolvedValue(ROW);
  mockRecord.mockResolvedValue(ROW);
  mockRelease.mockResolvedValue({ ...ROW, release_signed_on: '2026-11-01' });
  mockLbc.mockResolvedValue(ROW);
  mockVoid.mockResolvedValue({ ...ROW, voided_at: '2026-11-15T00:00:00Z' });
});

afterEach(() => jest.clearAllMocks());

test.each(['athlete', 'parent', 'volunteer', 'board', 'platform_owner'])('%s is refused before the module runs', async (role) => {
  mockPrincipal.mockResolvedValue(as(role));
  expect((await GET(new NextRequest('http://localhost/api/pilot/coach/medical-restrictions?athlete_id=ath-1'))).status).toBe(403);
  expect((await post(RECORD)).status).toBe(403);
  expect(mockRecord).not.toHaveBeenCalled();
});

test('the recorder is the session, never the body', async () => {
  mockPrincipal.mockResolvedValue(as('coach'));
  expect((await post(RECORD)).status).toBe(201);
  expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1', actorAccountId: 'acct-coach', actorRole: 'coach', athleteId: 'ath-1',
  }));
});

test.each([
  ['an unknown key', { ...RECORD, recorded_by_account_id: 'someone-else' }],
  ['an unknown action', { ...RECORD, action: 'lift' }],
  ['a bad source', { ...RECORD, source: 'rumour' }],
  ['a bad loss-of-consciousness value', { ...RECORD, loss_of_consciousness: 'maybe' }],
  // OW25-36 A: Save needs both. The route refuses a missing answer too, not
  // only the form: absent, empty (the form's "Choose…") or null.
  ['no source', { ...RECORD, source: undefined }],
  ['an empty source', { ...RECORD, source: '' }],
  ['a null source', { ...RECORD, source: null }],
  ['no loss-of-consciousness answer', { ...RECORD, loss_of_consciousness: undefined }],
  ['an empty loss-of-consciousness answer', { ...RECORD, loss_of_consciousness: '' }],
  ['a null loss-of-consciousness answer', { ...RECORD, loss_of_consciousness: null }],
  ['neither answer', { ...RECORD, source: '', loss_of_consciousness: '' }],
  ['a date that is not real', { ...RECORD, start_date: '2026-02-30' }],
  ['a date not written YYYY-MM-DD', { ...RECORD, minimum_end_date: '10/30/2026' }],
  ['an end before the start', { ...RECORD, minimum_end_date: '2026-09-30' }],
])('record refuses %s', async (_label, body) => {
  mockPrincipal.mockResolvedValue(as('coach'));
  expect((await post(body)).status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

test('a release date after today, or before the start, is refused', async () => {
  mockPrincipal.mockResolvedValue(as('coach'));
  expect((await post({ action: 'release', restriction_id: ID, release_signed_on: '2026-11-16' })).status).toBe(400);
  expect((await post({ action: 'release', restriction_id: ID, release_signed_on: '2026-09-30' })).status).toBe(400);
  expect((await post({ action: 'lbc_informed', restriction_id: ID, lbc_informed_on: '2026-11-16' })).status).toBe(400);
  expect(mockRelease).not.toHaveBeenCalled();
  expect((await post({ action: 'release', restriction_id: ID, release_signed_on: '2026-11-15' })).status).toBe(200);
});

test('a restriction the caller cannot reach is the same 404 as one that does not exist', async () => {
  mockPrincipal.mockResolvedValue(as('coach'));
  mockAccess.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
  const reached = await post({ action: 'release', restriction_id: ID, release_signed_on: '2026-11-01' });
  mockGet.mockResolvedValue(null);
  mockAccess.mockResolvedValue(undefined);
  const missing = await post({ action: 'release', restriction_id: ID, release_signed_on: '2026-11-01' });
  const notUuid = await post({ action: 'release', restriction_id: 'not-a-uuid', release_signed_on: '2026-11-01' });
  expect([reached.status, missing.status, notUuid.status]).toEqual([404, 404, 404]);
  expect((await reached.json()).error).toBe((await missing.json()).error);
  expect(mockRelease).not.toHaveBeenCalled();
});

test('a coach is refused a void before any row is read; an admin needs a reason', async () => {
  mockPrincipal.mockResolvedValue(as('coach'));
  expect((await post({ action: 'void', restriction_id: ID, reason: 'wrong member' })).status).toBe(403);
  expect(mockGet).not.toHaveBeenCalled();
  mockPrincipal.mockResolvedValue(as('organization_admin'));
  expect((await post({ action: 'void', restriction_id: ID, reason: '   ' })).status).toBe(400);
  expect((await post({ action: 'void', restriction_id: ID, reason: 'wrong member' })).status).toBe(200);
  expect(mockVoid).toHaveBeenCalledWith(expect.objectContaining({ actorRole: 'organization_admin', reason: 'wrong member' }));
});
