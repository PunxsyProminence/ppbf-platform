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

// The reads are faked and organization-scoped the way the real ones are;
// toProfileSubject and decidePortrait are the real ones, so "not released" is
// decided by the real rule.
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
const OTHER_ORG = 'org-b';
const ATHLETE = 'acct-athlete';
const PARENT = 'dana.vance@example.test';
const COACH = 'acct-coach-7f3a';
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);

const IDENTITIES: Record<string, unknown> = {
  [ATHLETE]: {
    accountId: ATHLETE, fullName: 'Marisol Vance', athleteId: 'ath-1', dob: '2013-04-02',
    coachAccountId: COACH, memberSince: '2026-01-01T00:00:00Z',
  },
  [PARENT]: {
    accountId: PARENT, fullName: 'Dana Vance', athleteId: null, dob: null,
    coachAccountId: null, memberSince: null,
  },
};

/** Who stands where, as the real resolveRelationship would answer it. */
const RELATIONSHIPS: Record<string, Record<string, string>> = {
  [ATHLETE]: { [ATHLETE]: 'self' },
  [PARENT]: { [ATHLETE]: 'guardian_of_subject', [PARENT]: 'self' },
  [COACH]: { [ATHLETE]: 'coach_of_subject' },
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

function as(role: string, accountId: string, athleteId: string | null = null, organizationId = ORG) {
  mockPrincipal.mockResolvedValue({ accountId, role, organizationId, athleteId } as never);
}

const request = (query = '') => new NextRequest(`https://ppbf.example/api/pilot/profile/card/photo${query}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockImplementation(async (org, accountId) =>
    (org === ORG ? IDENTITIES[accountId] ?? null : null) as never);
  mockProfile.mockImplementation(async (_org, accountId) => profileFor(accountId));
  mockReach.mockResolvedValue(undefined);
  mockRelationship.mockImplementation(async (viewer, subject) =>
    (RELATIONSHIPS[viewer.accountId]?.[subject.accountId] ?? 'none') as never);
  mockQueryOne.mockImplementation(async (_sql, params) => {
    const [org, athleteId] = params as unknown[];
    return (org === ORG && athleteId === 'ath-1' ? { account_id: ATHLETE } : null) as never;
  });
  mockDownload.mockResolvedValue(BYTES);
});

async function expectBytesOf(response: Response, accountId: string) {
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer()).equals(BYTES)).toBe(true);
  expect(mockDownload).toHaveBeenCalledWith(`profile/${accountId}.jpg`);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
  for (const [, value] of response.headers.entries()) {
    expect(value).not.toContain(accountId);
    expect(value).not.toContain('@');
  }
}

async function expectHidden(response: Response) {
  expect(response.status).toBe(404);
  expect(mockDownload).not.toHaveBeenCalled();
  const raw = JSON.stringify(await response.json());
  expect(raw).not.toContain(ATHLETE);
  expect(raw).not.toContain('@');
}

describe('GET /api/pilot/profile/card/photo: who is served', () => {
  test('a parent\'s own face, with no query and no id in the address', async () => {
    as('parent', PARENT);
    await expectBytesOf(await GET(request()), PARENT);
  });

  test('an athlete\'s own face, with no query', async () => {
    as('athlete', ATHLETE, 'ath-1');
    await expectBytesOf(await GET(request()), ATHLETE);
  });

  test('a linked parent gets their child\'s face by athlete id', async () => {
    as('parent', PARENT);
    await expectBytesOf(await GET(request('?athlete_id=ath-1')), ATHLETE);
    expect(mockReach.mock.calls[0][1]).toMatchObject({ accountId: ATHLETE });
  });

  test('the athlete\'s coach gets the face, as by id', async () => {
    as('coach', COACH);
    await expectBytesOf(await GET(request('?athlete_id=ath-1')), ATHLETE);
  });
});

/*
 * Each refusal is arranged so exactly ONE gate refuses and every other gate
 * would admit: the matching "served" case above differs from it only in that
 * gate's answer. Remove the gate and the bytes go out, so each test is proof
 * the gate is load-bearing (mutation proofs in the PR body).
 */
describe('GET /api/pilot/profile/card/photo: refusals, all the same 404', () => {
  test('a stranger: refused by the reach check alone', async () => {
    as('parent', 'acct-other-parent');
    // The relationship would admit (as for the linked parent); only the
    // child-account boundary refuses.
    mockRelationship.mockResolvedValue('guardian_of_subject' as never);
    mockReach.mockRejectedValue(new Error('Forbidden'));
    await expectHidden(await GET(request('?athlete_id=ath-1')));
    expect(mockReach).toHaveBeenCalledTimes(1);
  });

  test('an unlinked child: refused by the relationship', async () => {
    as('parent', 'acct-other-parent');
    // The reach check admits (its default here); the relationship is none.
    // Two layers refuse 'none' -- the route's own check and decidePortrait,
    // which never admits it -- so it is the relationship, not either layer
    // alone, that this pins (mutation M2 in the PR body).
    await expectHidden(await GET(request('?athlete_id=ath-1')));
    expect(mockReach).toHaveBeenCalledTimes(1);
    expect(mockRelationship).toHaveBeenCalledTimes(1);
  });

  test('a coach of another gym, by athlete id: the athlete is not found in their organization', async () => {
    as('coach', COACH, null, OTHER_ORG);
    // Reach and relationship would both admit; the org-scoped lookup refuses.
    mockRelationship.mockResolvedValue('coach_of_subject' as never);
    await expectHidden(await GET(request('?athlete_id=ath-1')));
    expect(mockQueryOne.mock.calls[0][1]).toEqual([OTHER_ORG, 'ath-1']);
  });

  test('a coach of another gym, by account id: no such account in their organization', async () => {
    as('coach', COACH, null, OTHER_ORG);
    mockRelationship.mockResolvedValue('coach_of_subject' as never);
    await expectHidden(await GET(request(`?account_id=${ATHLETE}`)));
    expect(mockIdentity).toHaveBeenCalledWith(OTHER_ORG, ATHLETE);
  });

  test('a portrait not released: refused by the portrait decision', async () => {
    as('parent', PARENT);
    mockProfile.mockImplementation(async (_org, accountId) => profileFor(accountId, { photoReviewState: 'pending_review' }));
    await expectHidden(await GET(request('?athlete_id=ath-1')));
  });

  test('no photograph: the plate', async () => {
    as('parent', PARENT);
    mockProfile.mockImplementation(async (_org, accountId) => profileFor(accountId, { photoBlobPath: null }));
    await expectHidden(await GET(request('?athlete_id=ath-1')));
  });

  test('an over-long handle is a 404 before any read', async () => {
    as('parent', PARENT);
    await expectHidden(await GET(request(`?account_id=${'x'.repeat(129)}`)));
    expect(mockIdentity).not.toHaveBeenCalled();
  });

  test('every read is scoped to the caller\'s organization', async () => {
    as('parent', PARENT);
    await GET(request('?athlete_id=ath-1'));
    for (const call of mockIdentity.mock.calls) expect(call[0]).toBe(ORG);
    for (const call of mockProfile.mock.calls) expect(call[0]).toBe(ORG);
  });
});
