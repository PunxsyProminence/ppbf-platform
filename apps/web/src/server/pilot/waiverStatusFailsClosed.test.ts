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

import fs from 'node:fs';
import path from 'node:path';

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

/**
 * DISCOVERY, BECAUSE A HARD-CODED FOUR DOES NOT STOP A FIFTH.
 *
 * Review finding (Codex, P2) on this file: the suite above imports four known
 * readers, so a NEW module comparing pilot.waivers.status directly would treat
 * an unknown value as consent while all of the tests above stayed green -- the
 * exact recurrence the header claimed to prevent. That criticism is correct,
 * and it is correct in the sharpest possible way: the fifth reader ALREADY
 * HAPPENED. GET /api/pilot/video/[videoId] is it, and nothing in the imports
 * above would have found it.
 *
 * So this half does not import anything. It walks the source, finds every
 * comparison against a media-consent status literal, and requires each file
 * that makes one to be registered here with a reason. A new one is a red test
 * naming the file.
 *
 * WHY THE MATCH IS LOOSE (a line mentioning `status` that compares against
 * 'signed' or 'withdrawn') rather than a tight expression: it has to keep
 * matching when a site is refactored. `guardian.status === 'signed'` and
 * `normalizeStatus(guardian.status) === 'signed'` are the same reader and the
 * same hazard, and a pattern that lost the second one the moment somebody
 * fixed it would be a guard that rewards the fix by looking away.
 *
 * WHY THERE IS NO STALE-ENTRY CHECK, deliberately, and against this
 * repository's own convention. routeGateDeclaration.convention.test.ts fails
 * when an allowlist entry stops being needed, on the sound argument that an
 * exemption nobody needs is an exemption nobody reviews. That check is what
 * made main red today: #817 closed a gap and left the entry behind, and every
 * open PR failed on it. The sites registered below sit in files that several
 * open PRs are actively adding to and removing from, so the same check here
 * would turn every merge ORDER into a landmine. Registering a file that does
 * not currently match is therefore harmless by design, and one entry below is
 * exactly that, marked as such. The half that carries the value -- an
 * unregistered reader is a failure -- is kept.
 */
describe('every direct reader of a consent status is registered', () => {
  const APP_WEB = path.resolve(__dirname, '../../..');
  const ROOTS = ['src', 'app'].map((dir) => path.join(APP_WEB, dir));

  /** A line that mentions a status and compares it to a consent literal. */
  const COMPARES_TO_A_CONSENT_LITERAL = /(===|!==)\s*'(signed|withdrawn)'/;
  const MENTIONS_STATUS = /status/i;

  /**
   * Every file that compares directly against a consent status literal, and
   * what that comparison is. A reason is required; "see above" is not one.
   *
   * The last two entries are NOT waiver readers. They are registered anyway,
   * and that is the point of registering by discovery rather than by
   * intention: both carry their own `status` vocabulary that happens to
   * include the word 'withdrawn', and the next person grepping for consent
   * readers will land on them. Saying "not this vocabulary" here is cheaper
   * than them being rediscovered and re-argued every time.
   */
  const REGISTERED: ReadonlyArray<readonly [string, string]> = [
    [
      'src/server/pilot/guardianConsent.ts',
      'THE consent reader. Two sites -- checkGuardianMediaConsent and the '
        + 'transactional assertGuardianMediaConsentWithClient -- both testing '
        + "`!== 'signed'` on the raw column value, so anything unrecognised "
        + 'counts as not-consent. Fails closed. Exercised by the suite above.',
    ],
    [
      'src/server/pilot/competitionSafetyGates.ts',
      "The travel gate. Tests `!== 'signed'` on a value getAthleteWaiverStatus "
        + 'has already normalised, and words its refusal from the status, so '
        + "'declined' and 'withdrawn' read as a decision on file rather than as "
        + 'missing paperwork. Fails closed.',
    ],
    [
      'app/api/pilot/video/[videoId]/route.ts',
      'THE ONE THAT FAILED OPEN, and the reason this file exists. Its refusals '
        + 'are positive matches, so a value outside the vocabulary matched '
        + 'neither and the route minted a 60-minute credential for a minor. It '
        + 'normalises now and refuses an unreadable status outright; registered '
        + 'so the next change to it is seen.',
    ],
    [
      'app/admin/waiver-status/page.tsx',
      'Admin worklist rendering. Reads server-normalised values and renders '
        + "anything it does not recognise as 'Missing', which is the honest "
        + 'reading for a worklist whose job is to surface absent waivers. '
        + 'Display only, no gate.',
    ],
    [
      'app/parent/consent/page.tsx',
      "The guardian's own console. Renders whether THIS guardian has signed; "
        + 'the authorization behind it is the route, not this comparison. '
        + 'Display only, no gate.',
    ],
    [
      'src/server/pilot/onePercentClub.ts',
      'NOT A WAIVER STATUS. Nomination statuses are open/confirmed/withdrawn/'
        + "expired -- a separate vocabulary that shares the word 'withdrawn' "
        + 'with consent and means something else entirely. Registered so it is '
        + 'not mistaken for a consent reader by the next person who greps.',
    ],
    [
      'app/api/pilot/operations/external-competition/entries/route.ts',
      'NOT A WAIVER STATUS. A competition entry status, same shared word, '
        + 'different vocabulary. Registered for the same reason as the '
        + 'nomination statuses above.',
    ],
    [
      'src/server/pilot/staffProvisioning.ts',
      'removeGuardianLink refuses an unlink while that guardian\'s media '
        + 'consent stands withdrawn. Arrives with the unlink-withdrawal change '
        + 'and may not match on every branch -- registered ahead of it, which '
        + 'is safe precisely because there is no stale-entry check here.',
    ],
  ];

  function sourceFilesUnder(root: string): string[] {
    if (!fs.existsSync(root)) return [];
    const found: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        found.push(...sourceFilesUnder(full));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
    return found;
  }

  function filesComparingAgainstAConsentLiteral(): string[] {
    const hits = new Set<string>();
    for (const root of ROOTS) {
      for (const file of sourceFilesUnder(root)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        if (lines.some((line) => COMPARES_TO_A_CONSENT_LITERAL.test(line) && MENTIONS_STATUS.test(line))) {
          hits.add(path.relative(APP_WEB, file));
        }
      }
    }
    return [...hits].sort();
  }

  test('the walk finds something, so an empty result cannot pass this suite', () => {
    // The failure mode of every source-walking guard: a path that resolves to
    // nothing, a regex that matches nothing, and a green test that looked at
    // no files at all.
    expect(sourceFilesUnder(ROOTS[0]).length).toBeGreaterThan(100);
    expect(filesComparingAgainstAConsentLiteral().length).toBeGreaterThan(0);
  });

  test('it finds the reader that failed open, which the imports above could not', () => {
    // The specific claim the review made and this half answers.
    expect(filesComparingAgainstAConsentLiteral()).toContain('app/api/pilot/video/[videoId]/route.ts');
  });

  test('no file compares against a consent status without being registered', () => {
    const registered = new Set(REGISTERED.map(([file]) => file));
    const unregistered = filesComparingAgainstAConsentLiteral().filter((file) => !registered.has(file));

    if (unregistered.length > 0) {
      throw new Error(
        'These files compare directly against a media-consent status literal and are not '
        + 'registered in waiverStatusFailsClosed.test.ts. Add each one with a reason saying '
        + 'which direction it fails when the value is not recognised -- and if it fails OPEN, '
        + 'fix it rather than registering it:\n  '
        + unregistered.join('\n  '),
      );
    }
    expect(unregistered).toEqual([]);
  });

  test('every registration carries a substantive reason', () => {
    // A registry of empty strings is a registry nobody read.
    for (const [file, reason] of REGISTERED) {
      expect(typeof reason).toBe('string');
      expect(reason.trim().length).toBeGreaterThan(60);
      expect(file.endsWith('.ts') || file.endsWith('.tsx')).toBe(true);
    }
  });

  test('the modules the suite above exercises are all registered', () => {
    // Ties the two halves together: the imported half and the discovered half
    // must not drift into disagreeing about which readers exist.
    const registered = new Set(REGISTERED.map(([file]) => file));
    expect(registered.has('src/server/pilot/guardianConsent.ts')).toBe(true);
    expect(registered.has('src/server/pilot/competitionSafetyGates.ts')).toBe(true);
  });
});
