import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { setFeedbackTriage } from '@/src/server/pilot/feedback';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/feedback', () => ({
  ...jest.requireActual('@/src/server/pilot/feedback'),
  setFeedbackTriage: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockSetTriage = setFeedbackTriage as jest.MockedFunction<typeof setFeedbackTriage>;
const mockAudit = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token-1',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/feedback/triage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSetTriage.mockResolvedValue({
    submission_id: 'sub-1',
    triage_status: 'triaged',
    triage_note: 'Safeguarding lead spoke with her the same day.',
    triaged_at: '2026-08-01T00:00:00.000Z',
  });
});

describe('POST /api/pilot/feedback/triage', () => {
  test('rejects an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const res = await POST(request({ submission_id: 'sub-1', triage_status: 'triaged' }));

    expect(res.status).toBe(401);
    expect(mockSetTriage).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'refuses a %s',
    async (role) => {
      mockResolvePrincipal.mockResolvedValueOnce(principal({ role }));

      const res = await POST(request({ submission_id: 'sub-1', triage_status: 'done' }));

      expect(res.status).toBe(403);
      expect(mockSetTriage).not.toHaveBeenCalled();
    },
  );

  // The owner's cross-gym read is de-identified on purpose, which means the
  // owner cannot know whose submission they would be closing.
  test('refuses the platform owner, whose read carries no identity to act on', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'platform_owner' }));

    const res = await POST(request({ submission_id: 'sub-1', triage_status: 'done' }));

    expect(res.status).toBe(403);
    expect(mockSetTriage).not.toHaveBeenCalled();
  });

  test('refuses a PIN session holding an admin role', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local' }));

    const res = await POST(request({ submission_id: 'sub-1', triage_status: 'done' }));

    expect(res.status).toBe(403);
    expect(mockSetTriage).not.toHaveBeenCalled();
  });

  test('scopes the update to the caller organization and records the triager', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(
      request({
        submission_id: 'sub-1',
        triage_status: 'triaged',
        triage_note: 'Safeguarding lead spoke with her the same day.',
        organization_id: 'org-2',
      }),
    );

    expect(res.status).toBe(200);
    expect(mockSetTriage).toHaveBeenCalledWith({
      organizationId: 'org-1',
      submissionId: 'sub-1',
      triageStatus: 'triaged',
      note: 'Safeguarding lead spoke with her the same day.',
      triagedByAccountId: 'acct-admin',
    });
  });

  test('an empty note is no note, so an existing one is not blanked', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    await POST(request({ submission_id: 'sub-1', triage_status: 'planned', triage_note: '   ' }));

    expect(mockSetTriage).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  test('refuses a status the database would reject, and a missing id', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    expect((await POST(request({ submission_id: 'sub-1', triage_status: 'wontfix' }))).status).toBe(400);

    mockResolvePrincipal.mockResolvedValueOnce(principal());
    expect((await POST(request({ triage_status: 'done' }))).status).toBe(400);

    expect(mockSetTriage).not.toHaveBeenCalled();
  });

  test('refuses a note longer than the field is meant to carry', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(
      request({ submission_id: 'sub-1', triage_status: 'done', triage_note: 'x'.repeat(2001) }),
    );

    expect(res.status).toBe(400);
    expect(mockSetTriage).not.toHaveBeenCalled();
  });

  // A submission id from another gym matches no row here. The admin has to be
  // told nothing happened, or they will believe a disclosure was handled.
  test('reports that nothing changed when no row in this gym matched', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockSetTriage.mockResolvedValueOnce(null);

    const res = await POST(request({ submission_id: 'sub-other-gym', triage_status: 'done' }));
    const payload = (await res.json()) as { ok: boolean; updated: boolean };

    expect(res.status).toBe(200);
    expect(payload.updated).toBe(false);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  // pilot.audit_events is readable by this gym's coaches, and a coach is one of
  // the people a child's disclosure can be about.
  test('the audit event carries no body, no note, no route and no submitter', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    await POST(
      request({
        submission_id: 'sub-1',
        triage_status: 'triaged',
        triage_note: 'Safeguarding lead spoke with her the same day.',
      }),
    );

    expect(mockAudit).toHaveBeenCalledWith({
      event_type: 'update',
      actor_account_id: 'acct-admin',
      actor_role: 'organization_admin',
      organization_id: 'org-1',
      entity_type: 'feedback_submission',
      entity_id: 'sub-1',
      details: { triage_status: 'triaged', note_written: true },
    });

    const serialized = JSON.stringify(mockAudit.mock.calls[0]?.[0]).toLowerCase();
    expect(serialized).not.toContain('safeguarding lead');
    expect(serialized).not.toContain('route');
  });
});
