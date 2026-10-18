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

// F-119: a member's own card carries no account id to a family viewer; their
// portrait is fetched by the card with no query. Staff keep theirs.
describe('GET /api/pilot/profile/me: the member\'s own account id (F-119)', () => {
  test('an athlete\'s own card carries no account id of their own', async () => {
    mockPrincipal.mockResolvedValue({ accountId: ATHLETE, role: 'athlete', organizationId: ORG, athleteId: 'ath-1' } as never);

    const raw = await (await GET(new NextRequest('https://ppbf.example/api/pilot/profile/me'))).text();
    const card = JSON.parse(raw).card;

    expect(card.accountId).toBeNull();
    expect(card.portraitPath).toBe('/api/pilot/profile/card/photo');
    expect(card.coachPortraitPath).toBe('/api/pilot/profile/card/coach-photo?coach_name=Coach%20Ray');
    expect(raw).not.toContain(ATHLETE);
  });

  test('a parent\'s own card: no email-shaped id anywhere', async () => {
    const PARENT = 'dana.vance@example.test';
    mockPrincipal.mockResolvedValue({ accountId: PARENT, role: 'parent', organizationId: ORG, athleteId: null } as never);
    mockIdentity.mockResolvedValue({
      accountId: PARENT, fullName: 'Dana Vance', athleteId: null, dob: null, coachAccountId: null, memberSince: null,
    } as never);

    const raw = await (await GET(new NextRequest('https://ppbf.example/api/pilot/profile/me'))).text();

    expect(JSON.parse(raw).card.accountId).toBeNull();
    expect(raw).not.toContain('@');
  });

  test('a parent with no usable login email: their own card names no id', async () => {
    // staffDisplayName's fallback, as the real read returns it: the id itself.
    const PARENT = 'dana.vance@example.test';
    mockPrincipal.mockResolvedValue({ accountId: PARENT, role: 'parent', organizationId: ORG, athleteId: null } as never);
    mockIdentity.mockResolvedValue({
      accountId: PARENT, fullName: PARENT, athleteId: null, dob: null, coachAccountId: null, memberSince: null,
    } as never);

    const raw = await (await GET(new NextRequest('https://ppbf.example/api/pilot/profile/me'))).text();

    expect(JSON.parse(raw).card.displayName).toBe('Gym member');
    expect(raw).not.toContain('@');
  });

  test('a coach\'s own card keeps the account id, as before', async () => {
    mockPrincipal.mockResolvedValue({ accountId: COACH, role: 'coach', organizationId: ORG, athleteId: null } as never);

    const card = (await (await GET(new NextRequest('https://ppbf.example/api/pilot/profile/me'))).json()).card;

    expect(card.accountId).toBe(COACH);
  });
});
