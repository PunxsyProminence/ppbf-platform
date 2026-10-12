import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getAccountProfile, getSubjectIdentity } from '@/src/server/pilot/profileDb';

// An athlete's own card goes out through this route as well as through
// /profile/card, so the family rule (OD-2026-10-06-025 ruling 2) is held here
// too: the athlete sees their coach's name and never the coach's account id.
jest.mock('@/src/server/pilot/profileDb', () => ({
  getSubjectIdentity: jest.fn(),
  getAccountProfile: jest.fn(),
}));
jest.mock('@/src/server/pilot/achievements', () => ({
  getCoachDisplayName: jest.fn(async () => 'Coach Ray'),
}));
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = jest.mocked(requirePrincipal);
const mockIdentity = jest.mocked(getSubjectIdentity);
const mockProfile = jest.mocked(getAccountProfile);

const ORG = 'org-a';
const COACH = 'acct-coach-7f3a';
const ATHLETE = 'acct-athlete';

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockImplementation(async (_org, accountId) => (accountId === ATHLETE
    ? {
      accountId: ATHLETE, fullName: 'Marisol Vance', athleteId: 'ath-1', dob: '2013-04-02',
      coachAccountId: COACH, memberSince: '2026-01-01T00:00:00Z',
    }
    : {
      accountId: COACH, fullName: 'Ray Nolan', athleteId: null, dob: null,
      coachAccountId: null, memberSince: '2025-01-01T00:00:00Z',
    }) as never);
  mockProfile.mockImplementation(async (_org, accountId) => ({
    organizationId: ORG, accountId, nickname: null, nicknameClearedAt: null,
    corner: 'none', program: 'unstated',
    photoBlobPath: `profile/${accountId}.jpg`, photoContentType: 'image/jpeg',
    photoReviewState: 'released', photoUploadedAt: '2026-08-10 09:00:00+00',
  }) as never);
});

describe('GET /api/pilot/profile/me', () => {
  test('an athlete\'s own card names their coach and carries no coach account id', async () => {
    mockPrincipal.mockResolvedValue({ accountId: ATHLETE, role: 'athlete', organizationId: ORG, athleteId: 'ath-1' } as never);

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/profile/me'));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as { card: Record<string, unknown> };

    // The family reader, not the staff name (which can be the id itself).
    expect(body.card.coachName).toBe('Coach Ray');
    expect(body.card.coachPhotoAvailable).toBe(true);
    expect(body.card.coachAccountId).toBeNull();
    expect(raw).not.toContain(COACH);
  });
});
