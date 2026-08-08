import type { PilotRole } from './contracts';
import {
  consumeMagicLink,
  issueMagicLink,
  MAGIC_LINK_LIFETIME_MS,
  normalizeEmail,
  type ConsumeDependencies,
  type MagicLinkAccount,
  type MagicLinkDependencies,
} from './magicLink';
import { hashToken } from './security';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function account(overrides: Partial<MagicLinkAccount> = {}): MagicLinkAccount {
  return {
    account_id: 'coach-1',
    organization_id: 'ppbf-default-org',
    role: 'coach',
    auth_provider: 'magic_link',
    login_email: 'coach@example.com',
    active_flag: true,
    ...overrides,
  };
}

interface Recorded {
  stored: Array<{ tokenHash: string; accountId: string; sentToEmail: string; expiresAt: Date }>;
  sent: Array<{ to: string; subject: string; body: string }>;
  invalidated: string[];
}

function issueDeps(
  found: MagicLinkAccount | null,
  recorded: Recorded,
  overrides: Partial<MagicLinkDependencies> = {},
): MagicLinkDependencies {
  return {
    findAccountByEmail: async () => found,
    invalidateLiveTokens: async (id) => {
      recorded.invalidated.push(id);
    },
    storeToken: async (row) => {
      recorded.stored.push(row);
    },
    sendMail: async (m) => {
      recorded.sent.push(m);
    },
    now: () => NOW,
    createToken: () => 'test-token-value',
    appOrigin: 'https://app.ppbf.org',
    ...overrides,
  };
}

function fresh(): Recorded {
  return { stored: [], sent: [], invalidated: [] };
}

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'coach-1',
    organization_id: 'ppbf-default-org',
    sent_to_email: 'coach@example.com',
    expires_at: new Date(NOW.getTime() + 60_000),
    consumed_at: null as Date | null,
    invalidated_at: null as Date | null,
    role: 'coach' as PilotRole,
    auth_provider: 'magic_link' as const,
    active_flag: true,
    login_email: 'coach@example.com',
    ...overrides,
  };
}

function consumeDeps(
  row: ReturnType<typeof tokenRow> | null,
  overrides: Partial<ConsumeDependencies> = {},
): ConsumeDependencies {
  return {
    loadTokenByHash: async () => row,
    markConsumed: async () => true,
    now: () => NOW,
    ...overrides,
  };
}

describe('issuing a magic link', () => {
  test('stores only the hash, never the token', async () => {
    const recorded = fresh();
    await issueMagicLink('coach@example.com', issueDeps(account(), recorded));

    expect(recorded.stored).toHaveLength(1);
    expect(recorded.stored[0].tokenHash).toBe(hashToken('test-token-value'));
    // The whole point. A readable token in the database is a working
    // credential for anyone who can read the database.
    expect(JSON.stringify(recorded.stored[0])).not.toContain('test-token-value');
  });

  test('the emailed link carries the token and the stored row does not', async () => {
    const recorded = fresh();
    await issueMagicLink('coach@example.com', issueDeps(account(), recorded));

    expect(recorded.sent[0].body).toContain(
      'https://app.ppbf.org/auth/link?token=test-token-value',
    );
    expect(recorded.sent[0].to).toBe('coach@example.com');
  });

  test('expires fifteen minutes out', async () => {
    const recorded = fresh();
    await issueMagicLink('coach@example.com', issueDeps(account(), recorded));
    expect(recorded.stored[0].expiresAt.getTime() - NOW.getTime()).toBe(MAGIC_LINK_LIFETIME_MS);
  });

  test('kills outstanding links before issuing a new one', async () => {
    const recorded = fresh();
    await issueMagicLink('coach@example.com', issueDeps(account(), recorded));
    // Otherwise a parent who clicks "send again" three times leaves three
    // working credentials sitting in an inbox.
    expect(recorded.invalidated).toEqual(['coach-1']);
  });

  test('records the address as sent, not the account address', async () => {
    const recorded = fresh();
    await issueMagicLink('  COACH@Example.com  ', issueDeps(account(), recorded));
    expect(recorded.stored[0].sentToEmail).toBe('coach@example.com');
  });

  describe('tells the requester nothing about who has an account', () => {
    const cases: Array<[string, MagicLinkAccount | null]> = [
      ['no account at all', null],
      ['a deactivated account', account({ active_flag: false })],
      ['an athlete, who uses a PIN', account({ role: 'athlete' })],
      ['an administrator, who uses Microsoft', account({ role: 'organization_admin' })],
      ['a board member, who uses Microsoft', account({ role: 'board' })],
      ['an account whose email does not match', account({ login_email: 'other@example.com' })],
      ['an account with no email recorded', account({ login_email: null })],
    ];

    test.each(cases)('%s: sends nothing and stores nothing', async (_label, found) => {
      const recorded = fresh();
      await expect(
        issueMagicLink('coach@example.com', issueDeps(found, recorded)),
      ).resolves.toBeUndefined();
      expect(recorded.sent).toEqual([]);
      expect(recorded.stored).toEqual([]);
    });
  });

  test('a mail transport failure still throws -- that is a fault, not a signal', async () => {
    const recorded = fresh();
    await expect(
      issueMagicLink(
        'coach@example.com',
        issueDeps(account(), recorded, {
          sendMail: async () => {
            throw new Error('GRAPH_SEND_FAILED');
          },
        }),
      ),
    ).rejects.toThrow('GRAPH_SEND_FAILED');
  });
});

describe('redeeming a magic link', () => {
  test('a valid link produces a session for the right account', async () => {
    const result = await consumeMagicLink('test-token-value', consumeDeps(tokenRow()));
    expect(result).toEqual({
      ok: true,
      accountId: 'coach-1',
      organizationId: 'ppbf-default-org',
      role: 'coach',
    });
  });

  test('looks the token up by hash, never by value', async () => {
    let asked = '';
    await consumeMagicLink(
      'test-token-value',
      consumeDeps(tokenRow(), {
        loadTokenByHash: async (h) => {
          asked = h;
          return tokenRow();
        },
      }),
    );
    expect(asked).toBe(hashToken('test-token-value'));
    expect(asked).not.toBe('test-token-value');
  });

  test.each([
    ['unknown', null, 'TOKEN_UNKNOWN'],
    ['already used', tokenRow({ consumed_at: NOW }), 'TOKEN_ALREADY_USED'],
    ['invalidated by a newer link', tokenRow({ invalidated_at: NOW }), 'TOKEN_INVALIDATED'],
    ['expired', tokenRow({ expires_at: new Date(NOW.getTime() - 1) }), 'TOKEN_EXPIRED'],
    ['account deactivated since issue', tokenRow({ active_flag: false }), 'ACCOUNT_INACTIVE'],
    ['role no longer uses magic links', tokenRow({ role: 'organization_admin' }), 'ACCOUNT_NOT_MAGIC_LINK'],
    ['email changed since issue', tokenRow({ login_email: 'new@example.com' }), 'EMAIL_CHANGED'],
  ])('refuses a %s link', async (_label, row, reason) => {
    const result = await consumeMagicLink('test-token-value', consumeDeps(row));
    expect(result).toEqual({ ok: false, reason });
  });

  test('expiry is exclusive at the boundary', async () => {
    // A token expiring exactly now is dead, not alive. Off-by-one here is a
    // credential that outlives its stated lifetime.
    const atBoundary = await consumeMagicLink(
      'test-token-value',
      consumeDeps(tokenRow({ expires_at: NOW })),
    );
    expect(atBoundary).toEqual({ ok: false, reason: 'TOKEN_EXPIRED' });

    const oneMsLeft = await consumeMagicLink(
      'test-token-value',
      consumeDeps(tokenRow({ expires_at: new Date(NOW.getTime() + 1) })),
    );
    expect(oneMsLeft).toMatchObject({ ok: true });
  });

  test('two simultaneous clicks yield exactly one session', async () => {
    // markConsumed writes conditionally and reports whether it changed a row.
    // The reads above can both pass; this is what actually decides.
    let claimed = false;
    const deps = consumeDeps(tokenRow(), {
      markConsumed: async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
    });

    const [first, second] = await Promise.all([
      consumeMagicLink('test-token-value', deps),
      consumeMagicLink('test-token-value', deps),
    ]);

    const outcomes = [first, second].map((r) => r.ok);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect([first, second].find((r) => !r.ok)).toEqual({ ok: false, reason: 'TOKEN_RACE_LOST' });
  });
});

describe('email normalization', () => {
  test('trims and lowercases, because Entra and humans both vary the case', () => {
    expect(normalizeEmail('  Coach@Example.COM ')).toBe('coach@example.com');
  });
});
