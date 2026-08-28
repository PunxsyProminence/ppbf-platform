/**
 * ONE PROPERTY, ACROSS EVERY CONSENT READER ON THE GUARDIAN PATH:
 *
 *   A STATUS THIS PLATFORM DOES NOT RECOGNISE NEVER MEANS YES.
 *
 * WHY THIS FILE EXISTS. pilot.waivers.status is freeform text -- no CHECK
 * constraint on the column, and /api/pilot/intake/domain-upsert stores
 * `asString(body.payload.status, 'signed')`, which accepts any string a
 * caller sends. waiverCompliance.ts records a waiver stored as ' Signed ' as
 * something that ACTUALLY HAPPENED, in those words: "this is reachable rather
 * than theoretical".
 *
 * Every reader below already fails closed on such a value, and each does it
 * its own way -- one normalises then tests membership, two test `!== 'signed'`
 * on the raw string, one throws. Four separate implementations of one safety
 * property, with nothing holding them to it together.
 *
 * They were not four. GET /api/pilot/video/[videoId] was a fifth, and it
 * failed OPEN: its refusals were positive matches (`status === 'withdrawn'`,
 * `status === 'signed' && !coversVideo`), so ' Withdrawn ' matched neither,
 * both filters came back empty, and the route minted a 60-minute credential
 * for a minor's footage. It is fixed and has its own tests; this file is what
 * stops the next one being written.
 *
 * WHAT THIS DOES NOT DO. It takes no position on what the vocabulary SHOULD
 * be. wallDisplay.ts treats 'active', 'accepted', 'approved', 'complete',
 * 'completed' and 'current' as affirmative while waiverCompliance.ts
 * normalises all six to 'missing' -- a real disagreement between two modules
 * reading one column, and an owner decision, not this file's to settle. The
 * property asserted here is weaker and unarguable: whatever the vocabulary
 * turns out to be, a value OUTSIDE it must not read as consent.
 */

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('./guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
  guardianParentIds: jest.fn(),
  guardianParentIdForAthlete: jest.fn(),
}));

jest.mock('./intake', () => ({
  upsertWaiver: jest.fn(),
}));

import { query } from './db';
import {
  assertGuardianMediaConsent,
  assertGuardianMediaConsentWithClient,
  checkGuardianMediaConsent,
} from './guardianConsent';
import { getAthleteWaiverStatus } from './waiverCompliance';

const mockQuery = query as jest.Mock;

/**
 * Values a caller can actually put in the column, chosen to cover the three
 * ways a status goes wrong rather than to be exhaustive:
 *
 *   - CASE AND WHITESPACE on a word the platform does know. The measured
 *     one: waiverCompliance.ts documents ' Signed ' as an observed value.
 *   - A DIFFERENT WORD that means yes somewhere else. 'active' and
 *     'approved' are affirmative to wallDisplay.ts and unknown to
 *     waiverCompliance.ts -- so they are exactly the values where two readers
 *     of one column disagree, and the ones a future writer is most likely to
 *     produce by accident.
 *   - NOISE. Typos and empties, which domain-upsert accepts unchanged.
 */
const UNRECOGNISED_BY_THE_CONSENT_VOCABULARY = [
  ' Signed ',
  'SIGNED',
  'Signed',
  ' signed',
  'active',
  'approved',
  'accepted',
  'current',
  'pending',
  'revoked',
  'signd',
  'yes',
  '',
  '   ',
];

beforeEach(() => {
  jest.clearAllMocks();
});

/** A guardian link plus one current photo_media row carrying `status`. */
function arrangeOneGuardianWith(status: string): void {
  mockQuery
    .mockResolvedValueOnce([{ parent_id: 'par-1' }])
    .mockResolvedValueOnce([{
      parent_id: 'par-1',
      status,
      covers_video: true,
      public_use_allowed: true,
      created_at: '2026-01-01T00:00:00.000Z',
    }]);
}

describe('checkGuardianMediaConsent', () => {
  test.each(UNRECOGNISED_BY_THE_CONSENT_VOCABULARY)(
    'a status of %p is not consent',
    async (status) => {
      arrangeOneGuardianWith(status);

      const result = await checkGuardianMediaConsent('org-1', 'ath-1');

      expect(result.ok).toBe(false);
      expect(result.missingParentIds).toEqual(['par-1']);
    },
  );

  test('the exact stored word IS consent, so the assertions above are not vacuous', async () => {
    // Without this, a bug that made every status fail would pass every test
    // in this file. 'signed' is what grantMediaConsent actually writes.
    arrangeOneGuardianWith('signed');

    const result = await checkGuardianMediaConsent('org-1', 'ath-1');

    expect(result.ok).toBe(true);
    expect(result.missingParentIds).toEqual([]);
  });
});

describe('assertGuardianMediaConsent', () => {
  test.each(UNRECOGNISED_BY_THE_CONSENT_VOCABULARY)('a status of %p refuses', async (status) => {
    arrangeOneGuardianWith(status);

    await expect(assertGuardianMediaConsent('org-1', 'ath-1')).rejects.toThrow(
      /guardian media consent is missing or withdrawn/,
    );
  });

  test('the exact stored word does not refuse', async () => {
    arrangeOneGuardianWith('signed');

    await expect(assertGuardianMediaConsent('org-1', 'ath-1')).resolves.toBeUndefined();
  });
});

describe('assertGuardianMediaConsentWithClient', () => {
  // The transactional variant -- a different implementation of the same rule,
  // on the same rows, reached from decidePublicationCompliance. Two copies of
  // a check are how one of them later stops matching the other, which is the
  // whole reason this suite tests both rather than one.
  const fakeClient = (status: string) => ({
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ parent_id: 'par-1' }] })
      .mockResolvedValueOnce({
        rows: [{
          parent_id: 'par-1',
          status,
          covers_video: true,
          public_use_allowed: true,
          created_at: '2026-01-01T00:00:00.000Z',
        }],
      }),
  });

  test.each(UNRECOGNISED_BY_THE_CONSENT_VOCABULARY)('a status of %p refuses', async (status) => {
    await expect(
      assertGuardianMediaConsentWithClient(fakeClient(status), 'org-1', 'ath-1'),
    ).rejects.toThrow(/guardian media consent is missing or withdrawn/);
  });

  test('the exact stored word does not refuse', async () => {
    await expect(
      assertGuardianMediaConsentWithClient(fakeClient('signed'), 'org-1', 'ath-1'),
    ).resolves.toBeUndefined();
  });
});

describe('getAthleteWaiverStatus', () => {
  /* This one normalises rather than comparing raw, so ' Signed ' comes back
     'signed' here while checkGuardianMediaConsent above reads the same value
     as not-consent. That divergence is real and is recorded as an open item,
     not asserted away: the property this file holds is only that nothing
     OUTSIDE the vocabulary reads as signed. */
  const OUTSIDE_ANY_VOCABULARY = ['active', 'approved', 'accepted', 'current', 'pending', 'revoked', 'signd', 'yes', '', '   '];

  test.each(OUTSIDE_ANY_VOCABULARY)('a status of %p does not read as signed', async (status) => {
    mockQuery.mockResolvedValueOnce([{ status }]);

    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('missing');
  });

  test('a missing row reads as missing, not as an error', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('missing');
  });

  test('a real signature still reads as signed', async () => {
    mockQuery.mockResolvedValueOnce([{ status: 'signed' }]);

    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('signed');
  });
});

describe('the guard itself', () => {
  test('the value table is not empty and carries all three kinds', () => {
    // A table-driven guard over an empty list passes without running.
    expect(UNRECOGNISED_BY_THE_CONSENT_VOCABULARY.length).toBeGreaterThan(0);
    // case/whitespace on a known word
    expect(UNRECOGNISED_BY_THE_CONSENT_VOCABULARY).toContain(' Signed ');
    // a word that means yes to another reader of this same column
    expect(UNRECOGNISED_BY_THE_CONSENT_VOCABULARY).toContain('active');
    // noise
    expect(UNRECOGNISED_BY_THE_CONSENT_VOCABULARY).toContain('');
  });
});
