import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { deletePilotProfilePhoto } from '@/src/server/pilot/blob';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  clearPhoto,
  getAccountProfile,
  listPendingReviewPortraits,
  releasePhoto,
} from '@/src/server/pilot/profileDb';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/profileDb', () => ({
  listPendingReviewPortraits: jest.fn(),
  getAccountProfile: jest.fn(),
  releasePhoto: jest.fn(),
  clearPhoto: jest.fn(),
}));

jest.mock('@/src/server/pilot/blob', () => ({
  deletePilotProfilePhoto: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
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
// `as jest.Mock` rather than jest.mocked: query is generic, and the emulated
// implementation below returns one concrete row shape. Same pattern as
// interventionEvidence.test.ts's mockQueryOne.
const mockDbQuery = query as jest.Mock;
const mockList = jest.mocked(listPendingReviewPortraits);
const mockGetProfile = jest.mocked(getAccountProfile);
const mockRelease = jest.mocked(releasePhoto);
const mockClear = jest.mocked(clearPhoto);
const mockDeleteBlob = jest.mocked(deletePilotProfilePhoto);
const mockAudit = jest.mocked(writePilotAuditEvent);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-admin',
    role,
    organizationId: 'org-a',
    athleteId: null,
    ...overrides,
  } as never;
}

function request(url: string): NextRequest {
  return new NextRequest(`https://ppbf.example${url}`);
}

function jsonRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/admin/portrait-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function malformedJsonRequest(): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/admin/portrait-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });
}

// In the exact ::text shape PROFILE_COLUMNS returns -- the identity is an
// opaque string compared by equality, microseconds and all.
const UPLOADED_AT = '2026-08-10 09:00:00.123456+00';

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
    photoUploadedAt: UPLOADED_AT,
    ...overrides,
  } as never;
}

/**
 * Emulates the one SQL statement this route sends through db.query -- the
 * audit-events probe for a 'portrait_review_image_viewed' row -- against a
 * seeded in-memory event list, applying the same conditions the real WHERE
 * clause applies, INCLUDING that the identity the event RECORDED
 * (details.photo_uploaded_at, written by the photo route at serve time) must
 * EQUAL the identity the route passed from the profile's current row. That
 * equality is what makes "the reviewer viewed the photograph this row held
 * earlier" distinguishable from "the reviewer never viewed anything": both
 * must refuse, for different recorded reasons -- and no ordering of
 * timestamps can conflate them.
 */
interface SeededViewEvent {
  organization_id: string;
  actor_account_id: string;
  entity_id: string;
  photo_uploaded_at: string;
}

function seedViewProbe(events: SeededViewEvent[]) {
  mockDbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (!/from pilot\.audit_events/.test(sql)) {
      throw new Error(`Unexpected SQL through db.query in this route: ${sql}`);
    }
    const [organizationId, actorAccountId, entityId, uploadedAt] = params as [
      string, string, string, string,
    ];
    return events
      .filter((event) =>
        event.organization_id === organizationId
        && event.actor_account_id === actorAccountId
        && event.entity_id === entityId
        && event.photo_uploaded_at === uploadedAt)
      .map(() => ({ audit_id: 'evt-1' }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // The CAS write succeeds by default; individual tests override this to
  // simulate a lost race (another reviewer's write landed first).
  mockRelease.mockResolvedValue(true);
  mockClear.mockResolvedValue(true);
  // By default this reviewer HAS viewed the current photo (a fresh audit
  // view event exists), so the pre-existing approve tests exercise the
  // paths they always did; the view-attestation tests re-seed.
  seedViewProbe([
    { organization_id: 'org-a', actor_account_id: 'acct-admin', entity_id: 'acct-athlete', photo_uploaded_at: UPLOADED_AT },
  ]);
});

describe('GET /api/pilot/admin/portrait-review', () => {
  test('an organization admin lists the pending-review queue, mapped to the codebase\'s snake_case wire format', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([
      { accountId: 'acct-1', fullName: 'Sample Athlete', athleteId: 'ath-1', uploadedAt: '2026-08-01T00:00:00Z' },
    ]);

    const response = await GET(request('/api/pilot/admin/portrait-review'));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a');
    // This is the exact shape apps/web/app/admin/portrait-review/page.tsx
    // reads (account_id / full_name / athlete_id / uploaded_at) -- asserted
    // in snake_case here so a regression back to the internal camelCase
    // shape fails this test instead of only breaking silently at runtime.
    await expect(response.json()).resolves.toEqual({
      ok: true,
      portraits: [{ account_id: 'acct-1', full_name: 'Sample Athlete', athlete_id: 'ath-1', uploaded_at: '2026-08-01T00:00:00Z' }],
    });
  });

  test('the legacy admin role name also works', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockList.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/admin/portrait-review'));

    expect(response.status).toBe(200);
  });

  test('non-admin roles are refused -- this is an org-admin-only console', async () => {
    for (const role of ['athlete', 'parent', 'coach', 'board', 'platform_owner']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request('/api/pilot/admin/portrait-review'));
      expect(response.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/admin/portrait-review', () => {
  test('approve releases the photo (CAS-guarded on pending_review) and writes an audit event', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith('org-a', 'acct-athlete', 'acct-admin', 'pending_review', UPLOADED_AT);
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockDeleteBlob).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ok: true, review_state: 'released' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'update',
        entity_type: 'account_profile_photo',
        entity_id: 'acct-athlete',
        details: expect.objectContaining({ action: 'photo_released' }),
      }),
    );
  });

  test('reject blocks the row (CAS-guarded) BEFORE deleting the blob, and never deletes the record itself', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());
    const callOrder: string[] = [];
    mockClear.mockImplementationOnce(async () => {
      callOrder.push('clearPhoto');
      return true;
    });
    mockDeleteBlob.mockImplementationOnce(async () => {
      callOrder.push('deletePilotProfilePhoto');
    });

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'reject' }));

    expect(response.status).toBe(200);
    expect(mockClear).toHaveBeenCalledWith('org-a', 'acct-athlete', 'blocked', 'acct-admin', 'pending_review');
    expect(mockDeleteBlob).toHaveBeenCalledWith('/blob/path.jpg');
    // The row transition must win the CAS before the blob is touched --
    // deleting first and then losing the race would destroy a photo another
    // reviewer had just released.
    expect(callOrder).toEqual(['clearPhoto', 'deletePilotProfilePhoto']);
    expect(mockRelease).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ok: true, review_state: 'blocked' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ action: 'photo_blocked' }) }),
    );
  });

  test('a coach cannot use the admin console route, even for their own athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(403);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  test('missing account_id is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  test('a non-string account_id (e.g. a number) is treated as missing, never coerced through', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ account_id: 12345, decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  test('a malformed JSON body is a 400, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(malformedJsonRequest());

    expect(response.status).toBe(400);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  test('an unrecognized decision is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'delete' }));

    expect(response.status).toBe(400);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  test('a subject with no photo on file is a hidden 404, not a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile({ photoBlobPath: null }));

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(404);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  // The real race: two admins have the queue open at once and decide the
  // same account_id before either write commits. Both reads see
  // pending_review, but only one CAS-guarded UPDATE can win -- the loser's
  // releasePhoto/clearPhoto call resolves false (matched zero rows), which
  // is exactly what this mock simulates, independent of what getAccountProfile
  // happened to read.
  test('losing the CAS race is refused, not silently re-applied, and the blob is never touched', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());
    mockRelease.mockResolvedValueOnce(false);

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockRelease).toHaveBeenCalledWith('org-a', 'acct-athlete', 'acct-admin', 'pending_review', UPLOADED_AT);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('losing the CAS race on reject never deletes the blob', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());
    mockClear.mockResolvedValueOnce(false);

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'reject' }));

    expect(response.status).toBe(400);
    expect(mockDeleteBlob).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// The server half of the view-before-approve gate. The client's disabled
// Approve button (admin/portrait-review/page.tsx) is one render's property;
// the audit row the photo route writes before serving bytes is the only
// record of a look the server can verify. These pin that approve demands it,
// bound to the CURRENT upload, and that reject never waits for it.
describe('POST approve requires a server-verifiable view of the current photo', () => {
  test('approve with no view event on record is refused 403 and the photo is NOT released', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());
    seedViewProbe([]);

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Forbidden: approve requires viewing the current photo first',
    });
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a view of an EARLIER upload does not authorise the replacement: the probe demands identity EQUALITY', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    // The member replaced the photo AFTER the reviewer's only look: the row
    // now carries a new photo_uploaded_at, and the only view event on record
    // attests the OLD one. Note ordering could not refuse this -- the view
    // event's created_at may well postdate the replacement (the photo route
    // can serve old bytes and write its event after a concurrent swap) --
    // only identity equality can.
    mockGetProfile.mockResolvedValueOnce(profile({ photoUploadedAt: '2026-08-15 08:00:00.654321+00' }));
    seedViewProbe([
      { organization_id: 'org-a', actor_account_id: 'acct-admin', entity_id: 'acct-athlete', photo_uploaded_at: UPLOADED_AT },
    ]);

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(403);
    expect(mockRelease).not.toHaveBeenCalled();
    // The load-bearing binding: the SQL compares the RECORDED identity for
    // equality with the profile's CURRENT photo_uploaded_at, passed as $4.
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("details->>'action' = 'portrait_review_image_viewed'");
    expect(sql).toContain("details->>'photo_uploaded_at' = $4");
    expect(sql).not.toContain('created_at >=');
    expect(params).toEqual(['org-a', 'acct-admin', 'acct-athlete', '2026-08-15 08:00:00.654321+00']);
  });

  // The race the probe alone cannot close: the swap lands AFTER the probe
  // found a fresh view but BEFORE releasePhoto's UPDATE commits. setPhoto
  // sends a replacement back to 'pending_review', so the state half of the
  // CAS still matches -- only the identity half (photo_uploaded_at =
  // attested value, passed as releasePhoto's fifth argument) makes the
  // UPDATE match zero rows. The mock resolving false IS that zero-row
  // outcome, same as the existing lost-state-race tests.
  test('a replacement between probe and release loses the identity CAS: nothing is released', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());
    mockRelease.mockResolvedValueOnce(false);

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(400);
    // The identity the probe attested is the SAME value the CAS was handed.
    expect(mockRelease).toHaveBeenCalledWith('org-a', 'acct-athlete', 'acct-admin', 'pending_review', UPLOADED_AT);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('approve with a view attesting the CURRENT upload succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());
    seedViewProbe([
      { organization_id: 'org-a', actor_account_id: 'acct-admin', entity_id: 'acct-athlete', photo_uploaded_at: UPLOADED_AT },
    ]);

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith('org-a', 'acct-athlete', 'acct-admin', 'pending_review', UPLOADED_AT);
    await expect(response.json()).resolves.toEqual({ ok: true, review_state: 'released' });
  });

  test('a profile with no photo_uploaded_at fails closed: refused without even probing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile({ photoUploadedAt: null }));

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('reject stays ungated: no view event, no probe -- refusing is never slowed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());
    seedViewProbe([]);

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'reject' }));

    expect(response.status).toBe(200);
    expect(mockClear).toHaveBeenCalledWith('org-a', 'acct-athlete', 'blocked', 'acct-admin', 'pending_review');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});
