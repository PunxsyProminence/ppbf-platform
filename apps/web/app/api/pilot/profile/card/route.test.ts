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
// The family name reader. Its own derivation (digits dropped, "Coach" prefix,
// never an id) is tested in achievements; here what matters is WHO gets it.
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

    // Everyone who may open the card sees who is in the corner; a family
    // through the family reader, staff through the card's staff name.
    expect(body.card.coachName).toBe(viewer.keepsId ? 'Ray Nolan' : 'Coach Ray');
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

describe('GET /api/pilot/profile/card: a coach whose staff name IS the account id', () => {
  // profileDb.staffDisplayName returns the account id when the login email
  // yields no name, and a capitalised stem otherwise ("Rnolan7").
  test.each(['athlete', 'parent'] as const)('%s viewer never sees it, under any key', async (role) => {
    const viewer = VIEWERS[role];
    mockPrincipal.mockResolvedValue(
      { accountId: viewer.accountId, role, organizationId: ORG, athleteId: viewer.athleteId } as never,
    );
    mockRelationship.mockImplementation(async (_v, subject) =>
      (subject.accountId === COACH ? viewer.coach : viewer.card) as never);
    mockIdentity.mockImplementation(async (_org, accountId) => (accountId === COACH
      ? { ...(IDENTITIES[COACH] as object), fullName: COACH }
      : IDENTITIES[accountId] ?? null) as never);

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/profile/card?athlete_id=ath-1'));
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(raw).card.coachName).toBe('Coach Ray');
    expect(raw).not.toContain(COACH);
  });
});

/*
 * #1558 item three: the card OF a staff member, opened by a family viewer
 * (their child's coach). The staff name falls back to the account id, or
 * keeps the login's digits; a family viewer is given the family name reader's
 * name instead (OD-2026-10-06-025 ruling 2). Staff viewers, and anyone looking
 * at their OWN card, read the name as before.
 */
describe('GET /api/pilot/profile/card: the card of a staff member, by viewer', () => {
  const withNamelessCoach = () =>
    mockIdentity.mockImplementation(async (_org, accountId) => (accountId === COACH
      ? { ...(IDENTITIES[COACH] as object), fullName: COACH }
      : IDENTITIES[accountId] ?? null) as never);
  const staffCard = () => GET(new NextRequest(`https://ppbf.example/api/pilot/profile/card?account_id=${COACH}`));

  test.each(['athlete', 'parent'] as const)('a %s viewer is shown the family name, never the id', async (role) => {
    const viewer = VIEWERS[role];
    mockPrincipal.mockResolvedValue(
      { accountId: viewer.accountId, role, organizationId: ORG, athleteId: viewer.athleteId } as never,
    );
    mockRelationship.mockResolvedValue('subject_is_my_staff' as never);
    withNamelessCoach();

    const response = await staffCard();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.card.displayName).toBe('Coach Ray');
    expect(body.card.initials).toBe('CR');
  });

  test.each(['coach', 'organization_admin'] as const)('a %s viewer reads the staff name as before', async (role) => {
    const viewer = VIEWERS[role];
    mockPrincipal.mockResolvedValue(
      { accountId: viewer.accountId, role, organizationId: ORG, athleteId: viewer.athleteId } as never,
    );
    mockRelationship.mockResolvedValue('organization_staff' as never);
    withNamelessCoach();

    const body = await (await staffCard()).json();

    expect(body.card.displayName).toBe(COACH);
  });

  test('a parent looking at their OWN card reads their own name, not the coach floor', async () => {
    const PARENT = 'acct-parent';
    mockPrincipal.mockResolvedValue({ accountId: PARENT, role: 'parent', organizationId: ORG, athleteId: null } as never);
    mockRelationship.mockResolvedValue('self' as never);
    mockIdentity.mockImplementation(async (_org, accountId) => (accountId === PARENT
      ? { accountId: PARENT, fullName: 'Dana Vance', athleteId: null, dob: null, coachAccountId: null, memberSince: null }
      : IDENTITIES[accountId] ?? null) as never);

    const body = await (await GET(new NextRequest('https://ppbf.example/api/pilot/profile/card'))).json();

    expect(body.card.displayName).toBe('Dana Vance');
  });
});

/*
 * F-119 (live audit 2026-10-17): the parent hub's card reads carried the
 * parent's OWN account id, which is email-shaped, and the child's. A family's
 * card now carries no account id at all; its portraits are addressed by the
 * handle the family already holds. Staff cards are unchanged.
 */
describe('GET /api/pilot/profile/card: no account id on a family card (F-119)', () => {
  const PARENT = 'dana.vance@example.test';

  function asViewer(role: keyof typeof VIEWERS, accountId: string = VIEWERS[role].accountId) {
    const viewer = VIEWERS[role];
    mockPrincipal.mockResolvedValue({ accountId, role, organizationId: ORG, athleteId: viewer.athleteId } as never);
    mockRelationship.mockImplementation(async (_v, subject) =>
      (subject.accountId === COACH ? viewer.coach : viewer.card) as never);
  }

  test('a parent\'s own card: no id, no @, portraits addressed with no query', async () => {
    asViewer('parent', PARENT);
    mockRelationship.mockResolvedValue('self' as never);
    mockIdentity.mockImplementation(async (_org, accountId) => (accountId === PARENT
      ? { accountId: PARENT, fullName: 'Dana Vance', athleteId: null, dob: null, coachAccountId: null, memberSince: null }
      : IDENTITIES[accountId] ?? null) as never);

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/profile/card'));
    const raw = await response.text();
    const card = JSON.parse(raw).card;

    expect(response.status).toBe(200);
    expect(card.accountId).toBeNull();
    expect(card.portraitPath).toBe('/api/pilot/profile/card/photo');
    expect(raw).not.toContain(PARENT);
    expect(raw).not.toContain('@');
  });

  test('a parent\'s view of their child: no child account id, addressed by athlete id', async () => {
    asViewer('parent', PARENT);

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/profile/card?athlete_id=ath-1'));
    const raw = await response.text();
    const card = JSON.parse(raw).card;

    expect(card.accountId).toBeNull();
    expect(card.portraitPath).toBe('/api/pilot/profile/card/photo?athlete_id=ath-1');
    expect(card.coachPortraitPath).toBe('/api/pilot/profile/card/coach-photo?athlete_id=ath-1&coach_name=Coach%20Ray');
    expect(raw).not.toContain(ATHLETE);
    expect(raw).not.toContain(PARENT);
    expect(raw).not.toContain('@');
  });

  test('an athlete\'s own card: no id', async () => {
    asViewer('athlete');

    const raw = await (await GET(new NextRequest('https://ppbf.example/api/pilot/profile/card?athlete_id=ath-1'))).text();

    expect(JSON.parse(raw).card.accountId).toBeNull();
    expect(JSON.parse(raw).card.portraitPath).toBe('/api/pilot/profile/card/photo');
    expect(raw).not.toContain(ATHLETE);
  });

  test.each(['coach', 'organization_admin', 'admin'] as const)('a %s viewer\'s card is unchanged, ids included', async (role) => {
    asViewer(role);

    const card = (await (await GET(new NextRequest('https://ppbf.example/api/pilot/profile/card?athlete_id=ath-1'))).json()).card;

    // Every field the card had before F-119, at the value it had; the two
    // portrait paths are the only additions.
    expect(card).toEqual({
      accountId: ATHLETE,
      displayName: 'Marisol Vance',
      initials: 'MV',
      ringName: null,
      corner: 'none',
      cornerLabel: expect.any(String),
      program: 'unstated',
      programLabel: expect.any(String),
      coachName: 'Ray Nolan',
      coachAccountId: COACH,
      coachPhotoAvailable: true,
      coachInitials: 'RN',
      timeAtGym: expect.any(String),
      // A minor's face reaches their own coach, not the whole staff (decidePortrait).
      photoAvailable: role === 'coach',
      portraitPath: '/api/pilot/profile/card/photo?athlete_id=ath-1',
      coachPortraitPath: '/api/pilot/profile/card/coach-photo?athlete_id=ath-1&coach_name=Ray%20Nolan',
    });
  });
});
