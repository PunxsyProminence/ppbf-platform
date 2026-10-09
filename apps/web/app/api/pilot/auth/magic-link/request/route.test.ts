/**
 * @jest-environment node
 */
import { POST } from './route';

jest.mock('@/src/server/pilot/rateLimit', () => ({
  getClientIp: () => '203.0.113.9',
  reserveAttempts: jest.fn(async () => ({ isLimited: false })),
}));

jest.mock('@/src/server/pilot/magicLink', () => ({
  issueMagicLink: jest.fn(async () => undefined),
}));

jest.mock('@/src/server/pilot/magicLinkStore', () => ({
  magicLinkDependencies: jest.fn(() => ({})),
}));

import { issueMagicLink } from '@/src/server/pilot/magicLink';
import { magicLinkDependencies } from '@/src/server/pilot/magicLinkStore';
import { reserveAttempts } from '@/src/server/pilot/rateLimit';

/** A reservation refused on the bucket whose key starts with `prefix`, by either store. */
function refuseOn(prefix: string, durable: boolean) {
  (reserveAttempts as jest.Mock).mockImplementation(async (keys: string[]) => {
    const key = keys.find((k) => k.startsWith(prefix));
    return key ? { isLimited: true, key, durable, delayMs: 1000 } : { isLimited: false };
  });
}

function post(body: unknown) {
  return POST({
    json: async () => body,
    headers: new Headers(),
  } as never);
}

describe('POST /api/pilot/auth/magic-link/request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (reserveAttempts as jest.Mock).mockResolvedValue({ isLimited: false });
    (issueMagicLink as jest.Mock).mockResolvedValue(undefined);
    (magicLinkDependencies as jest.Mock).mockImplementation(() => ({}));
  });

  test('issues a link with the normalized address', async () => {
    await post({ email: '  COACH@Example.com ' });
    expect(issueMagicLink).toHaveBeenCalledWith('coach@example.com', expect.anything());
  });

  test('a transport failure still answers 202, and does not leak the address', async () => {
    // Graph refusing, the identity endpoint unreachable, a database blip --
    // none may change the response. A 500 for a real address and a 202 for an
    // unknown one distinguishes them exactly as well as a message would, and
    // the whole contract of this route is that they are indistinguishable.
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line) => {
      logged.push(String(line));
    });
    (issueMagicLink as jest.Mock).mockRejectedValue(new Error('GRAPH_SEND_FAILED'));

    const response = await post({ email: 'coach@example.com' });

    expect(response.status).toBe(202);
    expect(logged.join(' ')).toContain('magic_link.issue_failed');
    // The log line reaches a log aggregator. The address must not.
    expect(logged.join(' ')).not.toContain('coach@example.com');
    spy.mockRestore();
  });

  test('the failure log carries the HTTP status when the error has one', async () => {
    // A staging send failed with GRAPH_SEND_FAILED and nothing else, when the
    // accompanying 403 would have said "this identity lacks Mail.Send"
    // outright. The error carried the status; the log discarded it.
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    const failure = Object.assign(new Error('GRAPH_SEND_FAILED'), { statusCode: 403 });
    (issueMagicLink as jest.Mock).mockRejectedValue(failure);

    await post({ email: 'coach@example.com' });

    expect(JSON.parse(logged[0])).toMatchObject({
      event: 'magic_link.issue_failed',
      error_code: 'GRAPH_SEND_FAILED',
      status_code: 403,
    });
    spy.mockRestore();
  });

  test('the failure log carries the Graph error code that disambiguates a 403', async () => {
    // 403 alone does not say whether the access policy refused the mailbox or
    // the token lacks Mail.Send. The error code does, and it is shape-checked
    // at the mailer so it cannot smuggle an address into this line.
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    const failure = Object.assign(new Error('GRAPH_SEND_FAILED'), {
      statusCode: 403,
      graphErrorCode: 'ErrorAccessDenied',
    });
    (issueMagicLink as jest.Mock).mockRejectedValue(failure);

    await post({ email: 'coach@example.com' });

    expect(JSON.parse(logged[0])).toMatchObject({
      status_code: 403,
      graph_error_code: 'ErrorAccessDenied',
    });
    spy.mockRestore();
  });

  test('a failure without a status logs null rather than inventing one', async () => {
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    (issueMagicLink as jest.Mock).mockRejectedValue(new Error('MISSING_PPBF_APP_ORIGIN'));

    await post({ email: 'coach@example.com' });

    expect(JSON.parse(logged[0]).status_code).toBeNull();
    expect(JSON.parse(logged[0]).graph_error_code).toBeNull();
    spy.mockRestore();
  });

  test('a rate-limited request never reaches issuance', async () => {
    refuseOn('magic_link_email:', false);
    await post({ email: 'coach@example.com' });
    expect(issueMagicLink).not.toHaveBeenCalled();
  });

  test('a malformed address never reaches issuance', async () => {
    await post({ email: 'not-an-address' });
    expect(issueMagicLink).not.toHaveBeenCalled();
  });

  test('answers 202 with the same body for an address that exists and one that does not', async () => {
    // The route cannot tell them apart and must not appear to. Both calls go
    // through the identical path; asserting byte-equal responses is the point.
    const known = await post({ email: 'coach@example.com' });
    const unknown = await post({ email: 'nobody-at-all@example.com' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual(await unknown.json());
  });

  test('the message never confirms the address has an account', async () => {
    const response = await post({ email: 'coach@example.com' });
    const payload = (await response.json()) as { message: string };
    // "If that address has an account" -- conditional, always.
    expect(payload.message).toMatch(/if that address has an account/i);
    expect(payload.message).not.toMatch(/\bsent\b|\bwe found\b|\byour account\b/i);
  });

  test('records an attempt even when the address is unknown', async () => {
    // Recording only real addresses would make "no rate-limit entry" a signal
    // that the address does not exist -- the leak this route exists to close.
    await post({ email: 'nobody-at-all@example.com' });
    expect(reserveAttempts).toHaveBeenCalledWith([
      'magic_link_email:nobody-at-all@example.com',
      'magic_link_ip:203.0.113.9',
    ]);
  });

  test('normalizes the address before keying the limiter', async () => {
    // Otherwise Coach@ and coach@ get independent budgets and the per-address
    // limit is trivially bypassed by varying case.
    await post({ email: '  COACH@Example.com ' });
    expect(reserveAttempts).toHaveBeenCalledWith(['magic_link_email:coach@example.com', 'magic_link_ip:203.0.113.9']);
  });

  test('refuses a malformed address with 400, without touching the limiter', async () => {
    const response = await post({ email: 'not-an-address' });
    expect(response.status).toBe(400);
    expect(reserveAttempts).not.toHaveBeenCalled();
  });

  test('refuses a missing body the same way', async () => {
    expect((await post({})).status).toBe(400);
  });

  test.each([
    ['per-address durable', () => refuseOn('magic_link_email:', true)],
    ['per-IP durable', () => refuseOn('magic_link_ip:', true)],
    ['volatile', () => refuseOn('magic_link_', false)],
  ])('%s limit returns 429', async (_label, arrange) => {
    arrange();
    const response = await post({ email: 'coach@example.com' });
    expect(response.status).toBe(429);
  });

  test('both limit axes give the identical 429 body', async () => {
    // A different message per axis tells the caller which limit they hit, and
    // a per-ADDRESS limit firing is itself a hint the address is worth probing.
    refuseOn('magic_link_email:', true);
    const byEmail = await (await post({ email: 'coach@example.com' })).json();

    refuseOn('magic_link_ip:', true);
    const byIp = await (await post({ email: 'coach@example.com' })).json();

    expect(byEmail).toEqual(byIp);
  });

  /**
   * THE ONE FAULT THAT IS NOT SWALLOWED. A site address no link can be built
   * on is a configuration fault, not a fact about any address: it is read
   * before the body and answered 503 for every caller alike. Everything
   * per-address stays swallowed and 202, as above.
   */
  describe('a site address that cannot carry a link', () => {
    const ADDRESSES: Array<[string, string]> = [
      ['an existing address', 'coach@example.com'],
      ['an address nobody has', 'nobody-at-all@example.com'],
      ['a malformed address', 'not-an-address'],
    ];

    test.each(ADDRESSES)('%s: answers 503, issues nothing, records no attempt', async (_label, email) => {
      const logged: string[] = [];
      const spy = jest.spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
      (magicLinkDependencies as jest.Mock).mockImplementation(() => {
        throw new Error('INVALID_PPBF_APP_ORIGIN:not_absolute_url');
      });

      const response = await post({ email });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Sign-in links are not available right now.' });
      expect(issueMagicLink).not.toHaveBeenCalled();
      expect(reserveAttempts).not.toHaveBeenCalled();
      expect(JSON.parse(logged[0])).toEqual({
        event: 'magic_link.config_invalid',
        error_type: 'Error',
        error_code: 'INVALID_PPBF_APP_ORIGIN:not_absolute_url',
      });
      expect(logged.join('\n')).not.toContain(email);
      spy.mockRestore();
    });

    test('the three answers are byte-equal: the fault says nothing about any address', async () => {
      (magicLinkDependencies as jest.Mock).mockImplementation(() => {
        throw new Error('MISSING_PPBF_APP_ORIGIN');
      });
      const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const bodies = await Promise.all(ADDRESSES.map(async ([, email]) => {
        const response = await post({ email });
        return `${response.status} ${JSON.stringify(await response.json())}`;
      }));

      expect(new Set(bodies).size).toBe(1);
      spy.mockRestore();
    });

    test('with a usable site address the route answers as it always did', async () => {
      (magicLinkDependencies as jest.Mock).mockImplementation(() => ({}));

      expect((await post({ email: 'coach@example.com' })).status).toBe(202);
      expect((await post({ email: 'nobody-at-all@example.com' })).status).toBe(202);
      // The address shape check is the route's own and unchanged: 400.
      expect((await post({ email: 'not-an-address' })).status).toBe(400);
      expect(issueMagicLink).toHaveBeenCalledTimes(2);
    });
  });
});
