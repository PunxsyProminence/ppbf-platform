import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { query } from '@/src/server/pilot/db';
import {
  acknowledgeEscalation,
  detectRepeatedPatternEscalations,
  listEscalations,
  resolveEscalation,
} from '@/src/server/pilot/escalationLadder';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/escalationLadder', () => ({
  listEscalations: jest.fn(),
  acknowledgeEscalation: jest.fn(),
  resolveEscalation: jest.fn(),
  detectRepeatedPatternEscalations: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn().mockResolvedValue([]),
}));

const mockDbQuery = jest.mocked(query);

jest.mock('@/src/server/pilot/http', () => ({
  requirePrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Unauthorized')
      ? 401
      : message.startsWith('Forbidden')
        ? 403
        : message.startsWith('Missing') || message.startsWith('Unsupported')
          ? 400
          : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listEscalations);
const mockAcknowledge = jest.mocked(acknowledgeEscalation);
const mockResolve = jest.mocked(resolveEscalation);
const mockScanPatterns = jest.mocked(detectRepeatedPatternEscalations);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-caller',
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
  return new NextRequest('https://ppbf.example/api/pilot/escalations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/escalations', () => {
  test('organization_admin lists org-wide with no athlete scoping', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/escalations'));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a', { status: undefined, athleteIds: undefined });
  });

  test('athlete, parent, and board are refused -- this is a coach/admin surface', async () => {
    for (const role of ['athlete', 'parent', 'board']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request('/api/pilot/escalations'));
      expect(response.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an invalid status filter is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await GET(request('/api/pilot/escalations?status=nonsense'));

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  // The one thing standing between a coach and every other child's safety
  // record in the gym is this athleteIds scope -- it must be the coach's own
  // roster from the database, not absent and not caller-supplied.
  test('a coach lists only their own athletes: athleteIds comes from their roster query', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockDbQuery.mockResolvedValueOnce([{ athlete_id: 'ATH-1' }, { athlete_id: 'ATH-2' }] as never);
    mockList.mockResolvedValueOnce([]);

    await GET(request('/api/pilot/escalations'));

    const [rosterSql, rosterParams] = mockDbQuery.mock.calls[0];
    expect(String(rosterSql)).toContain('from pilot.athletes');
    expect(rosterParams).toEqual(['org-a', 'acct-coach-1']);
    expect(mockList).toHaveBeenCalledWith('org-a', {
      status: undefined,
      athleteIds: ['ATH-1', 'ATH-2'],
      excludeAthleteVoice: true,
    });
  });

  test('a coach with no assigned athletes gets an empty scope, never the org-wide view', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-lonely' }));
    mockDbQuery.mockResolvedValueOnce([] as never);
    mockList.mockResolvedValueOnce([]);

    await GET(request('/api/pilot/escalations'));

    // [] must reach the SQL as [], which matches nothing -- undefined would
    // mean "no filter" and expose every athlete's escalations.
    expect(mockList).toHaveBeenCalledWith('org-a', {
      status: undefined,
      athleteIds: [],
      excludeAthleteVoice: true,
    });
  });

  // #198: an athlete_voice escalation exists because a child typed something
  // into the feedback box. Its presence on a coach's list -- even with a
  // non-disclosing reason -- tells the athlete's coach the athlete said
  // something, and the coach may be exactly who the child is disclosing
  // about. Admin lists carry the rows; coach lists never do.
  test('a coach list always excludes athlete_voice; an admin list never does', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockDbQuery.mockResolvedValueOnce([{ athlete_id: 'ATH-1' }] as never);
    mockList.mockResolvedValueOnce([]);
    await GET(request('/api/pilot/escalations'));
    expect(mockList.mock.calls[0][1]).toMatchObject({ excludeAthleteVoice: true });

    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([]);
    await GET(request('/api/pilot/escalations'));
    expect(mockList.mock.calls[1][1]?.excludeAthleteVoice).not.toBe(true);
  });

  // T-002: the coach roster query unions in actively covered athletes -- a
  // covering coach who can read the athlete's pain reports must also see
  // the escalations they feed, or coverage hands them the data but not the
  // alarm.
  test("the coach scope includes actively covered athletes via the coverage union", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-sub' }));
    mockDbQuery.mockResolvedValueOnce([{ athlete_id: 'ATH-ASSIGNED' }, { athlete_id: 'ATH-COVERED' }] as never);
    mockList.mockResolvedValueOnce([]);

    await GET(request('/api/pilot/escalations'));

    const [rosterSql] = mockDbQuery.mock.calls[0];
    expect(String(rosterSql)).toContain('pilot.coach_coverage');
    expect(String(rosterSql)).toContain('expires_at > now()');
    expect(mockList).toHaveBeenCalledWith('org-a', {
      status: undefined,
      athleteIds: ['ATH-ASSIGNED', 'ATH-COVERED'],
      excludeAthleteVoice: true,
    });
  });

  test('a missing coverage table (pre-migration) falls back to assigned athletes, never a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockDbQuery
      .mockRejectedValueOnce(Object.assign(new Error('relation "pilot.coach_coverage" does not exist'), { code: '42P01' }))
      .mockResolvedValueOnce([{ athlete_id: 'ATH-1' }] as never);
    mockList.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/escalations'));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a', {
      status: undefined,
      athleteIds: ['ATH-1'],
      excludeAthleteVoice: true,
    });
  });
});

describe('POST /api/pilot/escalations acknowledge', () => {
  test('an admin can acknowledge any escalation in the org', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAcknowledge.mockResolvedValueOnce({ escalation_id: 'esc-1', status: 'acknowledged' } as never);

    const response = await POST(jsonRequest({ action: 'acknowledge', escalation_id: 'esc-1' }));

    expect(response.status).toBe(200);
    expect(mockAcknowledge).toHaveBeenCalledWith('org-a', 'esc-1', 'acct-caller');
  });

  test('a coach can acknowledge an escalation for their own athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockList.mockResolvedValueOnce([{ escalation_id: 'esc-1' } as never]);
    mockAcknowledge.mockResolvedValueOnce({ escalation_id: 'esc-1', status: 'acknowledged' } as never);

    const response = await POST(jsonRequest({ action: 'acknowledge', escalation_id: 'esc-1' }));

    expect(response.status).toBe(200);
  });

  test('a coach cannot acknowledge an escalation outside their own athletes', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockList.mockResolvedValueOnce([]); // no escalations scoped to this coach's athletes

    const response = await POST(jsonRequest({ action: 'acknowledge', escalation_id: 'esc-not-mine' }));

    expect(response.status).toBe(400);
    expect(mockAcknowledge).not.toHaveBeenCalled();
  });

  // The module throws when the escalation exists but the transition is not
  // legal from its current state (e.g. acknowledging a resolved record).
  // That must surface as a 400 caller error, not a masked 500.
  test('an illegal transition from the module surfaces as a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAcknowledge.mockRejectedValueOnce(
      new Error("Unsupported transition: escalation is 'resolved' and cannot move to 'acknowledged'"),
    );

    const response = await POST(jsonRequest({ action: 'acknowledge', escalation_id: 'esc-1' }));

    expect(response.status).toBe(400);
  });
});

describe('POST /api/pilot/escalations resolve', () => {
  test('an admin can resolve', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockResolve.mockResolvedValueOnce({ escalation_id: 'esc-1', status: 'resolved' } as never);

    const response = await POST(jsonRequest({ action: 'resolve', escalation_id: 'esc-1', resolution_note: 'Cleared.' }));

    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith('org-a', 'esc-1', 'acct-caller', 'Cleared.');
  });

  // Resolving is the final call that a red flag is closed out -- reserved
  // for admin, matching the compliance-violations precedent. A coach can
  // acknowledge but not resolve.
  test('a coach cannot resolve, even their own athlete\'s escalation', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest({ action: 'resolve', escalation_id: 'esc-1' }));

    expect(response.status).toBe(403);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/escalations scan_patterns', () => {
  test('an admin can trigger a pattern scan', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockScanPatterns.mockResolvedValueOnce([{ escalation_id: 'esc-new' } as never]);

    const response = await POST(jsonRequest({ action: 'scan_patterns' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, filed_count: 1 });
  });

  test('a coach cannot trigger a pattern scan', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest({ action: 'scan_patterns' }));

    expect(response.status).toBe(403);
    expect(mockScanPatterns).not.toHaveBeenCalled();
  });
});
