import { NextRequest } from 'next/server';

import { POST } from './route';
import { getSessionById, upsertSession } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { ConflictError } from '@/src/server/pilot/errors';

jest.mock('@/src/server/pilot/entities', () => ({
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

function principal() {
  return { accountId: 'acct-attacker', role: 'athlete', organizationId: 'org-a', athleteId: 'ath-attacker' };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    athlete_id: 'ath-attacker',
    date: '2026-08-25',
    rpe: null,
    rpe_method: 'UNKNOWN',
    notes: 'felt strong',
    completed_flag: false,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockAssertAccess.mockResolvedValue(undefined);
});

describe('POST /api/pilot/sessions', () => {
  // The hijack: reuse a session_id that belongs to another athlete, naming
  // your OWN athlete_id in the payload. Before the fix the only access check
  // was on payload.athlete_id (which passes), and the UPDATE-first upsert
  // then reassigned the victim's row. The stored-owner check must run and
  // must refuse when the caller cannot access the CURRENT owner.
  test('a reused session_id owned by another athlete is refused before the write', async () => {
    mockGetSessionById.mockResolvedValueOnce({ session_id: 'sess-1', athlete_id: 'ath-victim' });
    mockAssertAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
      if (athleteId === 'ath-victim') throw new Error('Forbidden: not your athlete');
    });

    const response = await POST(request(payload()));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockAssertAccess).toHaveBeenCalledWith(expect.anything(), 'ath-victim');
    expect(mockUpsertSession).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a genuinely new session_id has no stored owner and writes normally', async () => {
    mockGetSessionById.mockResolvedValueOnce(null);

    const response = await POST(request(payload()));

    expect(response.status).toBe(200);
    expect(mockUpsertSession).toHaveBeenCalledTimes(1);
  });

  test('a new id is written in create mode; an existing own id in update mode carrying the authorized owner', async () => {
    // The guard mode the route passes is what makes the store's write atomic:
    // create -> INSERT ON CONFLICT DO NOTHING; update -> UPDATE ... WHERE
    // athlete_id = the owner just authorized.
    mockGetSessionById.mockResolvedValueOnce(null);
    await POST(request(payload()));
    expect(mockUpsertSession).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { mode: 'create' });

    mockGetSessionById.mockResolvedValueOnce({ session_id: 'sess-1', athlete_id: 'ath-attacker' });
    const response = await POST(request(payload()));
    expect(response.status).toBe(200);
    expect(mockUpsertSession).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      { mode: 'update', expectedAthleteId: 'ath-attacker' },
    );
  });

  test('a concurrent-write conflict from the store is a 409 with no audit', async () => {
    // The atomic write throws when the id appeared, or the owner changed,
    // between the lookup and the write. The route must surface that and never
    // record an audit for a write that did not happen.
    mockGetSessionById.mockResolvedValueOnce(null);
    mockUpsertSession.mockRejectedValueOnce(new ConflictError('A session with that id already exists.'));

    const response = await POST(request(payload()));

    expect(response.status).toBe(409);
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });
});
