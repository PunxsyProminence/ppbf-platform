import { NextRequest } from 'next/server';

import { GET } from './route';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  getAccountProfile,
  getSubjectIdentity,
  resolveRelationship,
} from '@/src/server/pilot/profileDb';

// OD-2026-10-06-025 ruling 2: families see a coach's display name, never the
// internal account id. The reads are faked; buildFightCard, toProfileSubject
// and the visibility decisions are the real ones.
jest.mock('@/src/server/pilot/profileDb', () => {
  const actual = jest.requireActual('@/src/server/pilot/profileDb');
  return {
    toProfileSubject: actual.toProfileSubject,
    getSubjectIdentity: jest.fn(),
    getAccountProfile: jest.fn(),
    assertViewerMayReachSubject: jest.fn(),
    resolveRelationship: jest.fn(),
  };
});
jest.mock('@/src/server/pilot/db', () => ({ queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = jest.mocked(requirePrincipal);
const mockIdentity = jest.mocked(getSubjectIdentity);
const mockProfile = jest.mocked(getAccountProfile);
const mockReach = jest.mocked(assertViewerMayReachSubject);
const mockRelationship = jest.mocked(resolveRelationship);
const mockQueryOne = jest.mocked(queryOne);

const ORG = 'org-a';
const COACH = 'acct-coach-7f3a';
const ATHLETE = 'acct-athlete';

const IDENTITIES: Record<string, unknown> = {
  [ATHLETE]: {
    accountId: ATHLETE, fullName: 'Marisol Vance', athleteId: 'ath-1', dob: '2013-04-02',
    coachAccountId: COACH, memberSince: '2026-01-01T00:00:00Z',
  },
  [COACH]: {
    accountId: COACH, fullName: 'Ray Nolan', athleteId: null, dob: null,
    coachAccountId: null, memberSince: '2025-01-01T00:00:00Z',
  },
};

function profileFor(accountId: string) {
  return {
    organizationId: ORG, accountId, nickname: null, nicknameClearedAt: null,
    corner: 'none', program: 'unstated',
    photoBlobPath: `profile/${accountId}.jpg`, photoContentType: 'image/jpeg',
    photoReviewState: 'released', photoUploadedAt: '2026-08-10 09:00:00+00',
  } as never;
}

/** Each viewer, the account it signs in as, and how it stands to the card and to the coach. */
const VIEWERS = {
  athlete: { accountId: ATHLETE, athleteId: 'ath-1', card: 'self', coach: 'subject_is_my_staff', keepsId: false },
  parent: { accountId: 'acct-parent', athleteId: null, card: 'guardian_of_subject', coach: 'subject_is_my_staff', keepsId: false },
  coach: { accountId: COACH, athleteId: null, card: 'coach_of_subject', coach: 'self', keepsId: true },
  organization_admin: { accountId: 'acct-admin', athleteId: null, card: 'organization_staff', coach: 'organization_staff', keepsId: true },
  admin: { accountId: 'acct-admin-legacy', athleteId: null, card: 'organization_staff', coach: 'organization_staff', keepsId: true },
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockImplementation(async (_org, accountId) => (IDENTITIES[accountId] ?? null) as never);
  mockProfile.mockImplementation(async (_org, accountId) => profileFor(accountId));
  mockReach.mockResolvedValue(undefined);
  mockQueryOne.mockImplementation(async (_sql, params) =>
    ((params as unknown[])[1] === 'ath-1' ? { account_id: ATHLETE } : null) as never);
});

describe('GET /api/pilot/profile/card: the coach line, by viewer role', () => {
  test.each(Object.entries(VIEWERS))('%s', async (role, viewer) => {
    mockPrincipal.mockResolvedValue(
      { accountId: viewer.accountId, role, organizationId: ORG, athleteId: viewer.athleteId } as never,
    );
    mockRelationship.mockImplementation(async (_v, subject) =>
      (subject.accountId === COACH ? viewer.coach : viewer.card) as never);

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/profile/card?athlete_id=ath-1'));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as { card: Record<string, unknown> };

    // Everyone who may open the card sees who is in the corner.
    expect(body.card.coachName).toBe('Ray Nolan');
    expect(body.card.coachPhotoAvailable).toBe(true);
    if (viewer.keepsId) {
      expect(body.card.coachAccountId).toBe(COACH);
    } else {
      expect(body.card.coachAccountId).toBeNull();
      // Not under this key, not under any other.
      expect(raw).not.toContain(COACH);
    }
  });
});
