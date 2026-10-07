import { NextRequest } from 'next/server';

import { GET } from './route';
import { getCoachReviewsBySession, getSessionById } from '@/src/server/pilot/entities';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// requirePrincipal is faked; the real access.ts and the real
// getCoachDisplayName (achievements.ts) run over a doubled db.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getSessionById: jest.fn(),
  getCoachReviewsBySession: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetSessionById = getSessionById as jest.Mock;
const mockGetCoachReviews = getCoachReviewsBySession as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

const COACH_ID = 'coach-alvarez@punxsyprominence.org';

// The storage row as `select * from pilot.coach_reviews` returns it.
const REVIEW = {
  organization_id: 'org-1',
  review_id: 'rev-1',
  session_id: 'sess-1',
  coach_id: COACH_ID,
  decision: 'progress',
  notes: 'Jab is landing. Keep the rear hand home.',
  approved_flag: true,
  created_at: '2026-08-03T00:00:00.000Z',
  updated_at: '2026-08-03T00:00:00.000Z',
};

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest(sessionId: string) {
  return new NextRequest(`http://localhost/api/pilot/coach-reviews/list?session_id=${sessionId}`);
}

/**
 * queryOne answers by statement: assertActorCanAccessAthlete's live-row check
 * gets the athlete; the name reader's account lookup gets the coach's login,
 * or nothing, which is what its own SQL returns for a deleted account.
 */
function dbWithCoach(loginEmail: string | null) {
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('login_email')) {
      return loginEmail === null ? null : { login_email: loginEmail };
    }
    return { athlete_id: 'ath-1' };
  });
}

describe('GET /api/pilot/coach-reviews/list', () => {
  // A session id that does not resolve inside the caller's organization is a
  // not-found, and must be indistinguishable from one owned by another gym --
  // not a masked server error.
  test('404 for a session that does not exist in this organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetSessionById.mockResolvedValueOnce(null);

    const res = await GET(getRequest('sess-other-org'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockGetCoachReviews).not.toHaveBeenCalled();
  });

  test('200 for a session the athlete owns', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetSessionById.mockResolvedValueOnce({ session_id: 'sess-1', athlete_id: 'ath-1' });
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // live athlete row (assertActorCanAccessAthlete)
    mockGetCoachReviews.mockResolvedValueOnce([]);

    const res = await GET(getRequest('sess-1'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });

  /*
   * OD-2026-10-06-025 ruling 2: a family sees the coach's display name, never
   * the internal account id. The reader is `select *`, so the projection is
   * what stands between the row and the athlete's browser; these cases watch
   * the WHOLE serialised body.
   */
  describe('what an athlete receives', () => {
    test('the review with coach_name in its place, and no staff account id anywhere in the body', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());
      mockGetSessionById.mockResolvedValueOnce({ session_id: 'sess-1', athlete_id: 'ath-1' });
      dbWithCoach('alvarez@punxsyprominence.org');
      mockGetCoachReviews.mockResolvedValueOnce([REVIEW, { ...REVIEW, review_id: 'rev-2', decision: 'hold' }]);

      const res = await GET(getRequest('sess-1'));
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).not.toContain(COACH_ID);
      expect(text).not.toContain('coach_id');
      expect(JSON.parse(text)).toEqual({
        items: [
          {
            review_id: 'rev-1',
            session_id: 'sess-1',
            coach_name: 'Coach Alvarez',
            decision: 'progress',
            notes: 'Jab is landing. Keep the rear hand home.',
            approved_flag: true,
            created_at: '2026-08-03T00:00:00.000Z',
            updated_at: '2026-08-03T00:00:00.000Z',
          },
          {
            review_id: 'rev-2',
            session_id: 'sess-1',
            coach_name: 'Coach Alvarez',
            decision: 'hold',
            notes: 'Jab is landing. Keep the rear hand home.',
            approved_flag: true,
            created_at: '2026-08-03T00:00:00.000Z',
            updated_at: '2026-08-03T00:00:00.000Z',
          },
        ],
      });
      // One lookup for the one coach, asked in this gym.
      const nameLookups = mockQueryOne.mock.calls.filter(([sql]) => String(sql).includes('login_email'));
      expect(nameLookups).toHaveLength(1);
      expect(nameLookups[0][1]).toEqual(['org-1', COACH_ID]);
    });

    test('a deleted coach shows the neutral phrase, never the id', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());
      mockGetSessionById.mockResolvedValueOnce({ session_id: 'sess-1', athlete_id: 'ath-1' });
      dbWithCoach(null); // the reader's SQL excludes a deleted account
      mockGetCoachReviews.mockResolvedValueOnce([REVIEW]);

      const res = await GET(getRequest('sess-1'));
      const text = await res.text();

      expect(JSON.parse(text).items[0].coach_name).toBe('Your coach');
      expect(text).not.toContain(COACH_ID);
      const nameLookup = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('login_email'));
      expect(nameLookup?.[0]).toContain('deleted_at is not null');
    });
  });

  describe('what staff receive is unchanged', () => {
    test('a coach gets the rows exactly as read, byte for byte', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', accountId: COACH_ID, athleteId: null }));
      mockGetSessionById.mockResolvedValueOnce({ session_id: 'sess-1', athlete_id: 'ath-1' });
      mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // coach of record (assertCoachAssignedToAthlete)
      mockGetCoachReviews.mockResolvedValueOnce([REVIEW]);

      const res = await GET(getRequest('sess-1'));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(JSON.stringify({ items: [REVIEW] }));
      expect(mockQueryOne.mock.calls.some(([sql]) => String(sql).includes('login_email'))).toBe(false);
    });

    test('an organization admin gets the rows exactly as read, byte for byte', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin', accountId: 'admin-1', athleteId: null }));
      mockGetSessionById.mockResolvedValueOnce({ session_id: 'sess-1', athlete_id: 'ath-1' });
      mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // live athlete row
      mockGetCoachReviews.mockResolvedValueOnce([REVIEW]);

      const res = await GET(getRequest('sess-1'));

      expect(await res.text()).toBe(JSON.stringify({ items: [REVIEW] }));
    });
  });
});
