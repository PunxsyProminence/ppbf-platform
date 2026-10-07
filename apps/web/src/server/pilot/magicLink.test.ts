import type { PilotRole } from './contracts';
import {
  consumeMagicLink,
  issueMagicLink,
  MAGIC_LINK_LIFETIME_MS,
  magicLinkOrigin,
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
    account_deleted: false,
    ...overrides,
  };
}

interface Recorded {
  stored: Array<{ tokenHash: string; accountId: string; sentToEmail: string; expiresAt: Date }>;
  sent: Array<{ to: string; subject: string; body: string }>;
  invalidated: Array<{ accountId: string; keepTokenHash: string }>;
  discarded: string[];
  lookedUp: string[];
  /** Every dependency call, in the order it happened. */
  order: string[];
}

function issueDeps(
  found: MagicLinkAccount | null,
  recorded: Recorded,
  overrides: Partial<MagicLinkDependencies> = {},
): MagicLinkDependencies {
  return {
    findAccountByEmail: async (email) => {
      recorded.lookedUp.push(email);
      return found;
    },
    invalidateLiveTokens: async (accountId, keepTokenHash) => {
      recorded.order.push('invalidate');
      recorded.invalidated.push({ accountId, keepTokenHash });
    },
    discardToken: async (tokenHash) => {
      recorded.order.push('discard');
      recorded.discarded.push(tokenHash);
    },
    storeToken: async (row) => {
      recorded.order.push('store');
      recorded.stored.push(row);
    },
    sendMail: async (m) => {
      recorded.order.push('send');
      recorded.sent.push(m);
    },
    now: () => NOW,
    createToken: () => 'test-token-value',
    appOrigin: 'https://app.ppbf.org',
    ...overrides,
  };
}

function fresh(): Recorded {
  return { stored: [], sent: [], invalidated: [], discarded: [], lookedUp: [], order: [] };
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
    account_deleted: false,
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

  /**
   * THE OLD LINK SURVIVES A FAILED SEND. The first version invalidated the
   * account's live links, then stored, then sent: a send that failed left the
   * person with no working link at all, including the one still unread in
   * their inbox. Now the other links are retired only once the new one has
   * actually gone out.
   */
  describe('the link already in the inbox outlives a failed send', () => {
    test('a sent link retires every OTHER live link, after the send and not before', async () => {
      const recorded = fresh();
      await issueMagicLink('coach@example.com', issueDeps(account(), recorded));

      // Otherwise a parent who clicks "send again" three times leaves three
      // working credentials sitting in an inbox.
      expect(recorded.invalidated).toEqual([
        { accountId: 'coach-1', keepTokenHash: hashToken('test-token-value') },
      ]);
      expect(recorded.order).toEqual(['store', 'send', 'invalidate']);
      expect(recorded.discarded).toEqual([]);
    });

    test('a failed send leaves the other links alone, discards the unsent one, and still throws', async () => {
      const recorded = fresh();
      await expect(
        issueMagicLink(
          'coach@example.com',
          issueDeps(account(), recorded, {
            sendMail: async () => {
              recorded.order.push('send');
              throw new Error('GRAPH_SEND_FAILED');
            },
          }),
        ),
      ).rejects.toThrow('GRAPH_SEND_FAILED');

      expect(recorded.invalidated).toEqual([]);
      expect(recorded.discarded).toEqual([hashToken('test-token-value')]);
      expect(recorded.order).toEqual(['store', 'send', 'discard']);
    });

    test('a discard that itself fails does not hide the send fault', async () => {
      const recorded = fresh();
      await expect(
        issueMagicLink(
          'coach@example.com',
          issueDeps(account(), recorded, {
            sendMail: async () => {
              throw new Error('GRAPH_SEND_FAILED');
            },
            discardToken: async (tokenHash) => {
              recorded.discarded.push(tokenHash);
              throw new Error('DB_DOWN');
            },
          }),
        ),
      ).rejects.toThrow('GRAPH_SEND_FAILED');
      expect(recorded.discarded).toEqual([hashToken('test-token-value')]);
      expect(recorded.invalidated).toEqual([]);
    });

    test('a retire step that fails after the send is logged, not reported as a failed issue', async () => {
      // The link went out. Telling the caller the issue failed would be
      // false; the cost is the older link living on until its own expiry.
      const recorded = fresh();
      const logged: string[] = [];
      const spy = jest.spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
      await expect(
        issueMagicLink(
          'coach@example.com',
          issueDeps(account(), recorded, {
            invalidateLiveTokens: async () => {
              throw new Error('DB_DOWN');
            },
          }),
        ),
      ).resolves.toBeUndefined();
      expect(recorded.sent).toHaveLength(1);
      expect(JSON.parse(logged[0])).toEqual({
        event: 'magic_link.retire_older_failed',
        error_type: 'Error',
        error_code: 'DB_DOWN',
      });
      expect(logged.join('\n')).not.toContain('coach@example.com');
      spy.mockRestore();
    });
  });

  /**
   * THE SITE ADDRESS IS CHECKED, NOT JUST PRESENT. Production once held
   * `punxsyprominence.org` -- no scheme, a host with no address record -- and
   * every emailed link was dead while every send reported success.
   */
  describe('refuses to build a link on a site address it cannot vouch for', () => {
    const bad: Array<[string, string]> = [
      ['no scheme', 'punxsyprominence.org'],
      ['no scheme, with www', 'www.punxsyprominence.org'],
      ['empty', ''],
      ['whitespace only', '   '],
      ['a path only', '/auth/link'],
      ['http on a public host', 'http://www.punxsyprominence.org'],
      ['http on a host that merely starts with localhost', 'http://localhost.example.org'],
      ['http on a non-loopback 127-lookalike', 'http://127.0.0.1.example.org'],
      ['a path after the host', 'https://www.punxsyprominence.org/app'],
      ['a query string', 'https://www.punxsyprominence.org/?x=1'],
      ['a fragment', 'https://www.punxsyprominence.org/#top'],
      ['credentials in the address', 'https://user:pw@www.punxsyprominence.org'],
      ['a scheme that is not http(s)', 'ftp://www.punxsyprominence.org'],
      ['a scheme with no host', 'https://'],
      ['a mailto', 'mailto:admin@punxsyprominence.org'],
      ['a trailing dot on the host, which a cookie jar treats as another site', 'https://www.punxsyprominence.org.'],
    ];

    test.each(bad)('%s: looks nobody up, stores nothing, mails nothing, and throws', async (_label, appOrigin) => {
      const recorded = fresh();
      await expect(
        issueMagicLink('coach@example.com', issueDeps(account(), recorded, { appOrigin })),
      ).rejects.toThrow(/^INVALID_PPBF_APP_ORIGIN:/);

      // Refused before the lookup, so the failure is the same for an address
      // with an account and one without: no enumeration signal.
      expect(recorded.lookedUp).toEqual([]);
      expect(recorded.stored).toEqual([]);
      expect(recorded.sent).toEqual([]);
      expect(recorded.invalidated).toEqual([]);
    });

    test('the thrown message names the reason and never the value', async () => {
      const recorded = fresh();
      await expect(
        issueMagicLink('coach@example.com', issueDeps(account(), recorded, {
          appOrigin: 'http://secret-host.example.org',
        })),
      ).rejects.toThrow(/^INVALID_PPBF_APP_ORIGIN:http_not_loopback$/);
    });

    const good: Array<[string, string, string]> = [
      ['the production address', 'https://www.punxsyprominence.org', 'https://www.punxsyprominence.org'],
      ['a trailing slash', 'https://www.punxsyprominence.org/', 'https://www.punxsyprominence.org'],
      ['surrounding whitespace', '  https://app.ppbf.test  ', 'https://app.ppbf.test'],
      ['an https port', 'https://app.ppbf.test:8443', 'https://app.ppbf.test:8443'],
      ['a development server on localhost', 'http://localhost:3000', 'http://localhost:3000'],
      ['a development server on 127.0.0.1', 'http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
      ['a development server on ::1', 'http://[::1]:3000', 'http://[::1]:3000'],
      ['https on localhost', 'https://localhost:3000', 'https://localhost:3000'],
    ];

    test.each(good)('%s: the link is built on it', async (_label, appOrigin, expectedOrigin) => {
      const recorded = fresh();
      await issueMagicLink('coach@example.com', issueDeps(account(), recorded, { appOrigin }));
      expect(recorded.sent[0].body).toContain(`\n${expectedOrigin}/auth/link?token=test-token-value\n`);
    });

    test('magicLinkOrigin returns the bare origin and nothing else', () => {
      expect(magicLinkOrigin('https://www.punxsyprominence.org/')).toBe('https://www.punxsyprominence.org');
      expect(magicLinkOrigin('HTTPS://WWW.PunxsyProminence.org')).toBe('https://www.punxsyprominence.org');
      expect(() => magicLinkOrigin('punxsyprominence.org')).toThrow('INVALID_PPBF_APP_ORIGIN:not_absolute_url');
      expect(() => magicLinkOrigin('')).toThrow('INVALID_PPBF_APP_ORIGIN:empty');
      expect(() => magicLinkOrigin('https://www.punxsyprominence.org//')).toThrow('INVALID_PPBF_APP_ORIGIN:has_path');
    });
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
      // Sign-in refuses any account marked deleted (OD-2026-09-29-003 Q9),
      // including one an admin path has set active again.
      ['an account marked deleted, though active again', account({ account_deleted: true })],
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
      expect(recorded.invalidated).toEqual([]);
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
    // Marked deleted while still active: the existing code, so the link page
    // shows its existing "not active" message (OD-2026-09-29-003 Q9).
    ['deleted but still active account', tokenRow({ account_deleted: true }), 'ACCOUNT_INACTIVE'],
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
