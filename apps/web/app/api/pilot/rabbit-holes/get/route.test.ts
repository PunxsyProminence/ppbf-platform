import { NextRequest } from 'next/server';

import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { listAuthoredRabbitHoles, listPublishedRabbitHoles } from '@/src/server/pilot/rabbitHoles';

import { POST } from './route';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

// The reads are stubbed; the validation and role rules around them are the
// real ones.
jest.mock('@/src/server/pilot/rabbitHoles', () => ({
  ...jest.requireActual('@/src/server/pilot/rabbitHoles'),
  listPublishedRabbitHoles: jest.fn(),
  listAuthoredRabbitHoles: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockListPublished = listPublishedRabbitHoles as jest.MockedFunction<typeof listPublishedRabbitHoles>;
const mockListAuthored = listAuthoredRabbitHoles as jest.MockedFunction<typeof listAuthoredRabbitHoles>;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-athlete',
    role: 'athlete',
    organizationId: 'org-a',
    athleteId: 'ath-1',
    sessionToken: 'token-1',
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/rabbit-holes/get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListPublished.mockResolvedValue([]);
  mockListAuthored.mockResolvedValue([]);
});

describe('POST /api/pilot/rabbit-holes/get', () => {
  test('refuses an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const response = await POST(request({ anchor_type: 'gap_type', anchor_key: 'technique' }));

    expect(response.status).toBe(401);
    expect(mockListPublished).not.toHaveBeenCalled();
  });

  // A lesson never crosses gyms, and the reader never chooses which gym they
  // are reading: the organization comes from the session, not the body.
  test('reads the caller own organization and role, never the body', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(
      request({
        anchor_type: 'gap_type',
        anchor_key: 'technique',
        organization_id: 'org-b',
        role: 'organization_admin',
      }),
    );

    expect(response.status).toBe(200);
    expect(mockListPublished).toHaveBeenCalledWith({
      organizationId: 'org-a',
      anchorType: 'gap_type',
      anchorKey: 'technique',
      role: 'athlete',
    });
  });

  test('refuses an anchor_type outside the vocabulary', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(request({ anchor_type: 'dashboard_card', anchor_key: 'kinetic-force-card' }));

    expect(response.status).toBe(400);
    expect(mockListPublished).not.toHaveBeenCalled();
  });

  test('refuses a missing anchor_key', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(request({ anchor_type: 'gap_type', anchor_key: '   ' }));

    expect(response.status).toBe(400);
    expect(mockListPublished).not.toHaveBeenCalled();
  });

  // A retired lesson is one the gym decided to stop showing. Only the roles
  // that may author can reach it.
  test('the authoring view is refused to a reader and served to a coach', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    const refused = await POST(request({ view: 'authoring' }));
    expect(refused.status).toBe(403);
    expect(mockListAuthored).not.toHaveBeenCalled();

    mockResolvePrincipal.mockResolvedValueOnce(principal({ accountId: 'acct-coach', role: 'coach' }));
    const served = await POST(request({ view: 'authoring', anchor_type: 'gap_type', limit: 10 }));
    expect(served.status).toBe(200);
    expect(mockListAuthored).toHaveBeenCalledWith({
      organizationId: 'org-a',
      anchorType: 'gap_type',
      anchorKey: undefined,
      limit: 10,
    });
  });

  test('the authoring view refuses an anchor_type outside the vocabulary', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));

    const response = await POST(request({ view: 'authoring', anchor_type: 'dashboard_card' }));

    expect(response.status).toBe(400);
    expect(mockListAuthored).not.toHaveBeenCalled();
  });
});
