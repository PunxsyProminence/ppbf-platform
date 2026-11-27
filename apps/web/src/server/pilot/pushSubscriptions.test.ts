import { createECDH, randomBytes } from 'node:crypto';

import { parseEndpointBody, parsePushBrowser, parsePushEndpoint, pushKeys } from './pushSubscriptions';

// The pure half of the web push store (lane W5-WP, WP-1b): what an endpoint,
// a browser's keys and the push settings must look like. The database half is
// pushSubscriptions.pg.test.ts.

function browserKeys() {
  return { p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}
const ENDPOINT = 'https://push.example.test/fcm/send/abc:APA91b-x_y?token=BQ%2bA=';

describe('parsePushEndpoint takes only an https push address on a plain DNS host', () => {
  test.each([
    [ENDPOINT],
    ['https://a.b-c.example.test/wpush/v2/gAAAAAB'],
    ['https://Push.Example.Test/x'],
  ])('takes %j', (endpoint) => {
    expect(parsePushEndpoint(endpoint)).toBe(endpoint);
  });

  // web-push 3.6.7 posts wherever url.parse points; each of these would reach
  // somewhere it must not, or parse differently in url.parse and new URL
  // (reviewer B on #2231).
  test.each([
    ['http://push.example.test/x'],
    ['https://:8443/x'],
    ['https://@/x'],
    ['https:///'],
    ['https://user:pw@127.0.0.1:5432/x'],
    ['https://[::1]:8443/x'],
    ['https://169.254.169.254/x'],
    ['https://0x7f000001/x'],
    ['https://fcm.googleapis.com\\@evil.example/x'],
    ['https://localhost/x'],
    ['https://push.example.test:443/x'],
    ["https://evil.example'.fcm.googleapis.com/x"],
    ['https://push.example.test/a\u0001b'],
    ['https://push.example.test'],
    ['https://push.example.test/x@y'],
    ['https://push.example.test/a b'],
    [`https://push.example.test/${'a'.repeat(2049 - 'https://push.example.test/'.length)}`],
    [42],
    [null],
  ])('refuses %j', (endpoint) => {
    expect(() => parsePushEndpoint(endpoint)).toThrow('endpoint must be an https push service address');
  });
});

describe('parsePushBrowser takes exactly what PushSubscription.toJSON gives', () => {
  test('a real P-256 key and a 16-byte secret, padding dropped', () => {
    const keys = browserKeys();
    expect(parsePushBrowser({ endpoint: ENDPOINT, keys: { p256dh: `${keys.p256dh}=`, auth: `${keys.auth}==` } })).toEqual({
      endpoint: ENDPOINT, p256dh: keys.p256dh, auth: keys.auth,
    });
  });

  test.each([
    ['an extra field', (k: ReturnType<typeof browserKeys>) => ({ endpoint: ENDPOINT, keys: k, expirationTime: null })],
    ['an account id', (k: ReturnType<typeof browserKeys>) => ({ endpoint: ENDPOINT, keys: k, account_id: 'someone-else' })],
    ['no keys', () => ({ endpoint: ENDPOINT })],
    ['an extra key field', (k: ReturnType<typeof browserKeys>) => ({ endpoint: ENDPOINT, keys: { ...k, extra: 'x' } })],
    ['a p256dh of 64 bytes', (k: ReturnType<typeof browserKeys>) => ({ endpoint: ENDPOINT, keys: { ...k, p256dh: k.p256dh.slice(2) } })],
    ['a p256dh in standard base64', (k: ReturnType<typeof browserKeys>) => ({ endpoint: ENDPOINT, keys: { ...k, p256dh: `+/${k.p256dh.slice(2)}` } })],
    ['an auth secret under 16 bytes', (k: ReturnType<typeof browserKeys>) => ({ endpoint: ENDPOINT, keys: { ...k, auth: k.auth.slice(2) } })],
    ['an auth secret over 128 characters', (k: ReturnType<typeof browserKeys>) => ({ endpoint: ENDPOINT, keys: { ...k, auth: 'A'.repeat(129) } })],
    ['an array', () => []],
    ['nothing', () => null],
  ])('refuses %s', (_label, make) => {
    expect(() => parsePushBrowser(make(browserKeys()))).toThrow();
  });

  test('a check or a removal takes exactly { endpoint }', () => {
    expect(parseEndpointBody({ endpoint: ENDPOINT })).toBe(ENDPOINT);
    expect(() => parseEndpointBody({ endpoint: ENDPOINT, account_id: 'x' })).toThrow('The body takes exactly: endpoint');
    expect(() => parseEndpointBody({})).toThrow('The body takes exactly: endpoint');
  });
});

describe('pushKeys: no push until all three settings are set as web-push 3.6.7 needs them (fail closed)', () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const good = {
    PPBF_WEB_PUSH_VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'),
    PPBF_WEB_PUSH_VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString('base64url'),
    PPBF_WEB_PUSH_SUBJECT: 'https://www.example.test/contact',
  };

  test('all three set and shaped: the public key, and only the public key', () => {
    const keys = pushKeys(good);
    expect(keys).toEqual({ publicKey: good.PPBF_WEB_PUSH_VAPID_PUBLIC_KEY });
    expect(JSON.stringify(keys)).not.toContain(good.PPBF_WEB_PUSH_VAPID_PRIVATE_KEY);
    expect(pushKeys({ ...good, PPBF_WEB_PUSH_SUBJECT: 'mailto:office@example.test' })).not.toBeNull();
  });

  test.each([
    ['nothing set', {}],
    ['no public key', { ...good, PPBF_WEB_PUSH_VAPID_PUBLIC_KEY: '' }],
    ['no private key', { ...good, PPBF_WEB_PUSH_VAPID_PRIVATE_KEY: '   ' }],
    ['no subject', { ...good, PPBF_WEB_PUSH_SUBJECT: undefined }],
    ['a public key of the wrong size', { ...good, PPBF_WEB_PUSH_VAPID_PUBLIC_KEY: good.PPBF_WEB_PUSH_VAPID_PUBLIC_KEY.slice(4) }],
    ['a private key of the wrong size', { ...good, PPBF_WEB_PUSH_VAPID_PRIVATE_KEY: `${good.PPBF_WEB_PUSH_VAPID_PRIVATE_KEY}AAAA` }],
    ['a key in standard base64', { ...good, PPBF_WEB_PUSH_VAPID_PUBLIC_KEY: `+${good.PPBF_WEB_PUSH_VAPID_PUBLIC_KEY.slice(1)}` }],
    ['a subject that is not https or mailto', { ...good, PPBF_WEB_PUSH_SUBJECT: 'http://www.example.test' }],
    ['a subject that is not a URL', { ...good, PPBF_WEB_PUSH_SUBJECT: 'the gym' }],
  ])('%s: not offered', (_label, env) => {
    expect(pushKeys(env)).toBeNull();
  });
});
