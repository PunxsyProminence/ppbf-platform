// The gym's profile route (lane L31 P3): the organization admin of the
// session's gym only; the platform owner is refused (gym work); the legal
// name is returned read-only and never written.

import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { readStoredProfileInput, saveOrganizationProfile } from '@/src/server/pilot/organizationProfileWrite';
import { getOrganizationName } from '@/src/server/pilot/staffProvisioning';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/organizationProfileWrite', () => ({
  readStoredProfileInput: jest.fn(),
  saveOrganizationProfile: jest.fn(),
}));
jest.mock('@/src/server/pilot/staffProvisioning', () => ({ getOrganizationName: jest.fn() }));

const mockPrincipal = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockRead = jest.mocked(readStoredProfileInput);
const mockSave = jest.mocked(saveOrganizationProfile);
const mockName = jest.mocked(getOrganizationName);

function as(role: string) {
  mockPrincipal.mockResolvedValue({ accountId: `${role}-1`, organizationId: 'gym-1', role } as never);
}

const request = (method: 'GET' | 'POST', body?: unknown) =>
  new NextRequest('http://localhost/api/pilot/admin/organization-profile', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue({ brand: 'Ridgeway' } as never);
  mockName.mockResolvedValue('Ridgeway Lantern Boxing and Fitness');
  mockSave.mockImplementation(async (_org, raw) => raw as never);
});

test.each(['organization_admin', 'admin'])('a %s reads its own gym profile and legal name', async (role) => {
  as(role);
  const response = await GET(request('GET'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    organization_id: 'gym-1',
    legal_name: 'Ridgeway Lantern Boxing and Fitness',
    profile: { brand: 'Ridgeway' },
  });
  expect(mockRead).toHaveBeenCalledWith('gym-1');
});

test('a save goes to the session gym, with the actor named, whatever gym the body names', async () => {
  as('organization_admin');
  const response = await POST(request('POST', { profile: { brand: 'X' }, organization_id: 'another-gym' }));
  expect(response.status).toBe(200);
  expect(mockSave).toHaveBeenCalledWith('gym-1', { brand: 'X' }, { accountId: 'organization_admin-1', role: 'organization_admin' });
});

test.each(['platform_owner', 'coach', 'staff', 'parent', 'athlete', 'board'])('a %s is refused, and nothing is read or saved', async (role) => {
  as(role);
  expect((await GET(request('GET'))).status).toBe(403);
  expect((await POST(request('POST', { profile: {} }))).status).toBe(403);
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

test('a session that did not sign in with Microsoft is refused', async () => {
  mockPrincipal.mockRejectedValue(new Error('Forbidden: Microsoft-authenticated session required'));
  expect((await POST(request('POST', { profile: {} }))).status).toBe(403);
  expect(mockSave).not.toHaveBeenCalled();
});

test('a profile the rules refuse answers 400 naming the field', async () => {
  as('organization_admin');
  const { ValidationError } = jest.requireActual('@/src/server/pilot/errors');
  mockSave.mockRejectedValue(new ValidationError('domain is required'));
  const response = await POST(request('POST', { profile: { brand: 'X' } }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe('domain is required');
});
