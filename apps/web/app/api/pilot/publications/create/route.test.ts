import { NextRequest } from 'next/server';

import { POST } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/publications/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A publication carries a named youth athlete's video into a research or
// public surface, so it must clear the same gates the violations route
// applies: the actor's access to the athlete, and the video session belonging
// to this organization and to that same athlete.
describe('POST /api/pilot/publications/create', () => {
  test('403 when a coach publishes an athlete they are not assigned to', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await POST(
      postRequest({ video_session_id: 'vid-1', athlete_id: 'ath-other', publication_type: 'research_library' }),
    );

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('403 when an organization_admin publishes an athlete from another organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await POST(
      postRequest({ video_session_id: 'vid-1', athlete_id: 'ath-other-org', publication_type: 'research_library' }),
    );

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('cross-organization video_session_id returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce(null); // video session not found in this org

    const res = await POST(
      postRequest({ video_session_id: 'vid-other-org', athlete_id: 'ath-1', publication_type: 'research_library' }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('video_session_id attributed to a different athlete returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-2' });

    const res = await POST(
      postRequest({ video_session_id: 'vid-1', athlete_id: 'ath-1', publication_type: 'research_library' }),
    );

    expect(res.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('201 when the athlete is accessible and the video session matches', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    const res = await POST(
      postRequest({
        video_session_id: 'vid-1',
        athlete_id: 'ath-1',
        publication_type: 'research_library',
        title: 'Jab mechanics',
      }),
    );

    expect(res.status).toBe(201);
  });
});
