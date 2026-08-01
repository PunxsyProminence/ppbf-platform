import { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { createRabbitHole, type AuthoredRabbitHole } from '@/src/server/pilot/rabbitHoles';

import { POST } from './route';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

// The write is stubbed; the role rule in front of it is the real one.
jest.mock('@/src/server/pilot/rabbitHoles', () => ({
  ...jest.requireActual('@/src/server/pilot/rabbitHoles'),
  createRabbitHole: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockCreateRabbitHole = createRabbitHole as jest.MockedFunction<typeof createRabbitHole>;
const mockAudit = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;

const LESSON: AuthoredRabbitHole = {
  rabbit_hole_id: 'rh-1',
  anchor_type: 'gap_type',
  anchor_key: 'technique',
  audience: 'athlete',
  title: 'Kinetic force transfer',
  concept: 'Power does not generate in the shoulders.',
  homework: 'Thirty slow crosses, three seconds at full extension.',
  author_display_name: 'Coach Jason',
  citation: null,
  created_at: '2026-07-30T12:00:00.000Z',
  updated_at: '2026-07-30T12:00:00.000Z',
  status: 'published',
  author_account_id: 'acct-coach',
  library_document_id: null,
};

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-coach',
    role: 'coach',
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token-1',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/rabbit-holes/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = {
  anchor_type: 'gap_type',
  anchor_key: 'technique',
  audience: 'athlete',
  title: 'Kinetic force transfer',
  concept: 'Power does not generate in the shoulders.',
  homework: 'Thirty slow crosses, three seconds at full extension.',
  author_display_name: 'Coach Jason',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateRabbitHole.mockResolvedValue(LESSON);
});

describe('POST /api/pilot/rabbit-holes/post', () => {
  test('refuses an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const response = await POST(request(VALID));

    expect(response.status).toBe(401);
    expect(mockCreateRabbitHole).not.toHaveBeenCalled();
  });

  // A PIN session is athlete self-service; a lesson speaks to the whole gym.
  test('refuses a PIN-authenticated session', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local' }));

    const response = await POST(request(VALID));

    expect(response.status).toBe(403);
    expect(mockCreateRabbitHole).not.toHaveBeenCalled();
  });

  test('refuses every role that may not author', async () => {
    for (const role of ['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner'] as const) {
      mockResolvePrincipal.mockResolvedValueOnce(principal({ role }));

      const response = await POST(request(VALID));

      expect(response.status).toBe(403);
    }
    expect(mockCreateRabbitHole).not.toHaveBeenCalled();
  });

  // The owner's decision: a coach writes and publishes directly. Nothing here
  // routes the lesson to a reviewer, because there is no reviewer.
  test('a coach write publishes immediately, attributed and audited', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(request({ ...VALID, organization_id: 'org-b' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rabbit_hole.status).toBe('published');
    // The organization and the author come from the session, never the body.
    expect(mockCreateRabbitHole).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', authorAccountId: 'acct-coach' }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'create',
        entity_type: 'rabbit_hole',
        entity_id: 'rh-1',
        organization_id: 'org-a',
      }),
    );
  });

  test('an administrator may write as well', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ accountId: 'acct-admin', role: 'organization_admin' }));

    const response = await POST(request(VALID));

    expect(response.status).toBe(200);
  });

  // The anchor rules live in the module, so the route only has to not swallow
  // them: an unusable anchor must reach the caller as a bad request.
  test('an unusable anchor is reported as a bad request', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockCreateRabbitHole.mockRejectedValueOnce(
      new Error('Unsupported anchor_key: not a value of the gap_type vocabulary'),
    );

    const response = await POST(request({ ...VALID, anchor_key: 'not-a-gap-type' }));

    expect(response.status).toBe(400);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
