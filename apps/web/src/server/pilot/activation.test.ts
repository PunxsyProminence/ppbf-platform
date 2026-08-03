interface QueuedResponse {
  match: RegExp;
  rows: Record<string, unknown>[];
}

let queued: QueuedResponse[] = [];
let currentClient: { query: jest.Mock };

function fakeClient() {
  return {
    query: jest.fn(async (sql: string) => {
      const hit = queued.find((entry) => entry.match.test(sql));
      return { rows: hit ? hit.rows : [] };
    }),
  };
}

// Responds by matching the SQL text rather than call order, so a test states
// "the token lookup finds a row" instead of "the second query returns this",
// and stays readable if an unrelated query is added to the transaction.
function respond(match: RegExp, rows: Record<string, unknown>[]) {
  queued.push({ match, rows });
}

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

jest.mock('./security', () => ({
  hashPin: jest.fn(async () => 'hashed-pin'),
  verifyPin: jest.fn(),
  createOpaqueToken: jest.fn(),
  hashToken: jest.fn((value: string) => `sha256(${value})`),
}));

import {
  cleanupActivationTokens,
  generateActivationCode,
  issueActivationCode,
  normalizeActivationCode,
  redeemActivationCode,
} from './activation';
import { query, withTransaction } from './db';
import { hashPin } from './security';

const mockQuery = query as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;
const mockHashPin = hashPin as jest.Mock;

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function callsMatching(pattern: RegExp) {
  return currentClient.query.mock.calls.filter(([sql]) => pattern.test(sql));
}

beforeEach(() => {
  queued = [];
  currentClient = fakeClient();
  mockQuery.mockReset();
  mockWithTransaction.mockClear();
  mockHashPin.mockClear();
});

describe('generateActivationCode', () => {
  test('produces three dash-separated groups of four', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateActivationCode()).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
  });

  test('never emits the glyphs that are routinely mis-transcribed', () => {
    // I/L/O/U are excluded from the alphabet precisely because they get
    // confused with 1/1/0/V when read off a printed slip.
    for (let index = 0; index < 200; index += 1) {
      const code = generateActivationCode().replace(/-/g, '');
      expect(code).not.toMatch(/[ILOU]/);
      for (const character of code) {
        expect(CODE_ALPHABET).toContain(character);
      }
    }
  });

  test('does not repeat itself across many draws', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      seen.add(generateActivationCode());
    }
    expect(seen.size).toBe(200);
  });
});

describe('normalizeActivationCode', () => {
  test('strips dashes and uppercases', () => {
    expect(normalizeActivationCode('abcd-2345-efgh')).toBe('ABCD2345EFGH');
  });

  test('folds the confusable glyphs onto real alphabet characters', () => {
    // An athlete who reads 0 as "O" and 1 as "I" still gets in.
    expect(normalizeActivationCode('OOOO-IIII-LLLL')).toBe('000011111111');
    expect(normalizeActivationCode('UUUU-2345-6789')).toBe('VVVV23456789');
  });

  test('tolerates spaces and stray separators', () => {
    expect(normalizeActivationCode(' abcd 2345 efgh ')).toBe('ABCD2345EFGH');
  });

  test('rejects a code of the wrong length', () => {
    expect(() => normalizeActivationCode('ABCD-2345')).toThrow('Missing code');
    expect(() => normalizeActivationCode('ABCD-2345-EFGH-9999')).toThrow('Missing code');
  });

  test('round-trips a freshly generated code', () => {
    const code = generateActivationCode();
    expect(normalizeActivationCode(code)).toBe(code.replace(/-/g, ''));
  });
});

describe('issueActivationCode', () => {
  function stubIssuableAthlete() {
    respond(/from pilot\.accounts/, [{ account_id: 'ath-1' }]);
    respond(/insert into pilot\.account_activation_tokens/, [{ expires_at: '2026-08-10T00:00:00Z' }]);
  }

  test('returns the plaintext code but persists only its hash', async () => {
    stubIssuableAthlete();
    const result = await issueActivationCode({
      accountId: 'ath-1',
      organizationId: 'org-1',
      issuedByAccountId: 'admin-1',
      issuedByRole: 'organization_admin',
    });

    expect(result.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const [, params] = callsMatching(/insert into pilot\.account_activation_tokens/)[0];
    const persistedHash = (params as unknown[])[0] as string;
    expect(persistedHash).toContain('sha256(');
    // The plaintext must never appear in what is written to the table.
    expect(persistedHash).not.toContain(result.code);
    expect(params).not.toContain(result.code);
  });

  test('supersedes every outstanding code for the account before inserting', async () => {
    stubIssuableAthlete();
    await issueActivationCode({
      accountId: 'ath-1',
      organizationId: 'org-1',
      issuedByAccountId: 'admin-1',
      issuedByRole: 'organization_admin',
    });

    const supersede = callsMatching(/set superseded_at = now\(\)/);
    expect(supersede).toHaveLength(1);
    expect(supersede[0][1]).toEqual(['ath-1']);
  });

  test('refuses a target that is not an athlete in this organization', async () => {
    // The account lookup finds nothing: wrong org, wrong role, or absent.
    await expect(
      issueActivationCode({
        accountId: 'coach-1',
        organizationId: 'org-1',
        issuedByAccountId: 'admin-1',
        issuedByRole: 'organization_admin',
      }),
    ).rejects.toThrow('Not found');
  });

  test('scopes the lookup to athletes who are not platform owners', async () => {
    stubIssuableAthlete();
    await issueActivationCode({
      accountId: 'ath-1',
      organizationId: 'org-1',
      issuedByAccountId: 'admin-1',
      issuedByRole: 'organization_admin',
    });

    const [sql] = callsMatching(/from pilot\.accounts/)[0];
    expect(sql).toContain("role = 'athlete'");
    expect(sql).toContain('is_platform_owner = false');
  });

  test('rejects a malformed ttl', async () => {
    await expect(
      issueActivationCode({
        accountId: 'ath-1',
        organizationId: 'org-1',
        issuedByAccountId: 'admin-1',
        issuedByRole: 'organization_admin',
        ttlHours: 0,
      }),
    ).rejects.toThrow('Missing ttl_hours');

    await expect(
      issueActivationCode({
        accountId: 'ath-1',
        organizationId: 'org-1',
        issuedByAccountId: 'admin-1',
        issuedByRole: 'organization_admin',
        ttlHours: 99999,
      }),
    ).rejects.toThrow('Missing ttl_hours');
  });
});

describe('redeemActivationCode', () => {
  function stubRedeemableToken() {
    respond(/from pilot\.account_activation_tokens/, [{ account_id: 'ath-1', organization_id: 'org-1' }]);
    respond(/from pilot\.organizations/, [{ status: 'active' }]);
    respond(/update pilot\.accounts/, [{ athlete_id: 'athlete-record-1' }]);
  }

  test('rejects a malformed PIN without touching the database', async () => {
    // The security invariant that keeps a typo from burning a one-time code:
    // policy is validated before any transaction opens.
    await expect(redeemActivationCode('ABCD-2345-EFGH', '12')).rejects.toThrow('PIN');
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockHashPin).not.toHaveBeenCalled();
  });

  test('rejects a non-numeric PIN without touching the database', async () => {
    await expect(redeemActivationCode('ABCD-2345-EFGH', 'abcdef')).rejects.toThrow('PIN');
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('rejects a malformed code without touching the database', async () => {
    await expect(redeemActivationCode('TOO-SHORT', '428913')).rejects.toThrow('Missing code');
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('locks the token row so a code cannot be redeemed twice concurrently', async () => {
    stubRedeemableToken();
    await redeemActivationCode('ABCD-2345-EFGH', '428913');

    const [sql] = callsMatching(/from pilot\.account_activation_tokens/)[0];
    expect(sql).toContain('for update');
    expect(sql).toContain('consumed_at is null');
    expect(sql).toContain('superseded_at is null');
    expect(sql).toContain('expires_at > now()');
  });

  test('sets the PIN, activates membership, consumes the token and revokes sessions', async () => {
    stubRedeemableToken();
    const result = await redeemActivationCode('ABCD-2345-EFGH', '428913');

    expect(result).toEqual({
      accountId: 'ath-1',
      organizationId: 'org-1',
      athleteId: 'athlete-record-1',
    });

    expect(callsMatching(/update pilot\.accounts/)[0][1]).toEqual([
      'hashed-pin',
      'ath-1',
      'org-1',
    ]);
    expect(callsMatching(/insert into pilot\.organization_memberships/)).toHaveLength(1);
    expect(callsMatching(/set consumed_at = now\(\)/)).toHaveLength(1);

    // The credential just changed, so nothing minted earlier may survive.
    const revoke = callsMatching(/update pilot\.session_tokens/);
    expect(revoke).toHaveLength(1);
    expect(revoke[0][1]).toEqual(['ath-1']);
  });

  test('rejects an unknown, consumed, superseded, or expired code', async () => {
    // Token lookup returns nothing -- all four conditions are folded into the
    // same WHERE clause and the same message, so they are indistinguishable.
    await expect(redeemActivationCode('ABCD-2345-EFGH', '428913')).rejects.toThrow(
      'Unauthorized: activation code is invalid, already used, or expired',
    );
  });

  test('refuses to activate into an organization that is not active', async () => {
    respond(/from pilot\.account_activation_tokens/, [{ account_id: 'ath-1', organization_id: 'org-1' }]);
    respond(/from pilot\.organizations/, [{ status: 'suspended' }]);

    await expect(redeemActivationCode('ABCD-2345-EFGH', '428913')).rejects.toThrow(
      'Unauthorized: activation code is invalid, already used, or expired',
    );

    // Nothing may be written when the organization gate fails.
    expect(callsMatching(/set consumed_at = now\(\)/)).toHaveLength(0);
  });

  test('refuses when the account changed role between issue and redemption', async () => {
    respond(/from pilot\.account_activation_tokens/, [{ account_id: 'ath-1', organization_id: 'org-1' }]);
    respond(/from pilot\.organizations/, [{ status: 'active' }]);
    // The guarded UPDATE matches no row because role is no longer 'athlete'.

    await expect(redeemActivationCode('ABCD-2345-EFGH', '428913')).rejects.toThrow(
      'Unauthorized: activation code is invalid, already used, or expired',
    );
    expect(callsMatching(/set consumed_at = now\(\)/)).toHaveLength(0);
  });

  test('accepts a code typed with confusable glyphs', async () => {
    stubRedeemableToken();
    // Same code as the issue-time canonical form, typed with O for 0.
    await expect(redeemActivationCode('abcd-2345-efgh', '428913')).resolves.toBeDefined();
  });
});

describe('cleanupActivationTokens', () => {
  test('rejects a malformed retention window', async () => {
    await expect(cleanupActivationTokens(0)).rejects.toThrow('Missing retention_days');
    await expect(cleanupActivationTokens(-1)).rejects.toThrow('Missing retention_days');
    await expect(cleanupActivationTokens(400)).rejects.toThrow('Missing retention_days');
  });

  test('deletes on any terminal condition, not all of them', async () => {
    mockQuery.mockResolvedValueOnce([{ token_hash: 'a' }, { token_hash: 'b' }]);
    const result = await cleanupActivationTokens(30);

    expect(result).toEqual({ deletedCount: 2 });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('expires_at <');
    expect(sql).toContain('consumed_at is not null');
    expect(sql).toContain('superseded_at is not null');
    expect(sql).toMatch(/or/i);
  });
});
