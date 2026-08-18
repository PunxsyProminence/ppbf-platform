import { NextRequest } from 'next/server';

import { GET } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { downloadPilotProfilePhoto } from '@/src/server/pilot/blob';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  getAccountProfile,
  getSubjectIdentity,
} from '@/src/server/pilot/profileDb';

jest.mock('@/src/server/pilot/profileDb', () => ({
  getSubjectIdentity: jest.fn(),
  getAccountProfile: jest.fn(),
  assertViewerMayReachSubject: jest.fn(),
}));

jest.mock('@/src/server/pilot/blob', () => ({
  downloadPilotProfilePhoto: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return {
    ...actual,
    requirePrincipal: jest.fn(),
  };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockIdentity = jest.mocked(getSubjectIdentity);
const mockGetProfile = jest.mocked(getAccountProfile);
const mockAssertReach = jest.mocked(assertViewerMayReachSubject);
const mockDownload = jest.mocked(downloadPilotProfilePhoto);
const mockAudit = jest.mocked(writePilotAuditEvent);

const PORTRAIT_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-admin',
    role,
    organizationId: 'org-a',
    athleteId: null,
    ...overrides,
  } as never;
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-athlete',
    fullName: 'Sample Athlete',
    athleteId: 'ath-1',
    dob: '2014-05-02',
    coachAccountId: 'acct-coach',
    memberSince: '2026-01-01T00:00:00Z',
    ...overrides,
  } as never;
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-a',
    accountId: 'acct-athlete',
    nickname: null,
    nicknameClearedAt: null,
    corner: 'none',
    program: 'unstated',
    photoBlobPath: '/blob/path.jpg',
    photoContentType: 'image/jpeg',
    photoReviewState: 'pending_review',
    ...overrides,
  } as never;
}

function request(accountId = 'acct-athlete'): NextRequest {
  return new NextRequest(`https://ppbf.example/api/pilot/admin/portrait-review/photo/${accountId}`);
}

function routeParams(accountId = 'acct-athlete') {
  return { params: Promise.resolve({ accountId }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockResolvedValue(identity());
  mockGetProfile.mockResolvedValue(profile());
  mockAssertReach.mockResolvedValue(undefined);
  mockDownload.mockResolvedValue(PORTRAIT_BYTES);
});

describe('GET /api/pilot/admin/portrait-review/photo/[accountId]', () => {
  test('an organization admin receives the actual bytes of a pending portrait -- the review cannot mean anything otherwise', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await GET(request(), routeParams());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer()).equals(PORTRAIT_BYTES)).toBe(true);
    expect(mockDownload).toHaveBeenCalledWith('/blob/path.jpg');
  });

  test('the legacy admin role name also works, matching the console queue route', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));

    const response = await GET(request(), routeParams());

    expect(response.status).toBe(200);
  });

  test('a child\'s undecided face is never cacheable and never sniffable', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await GET(request(), routeParams());

    // An undecided portrait is the most sensitive state a photograph reaches on
    // this platform, so these must not be laxer than the released read path in
    // profile/photo/[accountId].
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
  });

  test('looking at a child\'s portrait is written to the audit trail', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    await GET(request(), routeParams());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'update',
        actor_account_id: 'acct-admin',
        entity_type: 'account_profile_photo',
        entity_id: 'acct-athlete',
        details: expect.objectContaining({
          action: 'portrait_review_image_viewed',
          source: 'admin_portrait_review_console',
        }),
      }),
    );
  });

  test('an audit failure costs the reviewer the image, not the record the entry', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAudit.mockRejectedValueOnce(new Error('audit table unavailable'));

    const response = await GET(request(), routeParams());

    // Fail closed: no unlogged disclosure of a child's face. The reviewer who
    // cannot see the portrait also cannot approve it, which is the safe end.
    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  test('every other role is refused, including the ones that can read the athlete record', async () => {
    for (const role of ['coach', 'athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request(), routeParams());
      expect(response.status).toBe(403);
    }
    // The role check runs before any subject lookup, so a refused caller learns
    // nothing at all about whether this child has a photograph.
    expect(mockIdentity).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('a portrait that has already been released is a 404 -- this route is not a backdoor to a decided photograph', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile({ photoReviewState: 'released' }));

    const response = await GET(request(), routeParams());

    // Once released, profileVisibility.ts governs the photograph again -- and it
    // deliberately keeps an admin outside a minor's circle.
    expect(response.status).toBe(404);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('a blocked or removed portrait is a 404, so a rejected photograph cannot be pulled back up', async () => {
    for (const state of ['blocked', 'removed']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetProfile.mockResolvedValueOnce(profile({ photoReviewState: state }));

      const response = await GET(request(), routeParams());

      expect(response.status).toBe(404);
    }
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('a subject with no photo on file is a hidden 404', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile({ photoBlobPath: null }));

    const response = await GET(request(), routeParams());

    expect(response.status).toBe(404);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('an account that does not exist in this organization is the same hidden 404', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockIdentity.mockResolvedValueOnce(null);

    const response = await GET(request('acct-elsewhere'), routeParams('acct-elsewhere'));

    expect(response.status).toBe(404);
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('the existing child-account boundary still refuses first, and refuses as a 404', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAssertReach.mockRejectedValueOnce(new Error('Forbidden: athlete belongs to another organization'));

    const response = await GET(request(), routeParams());

    // access.ts's boundary is not widened by this route; a subject the admin
    // may not reach is indistinguishable from a subject who does not exist.
    expect(response.status).toBe(404);
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('an absurdly long account id is rejected before any lookup', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const long = 'a'.repeat(129);
    const response = await GET(request(long), routeParams(long));

    expect(response.status).toBe(404);
    expect(mockIdentity).not.toHaveBeenCalled();
  });
});
