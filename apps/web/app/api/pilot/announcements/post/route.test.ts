import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal } from '@/src/server/pilot/auth';
import { createAnnouncement, isAllowedAnnouncementRole } from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/announcements', () => ({
  createAnnouncement: jest.fn(),
  isAllowedAnnouncementRole: jest.fn(() => true),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockCreateAnnouncement = createAnnouncement as jest.MockedFunction<typeof createAnnouncement>;
const mockIsAllowedAnnouncementRole = isAllowedAnnouncementRole as jest.MockedFunction<typeof isAllowedAnnouncementRole>;
const mockWritePilotAuditEvent = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;

afterEach(() => {
  jest.clearAllMocks();
});

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/announcements/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pilot/announcements/post', () => {
  test('rejects organization substitution attempts', async () => {
    mockResolvePrincipal.mockResolvedValueOnce({
      accountId: 'coach-1',
      role: 'coach',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token-1',
      authProvider: 'microsoft',
    });

    const res = await POST(request({
      organization_id: 'org-2',
      message: 'Hello',
      author_name: 'Coach',
      author_role: 'coach',
    }));

    expect(res.status).toBe(403);
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  test('requires Microsoft-authenticated principals and records audit without announcement content', async () => {
    mockResolvePrincipal.mockResolvedValueOnce({
      accountId: 'coach-1',
      role: 'coach',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token-1',
      authProvider: 'microsoft',
    });
    mockIsAllowedAnnouncementRole.mockReturnValueOnce(true);
    mockCreateAnnouncement.mockResolvedValueOnce({
      announcement_id: 'ann-1',
      organization_id: 'org-1',
      message: 'Hello',
      author_name: 'Coach',
      author_role: 'coach',
      created_at: '2026-07-26T00:00:00.000Z',
    });

    const res = await POST(request({
      message: 'Hello',
      author_name: 'Coach',
      author_role: 'coach',
    }));

    expect(res.status).toBe(200);
    expect(mockCreateAnnouncement).toHaveBeenCalledWith({
      organizationId: 'org-1',
      message: 'Hello',
      authorName: 'Coach',
      authorRole: 'coach',
    });
    expect(mockWritePilotAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actor_account_id: 'coach-1',
      actor_role: 'coach',
      organization_id: 'org-1',
      details: {
        author_name: 'Coach',
        author_role: 'coach',
      },
    }));
    expect(JSON.stringify(mockWritePilotAuditEvent.mock.calls[0]?.[0])).not.toContain('Hello');
  });

  test('rejects non-Microsoft principals for announcement posting', async () => {
    mockResolvePrincipal.mockResolvedValueOnce({
      accountId: 'athlete-1',
      role: 'athlete',
      organizationId: 'org-1',
      athleteId: 'ath-1',
      sessionToken: 'token-1',
      authProvider: 'ppbf_local',
    });

    const res = await POST(request({
      message: 'Hello',
      author_name: 'Athlete',
      author_role: 'coach',
    }));

    expect(res.status).toBe(403);
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });
});