import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { assertGuardianMediaConsent, GuardianConsentMissingError } from '@/src/server/pilot/guardianConsent';
import { getPublicationForPublish, publishToResearchLibrary } from '@/src/server/pilot/publication';
import { requirePrincipal } from '@/src/server/pilot/http';
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
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetPublication = getPublicationForPublish as jest.Mock;
const mockPublish = publishToResearchLibrary as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockAssertConsent = assertGuardianMediaConsent as jest.Mock;

beforeEach(() => {
  // Consent is on file unless a test says otherwise.
  mockAssertConsent.mockResolvedValue(undefined);
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
