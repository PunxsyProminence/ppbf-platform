/**
 * The push transport (lane W5-WP, WP-2b-2a): a push is posted only to a public
 * address, checked by the connection's own lookup; the whole request is cut
 * off at its time limit; and only so much of an answer is read. The posts here
 * go to a local plain-HTTP server (http.request in place of https.request), or
 * are refused before any connection.
 */

import dns from 'node:dns';
import http from 'node:http';
import type { LookupFunction } from 'node:net';

import crypto from 'node:crypto';

import { generateRequestDetails, type PushRequestDetails } from 'web-push';

import {
  isPublicAddress,
  postPushRequest,
  PUSH_POST_DEFAULTS,
  publicOnlyLookup,
  PushPostError,
} from './pushTransport';

type Entry = { address: string; family: number };

/** A resolver that answers every name with these addresses. */
function resolverOf(entries: Entry[] | Error) {
  return (_hostname: string, _options: dns.LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => {
    if (entries instanceof Error) callback(entries, []);
    else callback(null, entries);
  };
}

function lookUp(lookup: LookupFunction, all: boolean): Promise<{ error: Error | null; result: unknown }> {
  return new Promise((resolve) => {
    lookup('push.example.test', { all } as never, (error: Error | null, address: unknown, family?: unknown) => {
      resolve({ error, result: all ? address : [address, family] });
    });
  });
}

/** Every name resolves to the local test server: no guard, so the transport's other limits can be tested. */
const toLocalServer: LookupFunction = (_hostname, options, callback) => {
  dns.lookup('127.0.0.1', options, callback as never);
};

function details(endpoint: string): PushRequestDetails {
  return {
    method: 'POST',
    endpoint,
    headers: { TTL: 60, Topic: 'open-the-app', 'Content-Type': 'application/octet-stream' },
    body: Buffer.from([1, 2, 3, 4]),
  };
}

async function withServer(
  handler: http.RequestListener,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('test bug: no port');
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('isPublicAddress', () => {
  test.each([
    '8.8.8.8', '1.1.1.1', '142.250.1.1', '17.253.1.1', '2606:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8',
  ])('%s is public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  test.each([
    '0.0.0.0', '10.1.1.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8',
    '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::10.0.0.1', '64:ff9b::a00:1',
    '64:ff9b:1::1', '100::1', '2001::1', '2001:db8::1', '2002:a00:1::', 'fc00::1', 'fd12::1', 'fe80::1', 'febf::1',
    'ff02::1', 'push.example.test', '',
  ])('%s is not', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('publicOnlyLookup', () => {
  test('a host whose every address is public resolves, one address or all of them', async () => {
    const lookup = publicOnlyLookup(resolverOf([{ address: '8.8.8.8', family: 4 }, { address: '2606:4700::1111', family: 6 }]));
    expect(await lookUp(lookup, false)).toEqual({ error: null, result: ['8.8.8.8', 4] });
    expect(await lookUp(lookup, true)).toEqual({
      error: null,
      result: [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700::1111', family: 6 }],
    });
  });

  test.each([
    ['one private address among public ones', [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }]],
    ['a loopback address', [{ address: '::1', family: 6 }]],
    ['the cloud metadata address', [{ address: '169.254.169.254', family: 4 }]],
    ['no address at all', []],
  ])('%s: the host is refused', async (_label, entries) => {
    const { error } = await lookUp(publicOnlyLookup(resolverOf(entries)), false);
    expect(error).toBeInstanceOf(PushPostError);
    expect((error as PushPostError).code).toBe('PUSH_HOST_NOT_PUBLIC');
  });

  test("the resolver's own error is passed on", async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect((await lookUp(publicOnlyLookup(resolverOf(failure)), false)).error).toBe(failure);
  });
});

describe('postPushRequest', () => {
  test('as deployed, a push to a host that resolves to loopback is refused before any connection', async () => {
    await expect(postPushRequest(details('https://localhost/send/x'), { ...PUSH_POST_DEFAULTS, timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'PUSH_HOST_NOT_PUBLIC' });
  });

  test('the connection itself uses the lookup: a name resolving to a private address never reaches the server', async () => {
    let reached = 0;
    await withServer((_request, response) => { reached += 1; response.end(); }, async (port) => {
      const options = {
        ...PUSH_POST_DEFAULTS,
        request: http.request,
        timeoutMs: 5_000,
        lookup: publicOnlyLookup(resolverOf([{ address: '127.0.0.1', family: 4 }])),
      };
      await expect(postPushRequest(details(`http://push.example.test:${port}/send/x`), options))
        .rejects.toMatchObject({ code: 'PUSH_HOST_NOT_PUBLIC' });
    });
    expect(reached).toBe(0);
  });

  test('a push arrives as built (method, path, headers, body) and its status comes back', async () => {
    const seen: { method?: string; url?: string; topic?: string; ttl?: string; body?: Buffer } = {};
    await withServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        Object.assign(seen, {
          method: request.method,
          url: request.url,
          topic: request.headers.topic,
          ttl: request.headers.ttl,
          body: Buffer.concat(chunks),
        });
        response.statusCode = 201;
        response.end();
      });
    }, async (port) => {
      const options = { ...PUSH_POST_DEFAULTS, request: http.request, lookup: toLocalServer, timeoutMs: 5_000 };
      expect(await postPushRequest(details(`http://push.example.test:${port}/send/x?q=1`), options)).toBe(201);
    });
    expect(seen).toEqual({ method: 'POST', url: '/send/x?q=1', topic: 'open-the-app', ttl: '60', body: Buffer.from([1, 2, 3, 4]) });
  });

  test('a request web-push 3.6.7 builds (encrypted, VAPID-signed) is posted as built', async () => {
    const vapid = crypto.createECDH('prime256v1');
    vapid.generateKeys();
    const browser = crypto.createECDH('prime256v1');
    browser.generateKeys();
    const publicKey = vapid.getPublicKey().toString('base64url');
    const seen: { authorization?: string; encoding?: string; length?: string; body?: Buffer } = {};
    await withServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        Object.assign(seen, {
          authorization: request.headers.authorization,
          encoding: request.headers['content-encoding'],
          length: request.headers['content-length'],
          body: Buffer.concat(chunks),
        });
        response.statusCode = 201;
        response.end();
      });
    }, async (port) => {
      const built = generateRequestDetails(
        {
          endpoint: `http://push.example.test:${port}/send/x`,
          keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
        },
        'open',
        {
          vapidDetails: {
            subject: 'mailto:push@example.test',
            publicKey,
            privateKey: Buffer.from(vapid.getPrivateKey('hex').padStart(64, '0'), 'hex').toString('base64url'),
          },
          TTL: 60,
          urgency: 'normal',
          topic: 'open-the-app',
        },
      );
      const options = { ...PUSH_POST_DEFAULTS, request: http.request, lookup: toLocalServer, timeoutMs: 5_000 };
      expect(await postPushRequest(built, options)).toBe(201);
      expect(seen.body?.equals(built.body as Buffer)).toBe(true);
    });
    expect(seen.authorization).toMatch(new RegExp(`^vapid t=[A-Za-z0-9_.-]+, k=${publicKey}$`));
    expect(seen.encoding).toBe('aes128gcm');
    expect(Number(seen.length)).toBe(seen.body?.length);
  });

  test('an answer longer than the limit is cut off and refused', async () => {
    await withServer((_request, response) => {
      response.statusCode = 201;
      response.end(Buffer.alloc(PUSH_POST_DEFAULTS.maxBytes + 1024, 120));
    }, async (port) => {
      const options = { ...PUSH_POST_DEFAULTS, request: http.request, lookup: toLocalServer, timeoutMs: 5_000 };
      await expect(postPushRequest(details(`http://push.example.test:${port}/send/x`), options))
        .rejects.toMatchObject({ code: 'PUSH_ANSWER_TOO_LONG' });
    });
  });

  test('a server that answers too slowly is cut off at the time limit, even while it trickles', async () => {
    await withServer((_request, response) => {
      // A byte every 100 ms: an idle timeout alone would never fire.
      response.writeHead(201);
      const drip = setInterval(() => response.write('x'), 100);
      response.on('close', () => clearInterval(drip));
    }, async (port) => {
      const options = { ...PUSH_POST_DEFAULTS, request: http.request, lookup: toLocalServer, timeoutMs: 500 };
      const started = Date.now();
      await expect(postPushRequest(details(`http://push.example.test:${port}/send/x`), options))
        .rejects.toMatchObject({ code: 'PUSH_TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });
});
