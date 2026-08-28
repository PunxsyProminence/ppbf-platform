import { NextRequest } from 'next/server';

import { GET } from './route';
import { queryOne } from '@/src/server/pilot/db';
import { checkGuardianMediaConsent, type ConsentCheckResult } from '@/src/server/pilot/guardianConsent';
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

jest.mock('@/src/server/pilot/blob', () => ({
  getPilotVideoSasUrl: jest.fn(() => 'https://blob.example/sas'),
}));

// Only checkGuardianMediaConsent is replaced; the rest of the module (and so
// GuardianConsentMissingError's identity, which http.ts branches on) stays
// real. Same shape the other consent-gated routes use -- publications/publish,
// admin/video-compliance, shadow/video-analysis.
jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return { ...actual, checkGuardianMediaConsent: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockCheckConsent = jest.mocked(checkGuardianMediaConsent);

/**
 * The default every existing test in this file runs under, and it is
 * deliberately the WORST-CASE REAL ONE: no guardian links and no consent rows.
 *
 * That is not a convenience default, it is the measured default state of a
 * roster-imported athlete. scripts/seed-data.ts writes no waiver row; both
 * intake writers call upsertWaiver without parentId, so their rows have
 * parent_id NULL and currentConsentByGuardian cannot see them. The only writer
 * of a visible row is the guardian's own console. So if this route ever starts
 * refusing on ABSENT consent, every unchanged test below turns red -- which is
 * exactly the alarm that belongs on that change.
 */
const NO_CONSENT_ON_FILE: ConsentCheckResult = {
  ok: false,
  guardianIds: [],
  missingParentIds: [],
  perGuardian: [],
};

const consentResult = (perGuardian: ConsentCheckResult['perGuardian']): ConsentCheckResult => ({
  ok: perGuardian.every((guardian) => guardian.status === 'signed'),
  guardianIds: perGuardian.map((guardian) => guardian.parentId),
  missingParentIds: perGuardian.filter((g) => g.status !== 'signed').map((g) => g.parentId),
  perGuardian,
});

const guardian = (
  parentId: string,
  status: string | null,
  coversVideo: boolean | null,
): ConsentCheckResult['perGuardian'][number] => ({
  parentId,
  status,
  coversVideo,
  publicUseAllowed: false,
  signedAt: status ? '2026-01-01T00:00:00.000Z' : null,
});

beforeEach(() => {
  mockCheckConsent.mockResolvedValue(NO_CONSENT_ON_FILE);
});

afterEach(() => {
  jest.clearAllMocks();
  // clearAllMocks resets recorded calls but NOT queued mock*ValueOnce values,
  // so a test that queues a value its route never reaches (deliberately -- see
  // the access-gate ordering test) would hand that value to the NEXT test.
  // These three are the queue-bearing mocks; reset drains them, and the
  // beforeEach above restores the one default that has to survive.
  mockRequirePrincipal.mockReset();
  mockQueryOne.mockReset();
  mockCheckConsent.mockReset();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

const videoRow = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  organization_id: 'org-1',
  title: 't',
  notes: '',
  file_name: 'f.mp4',
  file_size_bytes: 100,
  mime_type: 'video/mp4',
  status: 'ready',
  athlete_id: 'ath-1',
  blob_path: 'org-1/vid-1/f.mp4',
  uploaded_by_account_id: 'coach-1',
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function call(videoId = 'vid-1') {
  const request = new NextRequest(`http://localhost/api/pilot/video/${videoId}`);
  return GET(request, { params: Promise.resolve({ videoId }) });
}

describe('GET /api/pilot/video/[videoId]', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await call();
    expect(res.status).toBe(401);
  });

  test('nonexistent video returns hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await call('does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test.each(['uploaded', 'processing', 'quarantined', 'infected', 'error', 'archived'])(
    'non-ready %s video never receives a playback URL',
    async (status) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQueryOne.mockResolvedValueOnce(videoRow({ status }));
      const res = await call();
      expect(res.status).toBe(404);
      const { getPilotVideoSasUrl } = jest.requireMock('@/src/server/pilot/blob');
      expect(getPilotVideoSasUrl).not.toHaveBeenCalled();
    },
  );

  test('cross-organization video id returns the same hidden not-found response as a nonexistent id', async () => {
    // The row fetch is itself organization-scoped, so a video belonging to
    // another org comes back as null from the DB layer -- identical to a
    // truly nonexistent id.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin', organizationId: 'org-2' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await call('vid-1');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('athlete can access their own video', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('athlete accessing another athlete video gets the same hidden not-found response (no 403 oracle)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-2' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: 'ath-1' }));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('parent linked to the video athlete succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('parent not linked gets hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('assigned coach succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('unassigned coach gets hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('volunteer is denied even though the video exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'volunteer' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('staff is denied even though the video exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'staff' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('organization_admin can access any video in the org', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }); // assertAthleteBelongsToOrganization
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('unattributed video: coach can view it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: null }));
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('unattributed video: athlete cannot view it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: null }));
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('the response carrying the playback SAS url is not storable by any cache', async () => {
    // stream_url is a bearer credential: it plays a minor's footage for its
    // whole validity window with no session behind it. A copy retained by the
    // browser or by an intermediary outlives the access check above.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).stream_url).toBe('https://blob.example/sas');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });
});

/**
 * The consent-scope gate. See the route's own assertConsentCoversVideo header
 * for the reasoning; these pin the two halves of it that matter most -- that a
 * photo-only consent stops the bearer URL, and that a MISSING consent row never
 * does.
 */
describe('GET /api/pilot/video/[videoId] guardian consent scope', () => {
  test('a guardian who signed a photo-only consent stops the playback URL being minted', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'signed', false)]));

    const res = await call();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    expect(body.error).toMatch(/photo-only media consent/);
    // The point of the refusal: no bearer credential in the response at all.
    expect(body.stream_url).toBeUndefined();
  });

  test('one photo-only guardian is enough, even when the other guardian consented to video', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([
      guardian('par-1', 'signed', true),
      guardian('par-2', 'signed', false),
    ]));

    const res = await call();

    expect(res.status).toBe(409);
  });

  test('a guardian who consented to video is served normally', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'signed', true)]));

    const res = await call();

    expect(res.status).toBe(200);
    expect((await res.json()).stream_url).toBe('https://blob.example/sas');
  });

  test('NO consent row on file still plays -- absence must never refuse a read', async () => {
    // The blast-radius guard. The only writer of a gate-visible consent row is
    // the guardian's own console, so "no row" is the default state of every
    // roster-imported athlete. A gate that refused here would have taken every
    // coach's footage away on the day it shipped.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(NO_CONSENT_ON_FILE);

    const res = await call();

    expect(res.status).toBe(200);
  });

  test('a guardian link with no waiver row at all still plays', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', null, null)]));

    const res = await call();

    expect(res.status).toBe(200);
  });

  test('a WITHDRAWN consent refuses playback', async () => {
    // The test the previous version of this file named as "the one to change
    // if that decision is made". It was made (owner, 2026-08-28): withdrawal
    // stops internal playback, not only publication. The assertion is
    // inverted here rather than the test being deleted, so the change of
    // direction is visible in the diff instead of looking like a lost case.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'withdrawn', false)]));

    const res = await call();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    expect(body.error).toMatch(/withdrawn media consent/);
    // Same point as the photo-only refusal: no bearer credential in a refusal.
    expect(body.stream_url).toBeUndefined();
  });

  test('one withdrawn guardian is enough, even when the other guardian still consents', async () => {
    // Fail-closed across guardians, matching the photo-only rule directly
    // above it. A second guardian's standing consent does not override the
    // first one's withdrawal -- neither guardian speaks for the other.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([
      guardian('par-1', 'signed', true),
      guardian('par-2', 'withdrawn', false),
    ]));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
  });

  test('a withdrawal and a photo-only consent together report the WITHDRAWAL', async () => {
    // Both refusals are 409, so a status-only assertion would pass whichever
    // branch fired and the ordering in the route would be untested. The code
    // is what an admin reading the message acts on, and telling a guardian who
    // already said no to "consent to video" is the wrong instruction, so the
    // stronger statement has to be the one that surfaces.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([
      guardian('par-1', 'signed', false),
      guardian('par-2', 'withdrawn', false),
    ]));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
  });

  test('the athlete themself is refused while a withdrawal stands', async () => {
    // Deliberate, and the same reach the photo-only refusal has always had: a
    // withdrawal that stopped coaches but left the athlete's own console
    // playing would leave the footage one login away from the household whose
    // guardian just said no.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'withdrawn', false)]));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
  });

  test('the linked guardian is refused while a withdrawal stands', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'withdrawn', false)]));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
  });

  test('a withdrawal followed by a fresh signed consent plays again', async () => {
    // The escape hatch, asserted rather than assumed. pilot.waivers is
    // append-only and currentConsentByGuardian takes the latest row per
    // guardian, so a new grant supersedes the withdrawal with no
    // administrative step -- this route only ever sees the current row.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'signed', true)]));

    const res = await call();

    expect(res.status).toBe(200);
  });

  test('the withdrawal refusal runs only AFTER the access gate too', async () => {
    // The 403-vs-404 discipline is per-refusal, not per-route: a new refusal
    // placed before the access gate would be a fresh oracle even though the
    // old one is still correctly ordered.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce(null); // not assigned
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'withdrawn', false)]));

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockCheckConsent).not.toHaveBeenCalled();
  });

  test("an unattributed team video is not refused by anyone's withdrawal", async () => {
    // There is no athlete_id, so there is no guardian to ask and no
    // withdrawal that could attach. Guards against a future refactor that
    // moves the consent read above the athlete_id branch.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: null }));
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'withdrawn', false)]));

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockCheckConsent).not.toHaveBeenCalled();
  });

  test('unattributed team video never consults consent -- there is no guardian to ask', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: null }));

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockCheckConsent).not.toHaveBeenCalled();
  });

  test('the consent check runs only AFTER the access gate, so it is no 403-vs-404 oracle', async () => {
    // An unassigned coach must not be able to tell a photo-only consent from a
    // video they simply may not see. Both are the same hiddenNotFound().
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce(null); // not assigned
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'signed', false)]));

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockCheckConsent).not.toHaveBeenCalled();
  });

  test('a consent lookup fault refuses rather than serving -- it does not degrade to "proceed"', async () => {
    // waiverCompliance.ts's rule, applied here: a consent read that cannot
    // complete must never mean "we could not find out, so go ahead".
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

    const res = await call();

    expect(res.status).toBe(500);
    expect((await res.json()).stream_url).toBeUndefined();
  });

  test('the athlete themself is subject to the same scope refusal', async () => {
    // The athlete branch of assertActorCanAccessAthlete is pure -- no queryOne
    // call -- so only the video row is queued here.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'signed', false)]));

    const res = await call();

    expect(res.status).toBe(409);
  });

  test('the linked guardian is subject to the same scope refusal', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', 'signed', false)]));

    const res = await call();

    expect(res.status).toBe(409);
  });
});

/**
 * pilot.waivers.status IS FREEFORM TEXT.
 *
 * No CHECK constraint on the column, and /api/pilot/intake/domain-upsert
 * stores `asString(body.payload.status, 'signed')` -- any string a caller
 * sends. waiverCompliance.ts records a waiver stored as ' Signed ' as
 * something that actually happened and says so in as many words: "this is
 * reachable rather than theoretical".
 *
 * The two refusals in this route were positive matches on the raw string, so
 * ' Withdrawn ' matched neither, both filters came back empty, and the SAS was
 * minted. A safeguarding gate failing OPEN on a leading space -- sitting
 * beside checkGuardianMediaConsent's own `status !== 'signed'`, which fails
 * closed on the same data.
 */
describe('a status this gate cannot read never means yes', () => {
  const play = async (status: string | null, coversVideo: boolean | null = false) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([guardian('par-1', status, coversVideo)]));
    return call();
  };

  test.each([' withdrawn', 'withdrawn ', ' Withdrawn ', 'WITHDRAWN', 'Withdrawn'])(
    'a withdrawal recorded as %p still refuses',
    async (status) => {
      const res = await play(status);

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    },
  );

  test.each([' signed ', 'SIGNED', 'Signed'])(
    'a photo-only consent recorded as %p still refuses video',
    async (status) => {
      const res = await play(status, false);

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    },
  );

  test.each([' Signed ', 'SIGNED'])('a video consent recorded as %p still plays', async (status) => {
    // The other direction, and the one that keeps normalisation from being a
    // one-way ratchet: a family must not be punished for a data-entry
    // artifact either. Same argument waiverCompliance.ts makes for its gate.
    const res = await play(status, true);

    expect(res.status).toBe(200);
  });

  test.each(['active', 'revoked', 'pending', 'declined', 'approved', 'yes', 'signd'])(
    'a status of %p is refused rather than guessed at',
    async (status) => {
      /* wallDisplay.ts draws this line on the same column, as an allow-list
         and not a deny-list -- "an unrecognised status is a refusal" -- for
         the same reason: you cannot conclude a guardian consented to video
         from a word you do not understand.

         'declined' and 'approved' are in the list on purpose. Both are real
         vocabulary elsewhere in this codebase (admin/consent offers
         'declined'; wallDisplay treats 'approved' as affirmative) and NEITHER
         has a defined meaning for THIS gate, so both are refused rather than
         mapped onto one this file invented. */
      const res = await play(status, true);

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('GUARDIAN_CONSENT_UNREADABLE');
      expect(body.stream_url).toBeUndefined();
    },
  );

  test('an empty-string status is refused, not read as absence', async () => {
    // '' normalises to '' which is in neither set. Absence is `null` -- no row
    // at all -- and that is a different fact with a different answer.
    const res = await play('', true);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GUARDIAN_CONSENT_UNREADABLE');
  });

  test('a guardian with NO row is still not refused -- absence is untouched', async () => {
    // The blast-radius decision this route was built around, re-asserted
    // beside the new refusal so the two cannot be confused. `null` status
    // means no current photo_media row for that guardian, which is the
    // default state of a roster-imported athlete.
    const res = await play(null, null);

    expect(res.status).toBe(200);
  });

  test('the unreadable refusal is reported only when nothing stronger applies', async () => {
    // Ordering: a real withdrawal beside an unreadable row must still report
    // the withdrawal, which is the actionable fact.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockCheckConsent.mockResolvedValueOnce(consentResult([
      guardian('par-1', 'withdrawn', false),
      guardian('par-2', 'active', true),
    ]));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
  });
});
