import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { ConflictError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertConsentCoversVideo, mintUnderPlaybackConsent } from '@/src/server/pilot/videoPlaybackConsent';
import { authorizeVideoScanReview, VideoScanReviewRefused } from '@/src/server/pilot/videoScanReview';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The entitlement and quarantine-state rules have their own suite; this one
// exercises what the ROUTE adds on top of them.
jest.mock('@/src/server/pilot/videoScanReview', () => ({
  ...jest.requireActual('@/src/server/pilot/videoScanReview'),
  authorizeVideoScanReview: jest.fn(),
}));
// mintUnderPlaybackConsent's transaction and locking have their own suite;
// here it asks the doubled consent check for each athlete, then mints.
jest.mock('@/src/server/pilot/videoPlaybackConsent', () => {
  const assertConsentCoversVideo = jest.fn().mockResolvedValue(undefined);
  return {
    assertConsentCoversVideo,
    mintUnderPlaybackConsent: jest.fn(async (organizationId: string, athleteIds: string[], mint: () => unknown) => {
      for (const athleteId of athleteIds) await assertConsentCoversVideo(organizationId, athleteId);
      return mint();
    }),
  };
});
jest.mock('@/src/server/pilot/blob', () => ({
  getPilotVideoSasUrl: jest.fn(() => 'https://blob.example/vid-1?sig=x'),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAuthorize = authorizeVideoScanReview as jest.Mock;
const mockConsent = assertConsentCoversVideo as jest.Mock;
const mockMint = mintUnderPlaybackConsent as jest.Mock;
const mockSas = getPilotVideoSasUrl as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

afterEach(() => { jest.clearAllMocks(); });

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

const quarantined = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  blob_path: 'org-1/vid-1.mp4',
  title: 'Sparring',
  file_name: 'vid-1.mp4',
  scan_state: 'blocked',
  scan_detail: null,
  ...overrides,
});

function call(body: unknown = { video_session_id: 'vid-1' }) {
  return POST(new NextRequest('http://localhost/api/pilot/video/review-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/*
 * CL-A21, Jason 2026-10-06: "No one watches it". A guardian's photo-only,
 * withdrawn or unreadable media consent refuses the review link too, the same
 * gate playback, publication and the automated scan use
 * (OD-2026-10-05-016/-021/-022). The footage stays quarantined; Block still
 * works without viewing.
 */
describe('POST /api/pilot/video/review-link', () => {
  test.each([
    ['photo-only', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'],
    ['withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN'],
    ['unreadable', 'GUARDIAN_CONSENT_UNREADABLE'],
  ])('a %s consent refuses the link and mints nothing', async (_label, code) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined());
    mockConsent.mockRejectedValueOnce(new ConflictError('Blocked: consent', code));

    const res = await call();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(code);
    expect(body.error).toEqual(expect.any(String));
    expect(mockMint).toHaveBeenCalledWith('org-1', ['ath-1'], expect.any(Function));
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockSas).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('consent is asked only after the entitlement check, so a refusal never confirms a video exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockRejectedValueOnce(new VideoScanReviewRefused('VIDEO_SESSION_NOT_FOUND', 'Not found', 404));

    const res = await call();

    expect(res.status).toBe(404);
    expect(mockConsent).not.toHaveBeenCalled();
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('consent that covers video issues the 15-minute link and audits it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined());

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, url: 'https://blob.example/vid-1?sig=x', expires_in_minutes: 15 });
    expect(mockSas).toHaveBeenCalledWith('org-1/vid-1.mp4', 15);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  test('teaching footage names nobody, so there is no guardian to ask', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined({ athlete_id: null }));

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith('org-1', [], expect.any(Function));
    expect(mockConsent).not.toHaveBeenCalled();
  });

  test('the organization admin is held to the same consent refusal', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockAuthorize.mockResolvedValueOnce(quarantined());
    mockConsent.mockRejectedValueOnce(new ConflictError('Blocked: consent', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'));

    const res = await call();

    expect(res.status).toBe(409);
    expect(mockSas).not.toHaveBeenCalled();
  });
});
