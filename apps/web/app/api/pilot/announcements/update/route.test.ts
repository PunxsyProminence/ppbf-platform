import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { setAnnouncementActive } from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/announcements', () => ({
  setAnnouncementActive: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockSetAnnouncementActive = setAnnouncementActive as jest.MockedFunction<typeof setAnnouncementActive>;
const mockWritePilotAuditEvent = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token-1',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/announcements/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockSetAnnouncementActive.mockResolvedValue({
    announcement_id: 'ann-1',
    organization_id: 'org-1',
    message: 'Gloves on at 5.',
    author_name: 'Coach',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'gym_notices',
    kind: 'notice',
    active: false,
    starts_at: null,
    ends_at: null,
  });
});

describe('POST /api/pilot/announcements/update', () => {
  test('rejects an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const res = await POST(request({ announcement_id: 'ann-1', active: false }));

    expect(res.status).toBe(401);
    expect(mockSetAnnouncementActive).not.toHaveBeenCalled();
  });

  test('rejects a role that may not author announcements', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', accountId: 'athlete-1' }));

    const res = await POST(request({ announcement_id: 'ann-1', active: false }));

    expect(res.status).toBe(403);
    expect(mockSetAnnouncementActive).not.toHaveBeenCalled();
  });

  test('scopes the retire to the caller organization', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ announcement_id: 'ann-1', active: false, organization_id: 'org-2' }));

    expect(res.status).toBe(200);
    expect(mockSetAnnouncementActive).toHaveBeenCalledWith({
      organizationId: 'org-1',
      announcementId: 'ann-1',
      active: false,
    });
    expect(mockWritePilotAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'update',
      actor_account_id: 'coach-1',
      organization_id: 'org-1',
    }));
  });

  // An update that matched no row must not read as a successful retire, or the
  // author walks away believing a live notice has been pulled down.
  test('reports a miss instead of a silent success', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockSetAnnouncementActive.mockResolvedValueOnce(null);

    const res = await POST(request({ announcement_id: 'ann-missing', active: false }));

    expect(res.status).toBe(404);
    expect(mockWritePilotAuditEvent).not.toHaveBeenCalled();
  });
});
