import { NextRequest } from 'next/server';

import { POST } from './route';
import { ConflictError } from '@/src/server/pilot/errors';
import { moveGuardianToLogin } from '@/src/server/pilot/guardianLoginMove';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

// jsonError stays real: the status a refusal reaches the screen with is part
// of what is under test.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/guardianLoginMove', () => ({
  moveGuardianToLogin: jest.fn(),
}));

const mockPrincipal = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockMove = jest.mocked(moveGuardianToLogin);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'admin-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as never;
}

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/admin/guardian-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } as never);
}

const BODY = { parent_id: 'par-1', from_account_id: 'old', to_account_id: 'new' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue(principal('organization_admin'));
  mockMove.mockResolvedValue({ parentId: 'par-1', fromAccountId: 'old', toAccountId: 'new', athleteIds: ['ath-1'], oldLoginSwitchedOff: true });
});

test('an organization admin moves the record in their own organization, not one the body names', async () => {
  const response = await POST(post({ ...BODY, organization_id: 'org-other' }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    parent_id: 'par-1',
    from_account_id: 'old',
    to_account_id: 'new',
    athlete_ids: ['ath-1'],
    old_login_switched_off: true,
  });
  expect(mockMove).toHaveBeenCalledWith({
    organizationId: 'org-1',
    parentId: 'par-1',
    fromAccountId: 'old',
    toAccountId: 'new',
    actor: { accountId: 'admin-1', role: 'organization_admin' },
  });
});

test.each(['platform_owner', 'coach', 'parent', 'staff', 'athlete'])('refuses %s with 403 and moves nothing', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));

  const response = await POST(post(BODY));

  expect(response.status).toBe(403);
  expect(mockMove).not.toHaveBeenCalled();
});

test('a session that is not a Microsoft sign-in is refused before anything else', async () => {
  mockPrincipal.mockRejectedValue(new Error('Forbidden: Microsoft-authenticated session required'));

  const response = await POST(post(BODY));

  expect(response.status).toBe(403);
  expect(mockMove).not.toHaveBeenCalled();
});

test('a refusal from the move reaches the screen with its status and code', async () => {
  mockMove.mockRejectedValue(new ConflictError('Conflict: changed', 'GUARDIAN_LOGIN_CHANGED'));

  const response = await POST(post(BODY));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(JSON.stringify(payload)).toContain('GUARDIAN_LOGIN_CHANGED');
});

test('non-string fields arrive as empty, so the move refuses them as missing', async () => {
  await POST(post({ parent_id: 7, from_account_id: ['old'], to_account_id: null }));

  expect(mockMove).toHaveBeenCalledWith(expect.objectContaining({ parentId: '', fromAccountId: '', toAccountId: '' }));
});

test('a body of null arrives as empty fields, not a server error', async () => {
  const response = await POST(new NextRequest('https://ppbf.example/api/pilot/admin/guardian-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'null',
  } as never));

  expect(response.status).toBe(200);
  expect(mockMove).toHaveBeenCalledWith(expect.objectContaining({ parentId: '', fromAccountId: '', toAccountId: '' }));
});
