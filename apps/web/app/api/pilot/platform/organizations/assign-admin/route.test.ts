// Assigning a gym's admin is platform work, and it acts on a gym that is not
// the actor's own. The audit row has to land in the log of the gym whose admin
// list changed; it used to carry the platform owner's organization instead, so
// the target gym's log showed nothing.

import { NextRequest } from 'next/server';

import { POST } from './route';
import { promoteAccountToOrganizationAdmin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/auth', () => ({ promoteAccountToOrganizationAdmin: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockPromote = jest.mocked(promoteAccountToOrganizationAdmin);
const mockAudit = jest.mocked(writePilotAuditEvent);

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: `${role}-1`, organizationId: '__platform__', role,
  } as never);
}

function post(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/platform/organizations/assign-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  as('platform_owner');
  mockPromote.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined as never);
});

test('the audit row carries the organization acted on, not the actor\'s own', async () => {
  const response = await POST(post({ account_id: 'acct-9', organization_id: 'gym-b' }));

  expect(response.status).toBe(200);
  expect(mockPromote).toHaveBeenCalledWith('acct-9', 'gym-b');
  expect(mockAudit).toHaveBeenCalledTimes(1);
  expect(mockAudit).toHaveBeenCalledWith({
    event_type: 'update',
    actor_account_id: 'platform_owner-1',
    actor_role: 'platform_owner',
    organization_id: 'gym-b',
    entity_type: 'organization_membership',
    entity_id: 'gym-b:acct-9',
    details: { account_id: 'acct-9', organization_id: 'gym-b', role: 'organization_admin' },
  });
});

test('the promoted and the audited organization are the same trimmed value', async () => {
  await POST(post({ account_id: ' acct-9 ', organization_id: ' gym-b ' }));

  expect(mockPromote).toHaveBeenCalledWith('acct-9', 'gym-b');
  expect(mockAudit.mock.calls[0][0].organization_id).toBe('gym-b');
});

test('nothing is audited when the promotion fails', async () => {
  mockPromote.mockRejectedValueOnce(new Error('Not found: account'));

  const response = await POST(post({ account_id: 'acct-9', organization_id: 'gym-b' }));

  expect(response.status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a missing account or organization is a 400 and changes nothing', async () => {
  const response = await POST(post({ account_id: 'acct-9' }));

  expect(response.status).toBe(400);
  expect(mockPromote).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

// Unchanged by this lane: platform work stays the platform owner's.
test.each(['organization_admin', 'admin', 'coach'])('role %s is refused', async (role) => {
  as(role);

  const response = await POST(post({ account_id: 'acct-9', organization_id: 'gym-b' }));

  expect(response.status).toBe(403);
  expect(mockPromote).not.toHaveBeenCalled();
});
