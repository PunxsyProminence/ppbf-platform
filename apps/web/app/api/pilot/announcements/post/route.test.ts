import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { createAnnouncement } from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/announcements', () => ({
  createAnnouncement: jest.fn(),
  isAllowedAnnouncementRole: jest.requireActual('@/src/server/pilot/announcements').isAllowedAnnouncementRole,
  isAnnouncementPlacement: jest.requireActual('@/src/server/pilot/announcements').isAnnouncementPlacement,
  isAnnouncementKind: jest.requireActual('@/src/server/pilot/announcements').isAnnouncementKind,
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockCreateAnnouncement = createAnnouncement as jest.MockedFunction<typeof createAnnouncement>;
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
  return new NextRequest('http://localhost/api/pilot/announcements/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockCreateAnnouncement.mockResolvedValue({
    announcement_id: 'ann-1',
    organization_id: 'org-1',
    message: 'Hello',
    author_name: 'Coach',
    author_role: 'coach',
    created_at: '2026-07-26T00:00:00.000Z',
    placement: 'gym_notices',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
  });
});

describe('POST /api/pilot/announcements/post', () => {
  test('rejects an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const res = await POST(request({ message: 'Hello', author_name: 'Coach', author_role: 'coach' }));

    expect(res.status).toBe(401);
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  test('rejects a PIN-authenticated principal', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local' }));

    const res = await POST(request({ message: 'Hello', author_name: 'Coach', author_role: 'coach' }));

    expect(res.status).toBe(403);
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  test('ignores a caller-supplied organization_id and scopes to the principal organization', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({
      organization_id: 'org-2',
      message: 'Hello',
      author_name: 'Coach',
      author_role: 'coach',
    }));

    expect(res.status).toBe(200);
    expect(mockCreateAnnouncement).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
  });

  test('does not let a coach claim the admin author role', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));

    const res = await POST(request({ message: 'Hello', author_name: 'Coach', author_role: 'admin' }));

    expect(res.status).toBe(200);
    expect(mockCreateAnnouncement).toHaveBeenCalledWith(expect.objectContaining({ authorRole: 'coach' }));
  });

  test('does not let a coach claim a board seat', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));

    const res = await POST(request({ message: 'Hello', author_name: 'Coach', author_role: 'board-president' }));

    expect(res.status).toBe(200);
    expect(mockCreateAnnouncement).toHaveBeenCalledWith(expect.objectContaining({ authorRole: 'coach' }));
  });

  test('lets a board principal pick its own seat but nothing outside the board seats', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'board', accountId: 'board-1' }));

    const allowed = await POST(request({ message: 'Hello', author_name: 'Treasurer', author_role: 'board-treasurer' }));
    expect(allowed.status).toBe(200);
    expect(mockCreateAnnouncement).toHaveBeenCalledWith(expect.objectContaining({ authorRole: 'board-treasurer' }));

    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'board', accountId: 'board-1' }));
    const denied = await POST(request({ message: 'Hello', author_name: 'Treasurer', author_role: 'admin' }));
    expect(denied.status).toBe(403);
  });

  test('rejects a role that may not post announcements at all', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', accountId: 'athlete-1' }));

    const res = await POST(request({ message: 'Hello', author_name: 'Athlete', author_role: 'coach' }));

    expect(res.status).toBe(403);
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  test('a coach may place and schedule an item, not just post to the sign-in page', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));

    const res = await POST(request({
      message: 'Hands up, chin down.',
      author_name: 'Coach',
      placement: 'athlete_workspace',
      kind: 'motivation',
      starts_at: '2026-08-01T00:00:00.000Z',
      ends_at: '2026-08-08T00:00:00.000Z',
    }));

    expect(res.status).toBe(200);
    expect(mockCreateAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      placement: 'athlete_workspace',
      kind: 'motivation',
      startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-08-08T00:00:00.000Z',
    }));
  });

  test('an unset schedule bound stays null rather than being backdated to now', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ message: 'Hello', author_name: 'Coach', starts_at: '', ends_at: null }));

    expect(res.status).toBe(200);
    expect(mockCreateAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      startsAt: null,
      endsAt: null,
      placement: 'gym_notices',
      kind: 'notice',
    }));
  });

  test('refuses a placement outside the vocabulary the database will accept', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ message: 'Hello', author_name: 'Coach', placement: 'billboard' }));

    expect(res.status).toBe(400);
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  test('refuses a window that closes before it opens, which would render nowhere', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({
      message: 'Hello',
      author_name: 'Coach',
      starts_at: '2026-08-08T00:00:00.000Z',
      ends_at: '2026-08-01T00:00:00.000Z',
    }));

    expect(res.status).toBe(400);
    expect(mockCreateAnnouncement).not.toHaveBeenCalled();
  });

  test('records the real actor in the audit event without copying the announcement body', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ message: 'Hello', author_name: 'Coach', author_role: 'coach' }));

    expect(res.status).toBe(200);
    expect(mockWritePilotAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actor_account_id: 'coach-1',
      actor_role: 'coach',
      organization_id: 'org-1',
      details: {
        author_name: 'Coach',
        author_role: 'coach',
        placement: 'gym_notices',
        kind: 'notice',
      },
    }));
    expect(JSON.stringify(mockWritePilotAuditEvent.mock.calls[0]?.[0])).not.toContain('Hello');
  });
});
