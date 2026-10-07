import { NextRequest } from 'next/server';

import { POST } from './route';
import { getSessionById, upsertSession, SESSION_NOTE_NOT_WRITER_MESSAGE } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { ForbiddenError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

/**
 * Who may change a session note (OD-2026-10-06-025 ruling 4, Jason
 * 2026-10-06: "Only the writer; coach adds own note").
 *
 * WHAT IS REAL AND WHAT IS FAKED. The session store and the athlete gate are
 * faked, so this file proves the ROUTE's half of the rule: it answers the
 * store's `noteWriter` question from the stored row's owner, never from the
 * payload, and it turns the store's refusal into a 403 with no audit row.
 * The store's half -- that the UPDATE itself cannot change the text for a
 * non-writer -- is proven against a real Postgres in
 * src/server/pilot/sessionNoteWriterOnly.pg.test.ts.
 */

jest.mock('@/src/server/pilot/entities', () => ({
  ...jest.requireActual('@/src/server/pilot/entities'),
  getSessionById: jest.fn(),
  upsertSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetSessionById = getSessionById as jest.Mock;
const mockUpsertSession = upsertSession as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;

const OWNER = 'ath-owner';

function principal(overrides: Record<string, unknown> = {}) {
  return { accountId: 'acct-owner', role: 'athlete', organizationId: 'org-a', athleteId: OWNER, ...overrides };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/sessions/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    athlete_id: OWNER,
    date: '2026-10-06',
    rpe: null,
    rpe_method: 'UNKNOWN',
    notes: 'legs heavy, slept badly',
    completed_flag: false,
    created_at: '2026-10-06T00:00:00Z',
    updated_at: '2026-10-06T00:00:00Z',
    ...overrides,
  };
}

function lastGuard() {
  return mockUpsertSession.mock.calls[mockUpsertSession.mock.calls.length - 1][2];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockAssertAccess.mockResolvedValue(undefined);
  mockGetSessionById.mockResolvedValue({ session_id: 'sess-1', athlete_id: OWNER, notes: 'first draft' });
});

describe('POST /api/pilot/sessions/update -- who may change the session note', () => {
  test('the athlete who owns the session is the writer: the store is told so', async () => {
    const response = await POST(request(payload({ notes: 'changed my mind' })));

    expect(response.status).toBe(200);
    expect(lastGuard()).toEqual({ mode: 'update', expectedAthleteId: OWNER, noteWriter: true });
    expect(writePilotAuditEvent).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the assigned coach', { accountId: 'coach-record', role: 'coach', athleteId: null }],
    ['an organization admin', { accountId: 'admin-1', role: 'organization_admin', athleteId: null }],
  ])('%s reaches the row but is not the writer: the store is told so', async (_label, caller) => {
    mockRequirePrincipal.mockResolvedValue(principal(caller));

    await POST(request(payload({ notes: 'coach rewrote this' })));

    expect(mockUpsertSession).toHaveBeenCalledTimes(1);
    expect(lastGuard()).toEqual({ mode: 'update', expectedAthleteId: OWNER, noteWriter: false });
  });

  test("the writer is decided from the STORED owner, not the payload's athlete_id", async () => {
    // An athlete who names their own id in the payload while the stored row
    // belongs to someone else is not that note's writer. (The athlete gate
    // would also refuse the stored owner; it is faked open here so the
    // writer decision is observed on its own.)
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-other', athleteId: 'ath-other' }));
    mockGetSessionById.mockResolvedValue({ session_id: 'sess-1', athlete_id: OWNER });

    await POST(request(payload({ athlete_id: 'ath-other' })));

    expect(lastGuard()).toEqual({ mode: 'update', expectedAthleteId: OWNER, noteWriter: false });
  });

  test("a coach who cannot reach the athlete is refused by the athlete gate before any write", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'coach-other', role: 'coach', athleteId: null }));
    mockAssertAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    const response = await POST(request(payload({ notes: 'other coach text' })));

    expect(response.status).toBe(403);
    expect(mockUpsertSession).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a parent is refused by the role gate before any lookup or write', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'parent-1', role: 'parent', athleteId: null }));

    const response = await POST(request(payload({ notes: 'parent text' })));

    expect(response.status).toBe(403);
    expect(mockGetSessionById).not.toHaveBeenCalled();
    expect(mockUpsertSession).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test("the store's writer-only refusal is a 403 with the stated reason and no audit row", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'coach-record', role: 'coach', athleteId: null }));
    mockUpsertSession.mockRejectedValueOnce(new ForbiddenError(SESSION_NOTE_NOT_WRITER_MESSAGE, 'SESSION_NOTE_WRITER_ONLY'));

    const response = await POST(request(payload({ notes: 'coach rewrote this' })));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe(SESSION_NOTE_NOT_WRITER_MESSAGE);
    expect(body.code).toBe('SESSION_NOTE_WRITER_ONLY');
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });
});
