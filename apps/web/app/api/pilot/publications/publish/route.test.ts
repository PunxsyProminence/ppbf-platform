import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  assertGuardianMediaConsent,
  assertNotAdultForNewPublication,
  GuardianConsentMissingError,
} from '@/src/server/pilot/guardianConsent';
import { getPublicationForPublish, publishToResearchLibrary } from '@/src/server/pilot/publication';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';
import { assertConsentCoversVideo } from '@/src/server/pilot/videoPlaybackConsent';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/publication', () => ({
  getPublicationForPublish: jest.fn(),
  publishToResearchLibrary: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return {
    ...actual,
    assertGuardianMediaConsent: jest.fn(),
    assertGuardianMediaConsentWithClient: jest.fn(),
    assertNotAdultForNewPublication: jest.fn(),
  };
});

// The real coverage gate reads the database; route.coversVideo.test.ts drives
// it against fake consent rows. Here consent is the mocked helpers above.
jest.mock('@/src/server/pilot/videoPlaybackConsent', () => ({
  assertConsentCoversVideo: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/videoSessions', () => ({
  getVideoSessionById: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetVideoSession = getVideoSessionById as jest.Mock;
const mockGetPublication = getPublicationForPublish as jest.Mock;
const mockPublish = publishToResearchLibrary as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockAssertConsent = assertGuardianMediaConsent as jest.Mock;
const mockAssertNotAdult = assertNotAdultForNewPublication as jest.Mock;

beforeEach(() => {
  // Consent is on file unless a test says otherwise.
  mockAssertConsent.mockResolvedValue(undefined);
  // Reset, not clear: a queued once-rejection must not leak between tests.
  mockAssertNotAdult.mockReset();
  // The video is attributed to the publication's athlete unless a test says
  // otherwise.
  mockGetVideoSession.mockResolvedValue({ video_session_id: 'vid-1', athlete_id: 'ath-1', status: 'ready' });
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
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

const publicationRow = (overrides: Record<string, unknown> = {}) => ({
  publication_id: 'pub-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  submitted_by_account_id: 'coach-1',
  title: 'Jab mechanics',
  description: 'Session review',
  tags: ['jab'],
  status: 'approved',
  compliance_check_status: 'passed',
  ...overrides,
});

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/publications/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = { publication_id: 'pub-1', video_session_id: 'vid-1' };

// Publishing moves a named youth athlete's footage onto a research shelf. It
// is allowed only from a publication an admin has cleared, and only by the
// coach who submitted it or an admin -- and every refusal has to say which of
// those it was.
describe('POST /api/pilot/publications/publish', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board'] as const)(
    '%s cannot publish',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));
      const res = await POST(postRequest(validBody));
      expect(res.status).toBe(403);
      expect(mockPublish).not.toHaveBeenCalled();
    },
  );

  test('the submitting coach publishes a cleared publication', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1' }));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockPublish.mockResolvedValueOnce('lib-1');

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, library_id: 'lib-1' });
    expect(mockGetPublication).toHaveBeenCalledWith('org-1', 'pub-1');
  });

  test('the library entry is built from the stored row, not the request body', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockPublish.mockResolvedValueOnce('lib-1');

    await POST(postRequest({ ...validBody, title: 'Something else', description: 'Not this', tags: ['spoof'] }));

    expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      publicationId: 'pub-1',
      videoSessionId: 'vid-1',
      title: 'Jab mechanics',
      description: 'Session review',
      tags: ['jab'],
    }));
  });

  test('an organization admin may publish a publication another coach submitted', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin', accountId: 'admin-1' }));
    mockGetPublication.mockResolvedValueOnce(publicationRow({ submitted_by_account_id: 'coach-9' }));
    mockPublish.mockResolvedValueOnce('lib-1');

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
  });

  test('a coach who did not submit it is refused with the reason', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-2' }));
    mockGetPublication.mockResolvedValueOnce(publicationRow({ submitted_by_account_id: 'coach-1' }));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('submitted');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('a publication outside the acting organization returns hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(null);

    const res = await POST(postRequest({ publication_id: 'pub-other-gym', video_session_id: 'vid-1' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test.each([
    ['draft', 'pending'],
    ['pending_review', 'pending'],
    ['pending_review', 'manual_review'],
    ['rejected', 'failed'],
    ['approved', 'pending'],
    ['approved', 'failed'],
    ['approved', 'manual_review'],
  ])('a publication in %s with %s checks is refused with a reason, not a silent success', async (status, checks) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow({ status, compliance_check_status: checks }));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: string; status: string; compliance_check_status: string };
    expect(payload.error).toContain('compliance check');
    expect(payload.status).toBe(status);
    expect(payload.compliance_check_status).toBe(checks);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('a video_session_id that is not the one on the publication is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow({ video_session_id: 'vid-1' }));

    const res = await POST(postRequest({ publication_id: 'pub-1', video_session_id: 'vid-someone-else' }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('does not belong to this publication');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // Audit CL-B4: a publication cleared before create refused unattributed
  // footage must not reach the shelf. Its consent checks read only the one
  // child it names, never whoever is actually in team footage.
  test('a publication whose video is not linked to an athlete is refused before anything is claimed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vid-1', athlete_id: null, status: 'ready' });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe('VIDEO_NOT_ATTRIBUTED');
    expect(body.error).toMatch(/isn't linked to an athlete/);
    expect(mockGetVideoSession).toHaveBeenCalledWith('org-1', 'vid-1');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // A publication drafted before create compared the two (f8729bf4,
  // 2026-07-31) can name one child on another child's video; its consent
  // checks would read the named child and skip the one on film.
  test('a publication whose video belongs to a different athlete is refused before any consent check or claim', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow({ athlete_id: 'ath-1' }));
    mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vid-1', athlete_id: 'ath-2', status: 'ready' });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe('VIDEO_ATHLETE_MISMATCH');
    expect(mockAssertConsent).not.toHaveBeenCalled();
    expect(assertConsentCoversVideo).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('a publication whose video cannot be found is refused, since its attribution cannot be confirmed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockGetVideoSession.mockResolvedValueOnce(null);

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('VIDEO_NOT_ATTRIBUTED');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  /*
   * audit CL-B10: approval looked at a released video; a video archived or
   * sent back to quarantine between approval and publish still reached the
   * shelf as metadata. The claim now reads the video row on its own client.
   */
  test.each([
    ['archived', { status: 'archived', capture_take_id: null }],
    ['back in quarantine', { status: 'quarantined', capture_take_id: null }],
    ['teaching footage', { status: 'ready', capture_take_id: 'take-1' }],
    ['gone', undefined],
  ])('a video that is %s at publish time is refused inside the claim', async (_label, row) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    const client = {
      query: jest.fn(async (sql: string) => ({
        rows: sql.includes('from pilot.video_sessions') ? (row ? [row] : []) : [],
      })),
    };
    mockPublish.mockImplementation(async (args) => {
      await args.verifyBeforeCommit(client);
      return 'lib-1';
    });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('VIDEO_NOT_PUBLISHABLE');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('from pilot.video_sessions'),
      ['org-1', 'vid-1'],
    );
  });

  test('a claim that finds nothing to publish reports it instead of returning a library id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockPublish.mockResolvedValueOnce(null);

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('changed');
  });

  test('400 when the identifiers are missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await POST(postRequest({ publication_id: 'pub-1' }));

    expect(res.status).toBe(400);
    expect(mockGetPublication).not.toHaveBeenCalled();
  });

  // Putting a minor's footage on a shelf other people can reach is the most
  // consequential act in this workflow and the one most likely to be asked
  // about later. Releasing a video is attributed; publishing one must be too.
  test('a successful publish is attributed in the audit trail', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockPublish.mockResolvedValueOnce('lib-1');

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];
    expect(event).toMatchObject({
      actor_account_id: 'coach-1',
      actor_role: 'coach',
      organization_id: 'org-1',
      entity_type: 'video_publication',
      entity_id: 'pub-1',
    });
    expect(event.details).toMatchObject({ action: 'publication_publish', library_id: 'lib-1' });
  });

  test('a refused publish writes no audit event', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow({ status: 'draft', compliance_check_status: 'pending' }));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('withdrawn guardian consent blocks the publish and records who tried', async () => {
    // Approval checked consent, but a guardian withdrew afterwards. The
    // publish must refuse with the consent reason, put nothing on the shelf,
    // and log the blocked attempt -- who tried to publish unconsented
    // footage of this child is itself a safeguarding-relevant fact.
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockAssertConsent.mockReset();
    mockAssertConsent.mockRejectedValueOnce(new GuardianConsentMissingError('ath-1', ['parent-1']));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/guardian media consent is missing or withdrawn/);
    expect(mockPublish).not.toHaveBeenCalled();
    const [event] = mockAudit.mock.calls[0];
    expect(event.details).toMatchObject({
      action: 'publication_publish_blocked_by_consent',
      missing_parent_ids: ['parent-1'],
    });
  });

  test("an adult athlete is not published on a guardian's consent (OD-2026-10-08-015)", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockAssertNotAdult.mockRejectedValueOnce(new GuardianConsentMissingError('ath-1', [], 0, true));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/18 or older/);
    expect(mockAssertNotAdult).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('the consent re-check is wired into the claim transaction, not only the pre-check', async () => {
    // The pre-check alone leaves a gap between "checked" and "committed"; the
    // claim must carry the same check as verifyBeforeCommit so a withdrawal
    // cannot outrun the publish.
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockPublish.mockResolvedValueOnce('lib-1');

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    const [publishArgs] = mockPublish.mock.calls[0];
    expect(typeof publishArgs.verifyBeforeCommit).toBe('function');

    // The adult gate (OD-2026-10-08-015) is inside the claim too, on the
    // claim's client, for this publication's athlete.
    const client = { query: jest.fn() } as never;
    mockAssertNotAdult.mockRejectedValueOnce(new GuardianConsentMissingError('ath-1', [], 0, true));
    await expect(publishArgs.verifyBeforeCommit(client)).rejects.toMatchObject({ athleteIsAdult: true });
    expect(mockAssertNotAdult).toHaveBeenCalledWith('org-1', 'ath-1', client);
  });

  test('a failed audit write does not fail a publish that already committed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    mockPublish.mockResolvedValueOnce('lib-1');
    mockAudit.mockRejectedValueOnce(new Error('audit table unavailable'));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; library_id?: string };
    expect(body.ok).toBe(true);
    expect(body.library_id).toBe('lib-1');
  });

  test('a malformed body is a 400, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await POST(new NextRequest('http://localhost/api/pilot/publications/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {',
    }));

    expect(res.status).toBe(400);
    expect(mockGetPublication).not.toHaveBeenCalled();
  });
});

/*
 * Tagged sparring and bout clips are staff film study only (owner,
 * 2026-10-03). The draft refuses a tagged clip, but a tag can be added after
 * the draft exists, so the claim transaction re-checks. This drives the REAL
 * check (videoClipTags.ts) through the claim's own client.
 */
describe('a tagged clip cannot be published', () => {
  function claimClient(tagRows: Array<{ tag_id: string }>) {
    const statements: string[] = [];
    return {
      statements,
      async query<T>(text: string): Promise<{ rows: T[] }> {
        statements.push(text);
        if (text.includes('to_regclass')) return { rows: [{ ready: true }] as T[] };
        // The claim's own read of the video row (CL-B10): released Film Study media.
        if (text.includes('from pilot.video_sessions')) return { rows: [{ status: 'ready', capture_take_id: null }] as T[] };
        return { rows: tagRows as T[] };
      },
    };
  }

  test('a tag present at claim time refuses the publish', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    const client = claimClient([{ tag_id: 'vct-1' }]);
    mockPublish.mockImplementationOnce(async (args) => {
      await args.verifyBeforeCommit(client);
      return 'lib-1';
    });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('TAGGED_CLIP_NOT_PUBLISHABLE');
    expect(client.statements.some((sql) => sql.includes('pilot.video_clip_tags'))).toBe(true);
  });

  test('an untagged video still publishes', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(publicationRow());
    const client = claimClient([]);
    mockPublish.mockImplementationOnce(async (args) => {
      await args.verifyBeforeCommit(client);
      return 'lib-1';
    });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
  });
});

