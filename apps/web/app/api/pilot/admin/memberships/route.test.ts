import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createMembership,
  listMemberships,
  setMembershipScholarship,
  setMembershipStatus,
} from '@/src/server/pilot/programMemberships';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/programMemberships', () => {
  const actual = jest.requireActual('@/src/server/pilot/programMemberships');
  return {
    ...actual,
    createMembership: jest.fn(),
    listMemberships: jest.fn(),
    setMembershipScholarship: jest.fn(),
    setMembershipStatus: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createMembership as jest.Mock;
const mockList = listMemberships as jest.Mock;
const mockScholarship = setMembershipScholarship as jest.Mock;
const mockStatus = setMembershipStatus as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = () => new NextRequest('http://localhost/api/pilot/admin/memberships');

const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/admin/memberships', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('coaches, parents, and athletes have no access -- these are family-finance-adjacent admin records', async () => {
  for (const role of ['coach', 'parent', 'athlete'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
    expect((await POST(bodyRequest('POST', { athlete_id: 'a', program_name: 'P', started_on: '2026-09-01' }))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockList).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

test('an enrollment is filed under the caller organization and account', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue({ membership_id: 'mem-1' });

  const response = await POST(bodyRequest('POST', {
    athlete_id: ' ath-1 ',
    program_name: '  Youth Boxing  ',
    started_on: '2026-09-01',
    scholarship_percent: 100,
  }));

  expect(response.status).toBe(200);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    programName: 'Youth Boxing',
    startedOn: '2026-09-01',
    scholarshipPercent: 100,
    createdByAccountId: 'acct-1',
  }));
});

test('an athlete outside the organization is a hidden not-found, not an enrollment', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue(null);

  expect((await POST(bodyRequest('POST', { athlete_id: 'ath-other', program_name: 'P', started_on: '2026-09-01' }))).status).toBe(404);
});

test('a duplicate active enrollment answers 409', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockRejectedValue(new Error('MEMBERSHIP_DUPLICATE_ACTIVE: athlete already has an active membership in this program'));

  const response = await POST(bodyRequest('POST', { athlete_id: 'ath-1', program_name: 'P', started_on: '2026-09-01' }));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(payload.error).toMatch(/already has an active membership/i);
});

test('a scholarship outside 0-100 is refused before any write', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(bodyRequest('POST', { athlete_id: 'a', program_name: 'P', started_on: '2026-09-01', scholarship_percent: 150 }))).status).toBe(400);
  expect((await PATCH(bodyRequest('PATCH', { membership_id: 'mem-1', scholarship_percent: -5 }))).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockScholarship).not.toHaveBeenCalled();
});

test('one act per PATCH: status and scholarship together are refused', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await PATCH(bodyRequest('PATCH', { membership_id: 'mem-1', status: 'lapsed', scholarship_percent: 50 }));

  expect(response.status).toBe(400);
  expect(mockStatus).not.toHaveBeenCalled();
  expect(mockScholarship).not.toHaveBeenCalled();
});

test('a status move routes to the transition table; unknown status is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockStatus.mockResolvedValue({ membership_id: 'mem-1' });

  await PATCH(bodyRequest('PATCH', { membership_id: 'mem-1', status: 'lapsed' }));
  expect(mockStatus).toHaveBeenCalledWith({ organizationId: 'org-1', membershipId: 'mem-1', status: 'lapsed' });

  expect((await PATCH(bodyRequest('PATCH', { membership_id: 'mem-1', status: 'paused' }))).status).toBe(400);
});

test('a scholarship change is attributed to the membership in the caller org only', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockScholarship.mockResolvedValue(null);

  const response = await PATCH(bodyRequest('PATCH', { membership_id: 'mem-other-org', scholarship_percent: 50 }));

  expect(response.status).toBe(404);
  expect(mockScholarship).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
});
