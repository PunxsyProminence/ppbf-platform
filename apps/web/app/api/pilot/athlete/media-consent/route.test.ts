import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertAthleteBelongsToOrganization } from '@/src/server/pilot/access';
import {
  AthleteNotAdultError,
  grantOwnMediaConsent,
  withdrawOwnMediaConsent,
} from '@/src/server/pilot/athleteMediaConsent';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { queryOne } from '@/src/server/pilot/db';
import { readOwnMediaConsent } from '@/src/server/pilot/guardianConsent';
import { requirePrincipal } from '@/src/server/pilot/http';
import { recordMediaConsentAndSuppress } from '@/src/server/pilot/publication';

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/publication', () => ({ recordMediaConsentAndSuppress: jest.fn() }));
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertAthleteBelongsToOrganization: jest.fn(),
}));
jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  queryOne: jest.fn(),
}));
jest.mock('@/src/server/pilot/athleteMediaConsent', () => ({
  ...jest.requireActual('@/src/server/pilot/athleteMediaConsent'),
  grantOwnMediaConsent: jest.fn(),
  withdrawOwnMediaConsent: jest.fn(),
}));
jest.mock('@/src/server/pilot/guardianConsent', () => ({
  ...jest.requireActual('@/src/server/pilot/guardianConsent'),
  readOwnMediaConsent: jest.fn(),
}));
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockBelongs = jest.mocked(assertAthleteBelongsToOrganization);
const mockQueryOne = jest.mocked(queryOne);
const mockReadOwn = jest.mocked(readOwnMediaConsent);
const mockGrant = jest.mocked(grantOwnMediaConsent);
const mockWithdraw = jest.mocked(withdrawOwnMediaConsent);
const mockRecord = jest.mocked(recordMediaConsentAndSuppress);
const mockAudit = jest.mocked(writePilotAuditEvent);

const TX = { query: jest.fn() } as never;

function principal(role: string, athleteId: string | null = 'ath-adult') {
  return { accountId: 'acct-ath-adult', role, organizationId: 'org-a', athleteId } as never;
}

function adultDob(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 20);
  return d.toISOString().slice(0, 10);
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/pilot/athlete/media-consent', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
const get = () => new NextRequest('http://localhost/api/pilot/athlete/media-consent');

beforeEach(() => {
  jest.clearAllMocks();
  mockBelongs.mockResolvedValue(undefined);
  mockQueryOne.mockResolvedValue({ dob: adultDob() } as never);
  mockReadOwn.mockResolvedValue(null);
  mockGrant.mockResolvedValue('waiver-1');
  mockWithdraw.mockResolvedValue('waiver-1');
  mockRecord.mockImplementation(async ({ write }) => ({ waiverId: await write(TX), publicationIds: ['pub-1'] }));
});

describe('only the signed-in athlete, for themselves', () => {
  test.each(['coach', 'organization_admin', 'admin', 'parent', 'platform_owner'])('%s is refused, and nothing is written', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role, null));
    expect((await GET(get())).status).toBe(403);
    expect((await POST(post({ decision: 'grant' }))).status).toBe(403);
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('an athlete login not linked to an athlete record is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete', null));
    expect((await POST(post({ decision: 'grant' }))).status).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  test('an athlete_id in the body is ignored: the write is for the session athlete and the session account', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete'));
    const res = await POST(post({ decision: 'grant', athlete_id: 'ath-someone-else', covers_video: true }));
    expect(res.status).toBe(200);
    expect(mockBelongs).toHaveBeenCalledWith('org-a', 'ath-adult');
    expect(mockGrant).toHaveBeenCalledWith({
      organizationId: 'org-a',
      athleteId: 'ath-adult',
      recordedByAccountId: 'acct-ath-adult',
      coversVideo: true,
      publicUseAllowed: false,
    });
  });

  test('a session that outlived the athlete record is refused before any write', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete'));
    mockBelongs.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));
    expect((await POST(post({ decision: 'withdraw' }))).status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('grant and withdraw', () => {
  beforeEach(() => mockRequirePrincipal.mockResolvedValue(principal('athlete')));

  test('a video grant is recorded and audited, with no takedown', async () => {
    const res = await POST(post({ decision: 'grant' }));
    expect(res.status).toBe(200);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'consent_granted',
      entity_type: 'athlete_media_consent',
      entity_id: 'ath-adult',
      details: { covers_video: true, public_use_allowed: false },
    }));
  });

  test('a photo-only grant runs the takedown in the same transaction, under the exclusive consent-set lock', async () => {
    const res = await POST(post({ decision: 'grant', covers_video: false }));
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      athleteId: 'ath-adult',
      reason: 'athlete_consent_photo_only',
      exclusiveConsentSet: true,
    }));
    expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({ coversVideo: false }), TX);
    await expect(res.json()).resolves.toMatchObject({ ok: true, retracted_publication_ids: ['pub-1'] });
  });

  test('a withdrawal runs the takedown in the same transaction and audits each retraction', async () => {
    const res = await POST(post({ decision: 'withdraw' }));
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ reason: 'athlete_consent_withdrawn', exclusiveConsentSet: true }));
    expect(mockWithdraw).toHaveBeenCalledWith(
      { organizationId: 'org-a', athleteId: 'ath-adult', recordedByAccountId: 'acct-ath-adult' },
      TX,
    );
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'consent_withdrawn', entity_type: 'athlete_media_consent' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'video_publication',
      entity_id: 'pub-1',
      details: { action: 'publication_retracted_on_athlete_consent_withdrawal', athlete_id: 'ath-adult' },
    }));
  });

  test("a minor's attempt is a 403 with the reason, not a failed takedown", async () => {
    mockRecord.mockRejectedValueOnce(new AthleteNotAdultError());
    const res = await POST(post({ decision: 'withdraw' }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'ATHLETE_NOT_ADULT' });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a failed takedown answers 500 saying nothing was recorded, and audits the rollback', async () => {
    mockRecord.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '40P01' }));
    const res = await POST(post({ decision: 'withdraw' }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Nothing was changed/) });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ action: 'consent_withdrawal_suppression_failed', rolled_back: true }),
    }));
  });

  test.each([
    [{ decision: 'grant', covers_video: 'false' }],
    [{ decision: 'grant', public_use_allowed: 1 }],
    [{ decision: 'maybe' }],
    [{}],
  ])('a malformed request is refused before any write: %j', async (body) => {
    expect((await POST(post(body))).status).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  beforeEach(() => mockRequirePrincipal.mockResolvedValue(principal('athlete')));

  test('an adult sees their own current consent and whether it counts for a new publication', async () => {
    mockReadOwn.mockResolvedValueOnce({
      status: 'signed', coversVideo: true, publicUseAllowed: false, signedAt: '2026-10-01T00:00:00Z', recordedByOwnLogin: true,
    });
    const res = await GET(get());
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    await expect(res.json()).resolves.toEqual({
      is_adult: true,
      consent: { status: 'signed', covers_video: true, public_use_allowed: false, recorded_at: '2026-10-01T00:00:00Z' },
      counts_for_new_publication: true,
    });
  });

  test('a minor is told they are a minor, and their rows are not read', async () => {
    mockQueryOne.mockResolvedValueOnce({ dob: '2015-01-01' } as never);
    await expect((await GET(get())).json()).resolves.toEqual({ is_adult: false, consent: null, counts_for_new_publication: false });
    expect(mockReadOwn).not.toHaveBeenCalled();
  });
});
