import { NextRequest } from 'next/server';

import { GET } from './route';
import { downloadPilotProfilePhoto } from '@/src/server/pilot/blob';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  assertViewerMayReachSubject,
  getAccountProfile,
  getSubjectIdentity,
  resolveRelationship,
} from '@/src/server/pilot/profileDb';

// The reads are faked; toProfileSubject and decidePortrait are the real ones,
// so "the coach's portrait is not released" is decided by the real rule.
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
jest.mock('@/src/server/pilot/blob', () => ({ downloadPilotProfilePhoto: jest.fn() }));
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
const mockDownload = jest.mocked(downloadPilotProfilePhoto);

const ORG = 'org-a';
const COACH = 'acct-coach-7f3a';
const ATHLETE = 'acct-athlete';
const PARENT = 'acct-parent';
const COACH_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x43]);

const IDENTITIES: Record<string, unknown> = {
  [ATHLETE]: {
    accountId: ATHLETE, fullName: 'Marisol Vance', athleteId: 'ath-1', dob: '2013-04-02',
    coachAccountId: COACH, memberSince: '2026-01-01T00:00:00Z',
  },
  'acct-no-coach': {
    accountId: 'acct-no-coach', fullName: 'Devon Pike', athleteId: 'ath-2', dob: '2012-01-01',
    coachAccountId: null, memberSince: '2026-01-01T00:00:00Z',
  },
  [COACH]: {
    accountId: COACH, fullName: 'Ray Nolan', athleteId: null, dob: null,
    coachAccountId: null, memberSince: '2025-01-01T00:00:00Z',
  },
};

function profileFor(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG, accountId, nickname: null, nicknameClearedAt: null,
    corner: 'none', program: 'unstated',
    photoBlobPath: `profile/${accountId}.jpg`, photoContentType: 'image/jpeg',
    photoReviewState: 'released', photoUploadedAt: '2026-08-10 09:00:00+00',
    ...overrides,
  } as never;
}

/** Who stands where, as the real resolveRelationship would answer it. */
const RELATIONSHIPS: Record<string, Record<string, string>> = {
  [ATHLETE]: { [ATHLETE]: 'self', [COACH]: 'subject_is_my_staff' },
  [PARENT]: { [ATHLETE]: 'guardian_of_subject', [COACH]: 'subject_is_my_staff', 'acct-no-coach': 'guardian_of_subject' },
  [COACH]: { [ATHLETE]: 'coach_of_subject', [COACH]: 'self' },
  'acct-other-parent': { [ATHLETE]: 'none', [COACH]: 'none' },
};

function principal(role: string, accountId: string, athleteId: string | null = null) {
  return { accountId, role, organizationId: ORG, athleteId } as never;
}

function request(query = ''): NextRequest {
  return new NextRequest(`https://ppbf.example/api/pilot/profile/card/coach-photo${query}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockImplementation(async (_org, accountId) => (IDENTITIES[accountId] ?? null) as never);
  mockProfile.mockImplementation(async (_org, accountId) => profileFor(accountId));
  mockReach.mockResolvedValue(undefined);
  mockRelationship.mockImplementation(async (viewer, subject) =>
    (RELATIONSHIPS[viewer.accountId]?.[subject.accountId] ?? 'none') as never);
  mockQueryOne.mockImplementation(async (_sql, params) =>
    ((params as unknown[])[1] === 'ath-1' ? { account_id: ATHLETE } : null) as never);
  mockDownload.mockResolvedValue(COACH_BYTES);
});

async function expectCoachBytes(response: Response) {
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer()).equals(COACH_BYTES)).toBe(true);
  expect(mockDownload).toHaveBeenCalledWith(`profile/${COACH}.jpg`);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
  // Nothing in the response names the coach.
  for (const [, value] of response.headers.entries()) expect(value).not.toContain(COACH);
}

async function expectHidden(response: Response) {
  expect(response.status).toBe(404);
  expect(mockDownload).not.toHaveBeenCalled();
  expect(JSON.stringify(await response.json())).not.toContain(COACH);
}

describe('GET /api/pilot/profile/card/coach-photo', () => {
  test('an athlete gets their own coach\'s face from their own card, without naming the coach', async () => {
    mockPrincipal.mockResolvedValue(principal('athlete', ATHLETE, 'ath-1'));
    await expectCoachBytes(await GET(request()));
  });

  test('the same, addressed by the card\'s account id', async () => {
    mockPrincipal.mockResolvedValue(principal('athlete', ATHLETE, 'ath-1'));
    await expectCoachBytes(await GET(request(`?account_id=${ATHLETE}`)));
  });

  test('a linked parent gets their child\'s coach\'s face through the child\'s card', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', PARENT));
    await expectCoachBytes(await GET(request('?athlete_id=ath-1')));
    // The card's subject was gated before the coach was even looked up.
    expect(mockReach.mock.calls[0][1]).toMatchObject({ accountId: ATHLETE });
  });

  test('the coach in the corner sees their own face on their athlete\'s card', async () => {
    mockPrincipal.mockResolvedValue(principal('coach', COACH));
    await expectCoachBytes(await GET(request('?athlete_id=ath-1')));
  });

  test('a parent who cannot reach the child is refused before the coach is looked up', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', 'acct-other-parent'));
    mockReach.mockRejectedValueOnce(new Error('Forbidden'));
    await expectHidden(await GET(request('?athlete_id=ath-1')));
    expect(mockIdentity).not.toHaveBeenCalledWith(ORG, COACH);
  });

  test('a viewer with no relationship to the card is refused before the coach is looked up', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', 'acct-other-parent'));
    await expectHidden(await GET(request('?athlete_id=ath-1')));
    expect(mockIdentity).not.toHaveBeenCalledWith(ORG, COACH);
  });

  test('the viewer\'s standing toward the COACH is decided separately: none means the plate', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', PARENT));
    mockRelationship.mockImplementation(async (_viewer, subject) =>
      (subject.accountId === ATHLETE ? 'guardian_of_subject' : 'none') as never);
    await expectHidden(await GET(request('?athlete_id=ath-1')));
  });

  test('a coach portrait that is not released is not served', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', PARENT));
    mockProfile.mockImplementation(async (_org, accountId) =>
      profileFor(accountId, accountId === COACH ? { photoReviewState: 'pending_review' } : {}));
    await expectHidden(await GET(request('?athlete_id=ath-1')));
  });

  test('a coach with no photograph is not served', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', PARENT));
    mockProfile.mockImplementation(async (_org, accountId) =>
      profileFor(accountId, accountId === COACH ? { photoBlobPath: null } : {}));
    await expectHidden(await GET(request('?athlete_id=ath-1')));
  });

  test('a card with no coach of record has no coach face', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', PARENT));
    await expectHidden(await GET(request('?account_id=acct-no-coach')));
  });

  test('an athlete id with no account in this organization is a 404', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', PARENT));
    await expectHidden(await GET(request('?athlete_id=ath-elsewhere')));
    expect(mockQueryOne.mock.calls[0][1]).toEqual([ORG, 'ath-elsewhere']);
  });

  test('every read is scoped to the caller\'s organization', async () => {
    mockPrincipal.mockResolvedValue(principal('parent', PARENT));
    await GET(request('?athlete_id=ath-1'));
    for (const call of mockIdentity.mock.calls) expect(call[0]).toBe(ORG);
    for (const call of mockProfile.mock.calls) expect(call[0]).toBe(ORG);
  });
});
