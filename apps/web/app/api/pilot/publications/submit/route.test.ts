import { NextRequest } from 'next/server';

import { POST } from './route';
import { getPublicationForPublish, submitPublicationForReview } from '@/src/server/pilot/publication';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/publication', () => ({
  getPublicationForPublish: jest.fn(),
  submitPublicationForReview: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetPublication = getPublicationForPublish as jest.Mock;
const mockSubmit = submitPublicationForReview as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

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

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/publications/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    publication_id: 'pub-1',
    video_session_id: 'vid-1',
    athlete_id: 'ath-1',
    submitted_by_account_id: 'coach-1',
    title: 'Jab session',
    description: '',
    tags: [],
    status: 'draft',
    compliance_check_status: 'pending',
    ...overrides,
  };
}

// This route is the only thing a coach can reach that moves a publication
// into the admin console's pending_review queue. If it breaks, drafts wait
// forever and the console shows an empty queue -- the exact deadlock it was
// built to close.
describe('POST /api/pilot/publications/submit', () => {
  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board'] as const)(
    '%s cannot submit a publication for review',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));
      const res = await POST(postRequest({ publication_id: 'pub-1' }));
      expect(res.status).toBe(403);
      expect(mockSubmit).not.toHaveBeenCalled();
    },
  );

  test('a publication from another organization is indistinguishable from a missing one', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(null);

    const res = await POST(postRequest({ publication_id: 'pub-other-org' }));

    expect(res.status).toBe(404);
    expect(mockGetPublication).toHaveBeenCalledWith('org-1', 'pub-other-org');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('a coach cannot submit another coach\'s draft', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-2' }));
    mockGetPublication.mockResolvedValueOnce(draftRow());

    const res = await POST(postRequest({ publication_id: 'pub-1' }));

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/coach who created this publication, or an organization admin/);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('an organization admin can submit any draft in their organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockGetPublication.mockResolvedValueOnce(draftRow());
    mockSubmit.mockResolvedValueOnce(true);

    const res = await POST(postRequest({ publication_id: 'pub-1' }));

    expect(res.status).toBe(200);
    expect(mockSubmit).toHaveBeenCalledWith('org-1', 'pub-1');
  });

  test('only a draft can be submitted, and the refusal names the actual status', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(draftRow({ status: 'rejected' }));

    const res = await POST(postRequest({ publication_id: 'pub-1' }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; status?: string };
    expect(body.error).toMatch(/Only a draft/);
    expect(body.status).toBe('rejected');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('a submit that loses the CAS race applies nothing and says the row changed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(draftRow());
    mockSubmit.mockResolvedValueOnce(false);

    const res = await POST(postRequest({ publication_id: 'pub-1' }));

    expect(res.status).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a successful submit is audited with the actor and the affected publication', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetPublication.mockResolvedValueOnce(draftRow());
    mockSubmit.mockResolvedValueOnce(true);

    const res = await POST(postRequest({ publication_id: 'pub-1' }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('pending_review');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_account_id: 'coach-1',
        organization_id: 'org-1',
        entity_type: 'video_publication',
        entity_id: 'pub-1',
        details: expect.objectContaining({ action: 'publication_submit_for_review' }),
      }),
    );
  });

  test('a missing publication_id is refused before any read', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await POST(postRequest({}));

    expect(res.status).not.toBe(200);
    expect(mockGetPublication).not.toHaveBeenCalled();
  });
});
