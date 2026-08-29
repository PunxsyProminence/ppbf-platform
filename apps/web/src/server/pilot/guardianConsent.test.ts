/* withTransaction is listed because a bare-object jest.mock silently drops
   whatever it does not name: without it the consent writers' import is
   undefined and every test touching them dies in a TypeError rather than
   testing anything. It runs the callback against a recording client so the
   lock the writers now take is observable. */
const mockTxClient = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('./guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
  guardianParentIds: jest.fn(),
  guardianParentIdForAthlete: jest.fn(),
}));

jest.mock('./intake', () => ({
  upsertWaiver: jest.fn(),
  upsertWaiverWithClient: jest.fn(),
}));

import { query, withTransaction } from './db';
import { guardianAthleteIds, guardianParentIdForAthlete, guardianParentIds } from './guardianAccess';
import { upsertWaiver, upsertWaiverWithClient } from './intake';
import {
  assertGuardianMediaConsent,
  assertGuardianMediaConsentWithClient,
  callerParentIdSet,
  checkGuardianMediaConsent,
  GuardianConsentMissingError,
  grantMediaConsent,
  listConsentForGuardian,
  listOrganizationConsentStatus,
  resolveActingParent,
  withdrawMediaConsent,
} from './guardianConsent';

const mockQuery = jest.mocked(query);
const mockGuardianAthleteIds = jest.mocked(guardianAthleteIds);
const mockGuardianParentIds = jest.mocked(guardianParentIds);
const mockGuardianParentIdForAthlete = jest.mocked(guardianParentIdForAthlete);
const mockUpsertWaiver = jest.mocked(upsertWaiver);
const mockUpsertWaiverWithClient = jest.mocked(upsertWaiverWithClient);
const mockWithTransaction = jest.mocked(withTransaction);

beforeEach(() => {
  jest.clearAllMocks();
  mockTxClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  // Runs the real callback against the recording client, so the writers'
  // lock-then-insert sequence actually executes rather than being stubbed out.
  mockWithTransaction.mockImplementation(((fn: (c: unknown) => unknown) => fn(mockTxClient)) as never);
});

/** The `for update` statement a consent writer issues, if it issued one. */
function lockCalls() {
  return mockTxClient.query.mock.calls.filter(([sql]) => String(sql).includes('for update'));
}

describe('checkGuardianMediaConsent', () => {
  test('an athlete with no guardians on file is missing consent, not vacuously ok', async () => {
    mockQuery.mockResolvedValueOnce([]); // guardian_links lookup

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result).toEqual({ ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] });
    // The current-consent query must never run when there are no guardians.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('ok when every linked guardian has a current signed row', async () => {
    mockQuery
      .mockResolvedValueOnce([{ parent_id: 'p1' }, { parent_id: 'p2' }]) // guardian_links
      .mockResolvedValueOnce([
        { parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' },
        { parent_id: 'p2', status: 'signed', covers_video: false, public_use_allowed: false, created_at: '2026-08-02T00:00:00Z' },
      ]); // current consent per guardian

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result.ok).toBe(true);
    expect(result.missingParentIds).toEqual([]);
    expect(result.perGuardian).toHaveLength(2);
  });

  test('missing when one of several guardians has never signed', async () => {
    mockQuery
      .mockResolvedValueOnce([{ parent_id: 'p1' }, { parent_id: 'p2' }])
      .mockResolvedValueOnce([
        { parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' },
        // p2 has no row at all.
      ]);

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result.ok).toBe(false);
    expect(result.missingParentIds).toEqual(['p2']);
  });

  test('withdrawn is treated as missing, not as "used to have consent"', async () => {
    mockQuery
      .mockResolvedValueOnce([{ parent_id: 'p1' }])
      .mockResolvedValueOnce([
        { parent_id: 'p1', status: 'withdrawn', covers_video: true, public_use_allowed: false, created_at: '2026-08-05T00:00:00Z' },
      ]);

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result.ok).toBe(false);
    expect(result.missingParentIds).toEqual(['p1']);
  });

  test('the current-consent query is scoped to organization_id, athlete_id, and waiver_type=photo_media', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }]).mockResolvedValueOnce([]);

    await checkGuardianMediaConsent('org-a', 'ath-1');

    const [sql, params] = mockQuery.mock.calls[1];
    expect(String(sql)).toContain('waiver_type = $3');
    expect(params).toEqual(['org-a', 'ath-1', 'photo_media']);
  });
});

describe('assertGuardianMediaConsent', () => {
  test('resolves silently when consent is ok', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }]).mockResolvedValueOnce([
      { parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' },
    ]);

    await expect(assertGuardianMediaConsent('org-a', 'ath-1')).resolves.toBeUndefined();
  });

  test('throws GuardianConsentMissingError naming the missing guardians when consent is not ok', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }]).mockResolvedValueOnce([]);

    await expect(assertGuardianMediaConsent('org-a', 'ath-1')).rejects.toThrow(GuardianConsentMissingError);
  });

  test('the thrown error message says "Blocked"', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }]).mockResolvedValueOnce([]);

    await expect(assertGuardianMediaConsent('org-a', 'ath-1')).rejects.toThrow(/Blocked/);
  });

  test('the no-guardians message is distinct from the missing-signature message', async () => {
    mockQuery.mockResolvedValueOnce([]); // no guardians

    await expect(assertGuardianMediaConsent('org-a', 'ath-1')).rejects.toThrow(/no guardians on file/);
  });
});

describe('grantMediaConsent / withdrawMediaConsent', () => {
  test('grant writes a signed photo_media waiver with the given scope', async () => {
    mockUpsertWaiverWithClient.mockResolvedValueOnce('waiver-1');

    const id = await grantMediaConsent({
      organizationId: 'org-a',
      athleteId: 'ath-1',
      parentId: 'p1',
      signedByName: 'Jane Guardian',
      recordedByAccountId: 'acct-entrant',
      coversVideo: true,
      publicUseAllowed: false,
    });

    expect(id).toBe('waiver-1');
    expect(mockUpsertWaiverWithClient).toHaveBeenCalledWith(
      mockTxClient,
      expect.objectContaining({
        waiverType: 'photo_media',
        status: 'signed',
        parentId: 'p1',
        signedByRole: 'parent',
        coversVideo: true,
        publicUseAllowed: false,
      }),
    );
  });

  test('withdraw writes a withdrawn photo_media waiver, always with no scope granted', async () => {
    mockUpsertWaiverWithClient.mockResolvedValueOnce('waiver-2');

    await withdrawMediaConsent({
      organizationId: 'org-a',
      athleteId: 'ath-1',
      parentId: 'p1',
      signedByName: 'Jane Guardian',
      recordedByAccountId: 'acct-entrant',
    });

    expect(mockUpsertWaiverWithClient).toHaveBeenCalledWith(
      mockTxClient,
      expect.objectContaining({ status: 'withdrawn', coversVideo: false, publicUseAllowed: false }),
    );
  });

  /**
   * OWNER DECISION D-2, 2026-08-28: the write takes the lock the readers take.
   *
   * Every reader of an athlete's consent locks pilot.guardian_links before
   * deciding -- FOR SHARE in the transactional re-check, FOR UPDATE in
   * publication.ts's suppression sweep and in removeGuardianLink. The write
   * took none: a bare pooled insert that committed on its own, so no lock any
   * reader held could order itself against it. A withdrawal landing between a
   * reader's check and its action was missed, and on the unlink path missed
   * permanently.
   */
  describe('the write takes the same lock the readers take', () => {
    test.each([
      ['withdrawal', () => withdrawMediaConsent({ organizationId: 'org-a', athleteId: 'ath-1', parentId: 'p1', signedByName: 'Jane Guardian', recordedByAccountId: 'acct-entrant' })],
      ['grant', () => grantMediaConsent({ organizationId: 'org-a', athleteId: 'ath-1', parentId: 'p1', signedByName: 'Jane Guardian', coversVideo: true, publicUseAllowed: false, recordedByAccountId: 'acct-entrant' })],
    ] as Array<[string, () => Promise<string>]>)('a %s locks the guardian link row first', async (_label, write) => {
      await write();

      expect(lockCalls()).toHaveLength(1);
      expect(String(lockCalls()[0][0])).toContain('from pilot.guardian_links');
      // This guardian, this athlete -- the narrowest reader's scope. A writer
      // locking a wider or different range than the readers would give two
      // transactions overlapping sets in opposite orders, which is a deadlock
      // waiting for load.
      expect(lockCalls()[0][1]).toEqual(['org-a', 'p1', 'ath-1']);
    });

    test.each([
      ['withdrawal', () => withdrawMediaConsent({ organizationId: 'org-a', athleteId: 'ath-1', parentId: 'p1', signedByName: 'Jane Guardian', recordedByAccountId: 'acct-entrant' })],
      ['grant', () => grantMediaConsent({ organizationId: 'org-a', athleteId: 'ath-1', parentId: 'p1', signedByName: 'Jane Guardian', coversVideo: true, publicUseAllowed: false, recordedByAccountId: 'acct-entrant' })],
    ] as Array<[string, () => Promise<string>]>)('the %s is recorded AFTER the lock, on the same transaction', async (_label, write) => {
      // Ordering is the whole point: a lock taken after the insert serializes
      // nothing, and an insert on a different connection is not covered by it
      // at all. Both are asserted -- the sequence, and the client identity.
      const seen: string[] = [];
      mockTxClient.query.mockImplementation(((sql: string) => {
        seen.push(String(sql).includes('for update') ? 'lock' : 'other');
        return Promise.resolve({ rows: [], rowCount: 0 });
      }) as never);
      mockUpsertWaiverWithClient.mockImplementationOnce((async () => {
        seen.push('insert');
        return 'waiver-x';
      }) as never);

      await write();

      expect(seen).toEqual(['lock', 'insert']);
      expect(mockUpsertWaiverWithClient.mock.calls[0][0]).toBe(mockTxClient);
    });

    test('the pooled writer is not used any more', async () => {
      // upsertWaiver commits the moment it returns, so a lock taken around it
      // would be released before the row existed. Using it here would look
      // correct and serialize nothing.
      await withdrawMediaConsent({ organizationId: 'org-a', athleteId: 'ath-1', parentId: 'p1', signedByName: 'Jane Guardian', recordedByAccountId: 'acct-entrant' });

      expect(mockUpsertWaiver).not.toHaveBeenCalled();
    });

    test('a guardian with no link row can still record a decision', async () => {
      /* `for update` over zero rows locks nothing and returns. That is
         deliberate: a guardian whose link is missing or already removed must
         still be able to put their decision on file, and refusing to record a
         WITHDRAWAL for a bookkeeping reason would be the platform losing a
         "no". The readers already treat an athlete with no links as
         unverifiable rather than consented, which is the closed direction. */
      mockTxClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
      mockUpsertWaiverWithClient.mockResolvedValueOnce('waiver-3');

      await expect(
        withdrawMediaConsent({ organizationId: 'org-a', athleteId: 'ath-1', parentId: 'p1', signedByName: 'Jane Guardian', recordedByAccountId: 'acct-entrant' }),
      ).resolves.toBe('waiver-3');
    });
  });
});

describe('resolveActingParent', () => {
  // The actual join (organization_id + account_id + gl.athlete_id) lives in
  // guardianAccess.ts's guardianParentIdForAthlete, per that module's own
  // consolidation doctrine -- see guardianAccess.test.ts for the SQL/join
  // coverage, including the two-parent-rows-two-children regression case.
  // This is just a delegation, so these tests only pin the delegation.
  test('delegates to guardianParentIdForAthlete with the same arguments and returns its result', async () => {
    mockGuardianParentIdForAthlete.mockResolvedValueOnce({ parentId: 'p1', fullName: 'Jane Guardian' });

    const result = await resolveActingParent('org-a', 'acct-parent', 'ath-1');

    expect(result).toEqual({ parentId: 'p1', fullName: 'Jane Guardian' });
    expect(mockGuardianParentIdForAthlete).toHaveBeenCalledWith('org-a', 'acct-parent', 'ath-1');
  });

  test('null when this account has no parent row linked to this specific athlete', async () => {
    mockGuardianParentIdForAthlete.mockResolvedValueOnce(null);

    const result = await resolveActingParent('org-a', 'acct-parent', 'ath-1');

    expect(result).toBeNull();
  });
});

describe('callerParentIdSet', () => {
  test('returns every parent_id the account backs, as a set for membership testing', async () => {
    mockGuardianParentIds.mockResolvedValueOnce(['parent-1', 'parent-2']);

    const result = await callerParentIdSet('org-a', 'acct-parent');

    expect(result).toEqual(new Set(['parent-1', 'parent-2']));
  });

  test('an empty set when the account backs no parent row', async () => {
    mockGuardianParentIds.mockResolvedValueOnce([]);

    const result = await callerParentIdSet('org-a', 'acct-parent');

    expect(result.size).toBe(0);
  });
});

describe('assertGuardianMediaConsentWithClient', () => {
  // TypeScript can't validate a jest.fn() mock against a genuinely generic
  // `query<T>(...): Promise<{ rows: T[] }>` method -- jest.Mock's inferred
  // signature is necessarily monomorphic. Cast to the exact parameter type
  // assertGuardianMediaConsentWithClient expects instead of fighting that;
  // `.query` stays a real jest.Mock for the call-count assertion below.
  function fakeClient(guardianRows: Array<{ parent_id: string }>, consentRows: Array<Record<string, unknown>>) {
    let call = 0;
    const query = jest.fn(async () => {
      call += 1;
      return { rows: call === 1 ? guardianRows : consentRows };
    });
    return { query } as unknown as Parameters<typeof assertGuardianMediaConsentWithClient>[0] & { query: jest.Mock };
  }

  test('resolves silently when every guardian has a current signed row', async () => {
    const client = fakeClient(
      [{ parent_id: 'p1' }],
      [{ parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' }],
    );

    await expect(assertGuardianMediaConsentWithClient(client, 'org-a', 'ath-1')).resolves.toBeUndefined();
  });

  test('throws GuardianConsentMissingError when a guardian has not signed', async () => {
    const client = fakeClient([{ parent_id: 'p1' }], []);

    await expect(assertGuardianMediaConsentWithClient(client, 'org-a', 'ath-1')).rejects.toThrow(GuardianConsentMissingError);
  });

  test('throws when the athlete has no guardians at all', async () => {
    const client = fakeClient([], []);

    await expect(assertGuardianMediaConsentWithClient(client, 'org-a', 'ath-1')).rejects.toThrow(/no guardians on file/);
  });

  test('the guardian-links read holds FOR SHARE -- the race lock against a withdrawal sweep', async () => {
    // suppressPublishedMediaForAthlete takes FOR UPDATE on the same rows
    // before retracting. Dropping this FOR SHARE reopens the interleaving
    // where a publish commits unseen between a withdrawal and its sweep.
    const client = fakeClient(
      [{ parent_id: 'p1' }],
      [{ parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' }],
    );

    await assertGuardianMediaConsentWithClient(client, 'org-a', 'ath-1');

    const [guardianSql] = client.query.mock.calls[0] as [string];
    expect(guardianSql).toMatch(/from pilot\.guardian_links/);
    expect(guardianSql).toMatch(/for share/);
  });

  test('reads through client.query, never the module-level query()', async () => {
    const client = fakeClient(
      [{ parent_id: 'p1' }],
      [{ parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' }],
    );

    await assertGuardianMediaConsentWithClient(client, 'org-a', 'ath-1');

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('listConsentForGuardian', () => {
  test('returns consent status for every athlete this account guards', async () => {
    mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1', 'ath-2']);
    // listConsentForGuardian runs checkGuardianMediaConsent for every athlete
    // CONCURRENTLY (Promise.all), so a positional mockResolvedValueOnce
    // queue cannot predict which athlete's call consumes which queued
    // value -- the mock has to branch on the call's own arguments instead.
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const athleteId = params[1];
      if (String(sql).includes('guardian_links')) {
        return [{ parent_id: 'p1' }];
      }
      // The current-consent (pilot.waivers) query.
      if (athleteId === 'ath-1') return []; // never signed -> missing
      return [{ parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' }];
    });

    const result = await listConsentForGuardian('org-a', 'acct-parent');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ athleteId: 'ath-1', consent: expect.objectContaining({ ok: false }) });
    expect(result[1]).toMatchObject({ athleteId: 'ath-2', consent: expect.objectContaining({ ok: true }) });
  });
});

describe('listOrganizationConsentStatus', () => {
  test('returns every athlete in the org with a consent breakdown, including zero-guardian athletes', async () => {
    mockQuery
      .mockResolvedValueOnce([{ athlete_id: 'ath-1', full_name: 'Sample Athlete' }]) // athletes list
      .mockResolvedValueOnce([]); // guardian_links for ath-1: none

    const result = await listOrganizationConsentStatus('org-a');

    expect(result).toEqual([
      { athleteId: 'ath-1', athleteName: 'Sample Athlete', consent: { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] } },
    ]);
  });

  // page is opt-in and must default to unbounded: this function backs the
  // org-wide consent AUDIT, and a silent cap would hide the exact finding
  // (a non-compliant athlete) the audit exists to surface.
  test('with no page argument, the athletes query carries no LIMIT/OFFSET', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1', full_name: 'Sample Athlete' }]).mockResolvedValueOnce([]);

    await listOrganizationConsentStatus('org-a');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).not.toMatch(/limit/i);
    expect(params).toEqual(['org-a']);
  });

  test('an explicit page bounds the athletes query', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1', full_name: 'Sample Athlete' }]).mockResolvedValueOnce([]);

    await listOrganizationConsentStatus('org-a', { limit: 50, offset: 100 });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/limit \$2 offset \$3/i);
    expect(params).toEqual(['org-a', 50, 100]);
  });
});

/**
 * OWNER DECISION, 2026-08-28: a recognised status survives case and padding.
 *
 * pilot.waivers.status is `text not null` with no CHECK constraint, and
 * /api/pilot/intake/domain-upsert stores `asString(body.payload.status,
 * 'signed')` -- any string a caller sends. waiverCompliance.ts records a
 * waiver stored as ' Signed ' as something that ACTUALLY HAPPENED, and its own
 * gate has trimmed and lowercased since it was written, on the stated ground
 * that refusing over whitespace "punishes the family for a data-entry
 * artifact".
 *
 * These functions read the same column and did not, so one signature was a
 * signature to that gate and not-consent to this one. The asymmetry was the
 * defect; this closes it on the side that was strict.
 *
 * This LOOSENS a consent gate, which is why it took a decision rather than a
 * judgement call. The tests below therefore come in pairs: what now passes,
 * and -- at more length -- what still does not.
 */
describe('a signature recorded untidily is still a signature', () => {
  const signedAs = (status: string) => {
    mockQuery
      .mockResolvedValueOnce([{ parent_id: 'p1' }])
      .mockResolvedValueOnce([
        { parent_id: 'p1', status, covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' },
      ]);
  };

  test.each([' Signed ', 'SIGNED', 'Signed', ' signed', 'signed  ', '\tsigned\n'])(
    'a consent stored as %p counts as consent',
    async (status) => {
      signedAs(status);

      const result = await checkGuardianMediaConsent('org-a', 'ath-1');

      expect(result.ok).toBe(true);
      expect(result.missingParentIds).toEqual([]);
    },
  );

  test('the raw stored value still reaches the caller unchanged', async () => {
    // Only the COMPARISON normalises. perGuardian is what the row actually
    // says, and the parent console renders it -- a screen that quietly
    // rewrote what was stored would be a different kind of dishonesty.
    signedAs(' Signed ');

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result.perGuardian[0].status).toBe(' Signed ');
  });

  test.each(['active', 'approved', 'accepted', 'current', 'pending', 'revoked', 'signd', 'yes', '', '   '])(
    'a status of %p is still NOT consent',
    async (status) => {
      /* The blast radius, pinned. The shared helper trims and lowercases and
         does nothing else -- it does not map an unrecognised value onto a
         recognised one. So this decision loosened the gate for a real
         signature recorded untidily and for nothing else.

         'active' and 'approved' are in this list deliberately: wallDisplay.ts
         treats both as affirmative consent for its own surface. That
         divergence is real and is a separate owner decision; it is not
         resolved by this change and must not be resolved by accident. */
      signedAs(status);

      const result = await checkGuardianMediaConsent('org-a', 'ath-1');

      expect(result.ok).toBe(false);
      expect(result.missingParentIds).toEqual(['p1']);
    },
  );

  test('a withdrawal recorded untidily still withdraws', async () => {
    // The safety direction of the same rule: normalisation must not let a
    // withdrawal slip past by being stored as ' Withdrawn '.
    signedAs(' Withdrawn ');

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result.ok).toBe(false);
  });

  describe('the transactional variant answers identically', () => {
    // These two are the same rule on the same rows. The re-check exists to run
    // inside a transaction, not to apply a stricter test than the one that let
    // the caller in, so a value accepted by one must be accepted by the other.
    const clientWith = (status: string) => ({
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ parent_id: 'p1' }] })
        .mockResolvedValueOnce({
          rows: [{ parent_id: 'p1', status, covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' }],
        }),
    });

    test.each([' Signed ', 'SIGNED', 'Signed'])('%p does not refuse', async (status) => {
      await expect(
        assertGuardianMediaConsentWithClient(clientWith(status), 'org-a', 'ath-1'),
      ).resolves.toBeUndefined();
    });

    test.each(['active', 'approved', ' Withdrawn ', 'pending', ''])('%p still refuses', async (status) => {
      await expect(
        assertGuardianMediaConsentWithClient(clientWith(status), 'org-a', 'ath-1'),
      ).rejects.toThrow(GuardianConsentMissingError);
    });
  });
});
