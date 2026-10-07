import crypto from 'crypto';

import { resolveMicrosoftIdentityObject, verifyAndDecodeMicrosoftIdToken } from '@/src/server/pilot/federatedAuth';

function toBase64Url(value: Buffer | string): string {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf-8');
  return input
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(params: {
  privateKeyPem: string;
  kid: string;
  payload: Record<string, unknown>;
  alg?: string;
}): string {
  const header = {
    alg: params.alg || 'RS256',
    typ: 'JWT',
    kid: params.kid,
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(params.payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf-8'), params.privateKeyPem);
  return `${signingInput}.${toBase64Url(signature)}`;
}

describe('verifyAndDecodeMicrosoftIdToken', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('rejects token with wrong audience', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ kid: 'kid-1', kty: 'RSA', n: jwk.n, e: jwk.e }] }),
    } as Response);

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      kid: 'kid-1',
      payload: {
        aud: 'wrong-client',
        tid: 'tenant-1',
        iss: 'https://login.microsoftonline.com/tenant-1/v2.0',
        exp: now + 600,
        nbf: now - 30,
        nonce: 'nonce-1',
        preferred_username: 'admin@punxsyprominence.org',
      },
    });

    await expect(
      verifyAndDecodeMicrosoftIdToken({
        idToken: token,
        discovery: {
          authorization_endpoint: '',
          token_endpoint: '',
          issuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
          jwks_uri: 'https://example.test/keys',
        },
        config: {
          tenantId: 'tenant-1',
          clientId: 'client-1',
          clientSecret: 'secret',
          callbackUrl: 'https://app.test/callback',
          postLoginPath: '',
        },
        expectedNonce: 'nonce-1',
      }),
    ).rejects.toThrow('Invalid token audience');
  });

  test('rejects expired token', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ kid: 'kid-2', kty: 'RSA', n: jwk.n, e: jwk.e }] }),
    } as Response);

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      kid: 'kid-2',
      payload: {
        aud: 'client-1',
        tid: 'tenant-1',
        iss: 'https://login.microsoftonline.com/tenant-1/v2.0',
        exp: now - 5,
        nonce: 'nonce-2',
      },
    });

    await expect(
      verifyAndDecodeMicrosoftIdToken({
        idToken: token,
        discovery: {
          authorization_endpoint: '',
          token_endpoint: '',
          issuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
          jwks_uri: 'https://example.test/keys',
        },
        config: {
          tenantId: 'tenant-1',
          clientId: 'client-1',
          clientSecret: 'secret',
          callbackUrl: 'https://app.test/callback',
          postLoginPath: '',
        },
        expectedNonce: 'nonce-2',
      }),
    ).rejects.toThrow('Expired token');
  });

  test('rejects invalid signature', async () => {
    const signingPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = wrongPair.publicKey.export({ format: 'jwk' }) as JsonWebKey;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ kid: 'kid-3', kty: 'RSA', n: jwk.n, e: jwk.e }] }),
    } as Response);

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({
      privateKeyPem: signingPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      kid: 'kid-3',
      payload: {
        aud: 'client-1',
        tid: 'tenant-1',
        iss: 'https://login.microsoftonline.com/tenant-1/v2.0',
        exp: now + 600,
        nonce: 'nonce-3',
      },
    });

    await expect(
      verifyAndDecodeMicrosoftIdToken({
        idToken: token,
        discovery: {
          authorization_endpoint: '',
          token_endpoint: '',
          issuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
          jwks_uri: 'https://example.test/keys',
        },
        config: {
          tenantId: 'tenant-1',
          clientId: 'client-1',
          clientSecret: 'secret',
          callbackUrl: 'https://app.test/callback',
          postLoginPath: '',
        },
        expectedNonce: 'nonce-3',
      }),
    ).rejects.toThrow('Invalid token signature');
  });
});

// CL-A19: the sign-in binds to oid + tid, so a token missing either is refused
// rather than falling back to the email alone.
describe('resolveMicrosoftIdentityObject', () => {
  test('returns the oid and tid of a token that carries both', () => {
    expect(resolveMicrosoftIdentityObject({ oid: ' oid-1 ', tid: 'tenant-1', email: 'a@example.com' }))
      .toEqual({ objectId: 'oid-1', tenantId: 'tenant-1' });
  });

  test.each([
    ['no oid', { tid: 'tenant-1', email: 'a@example.com' }],
    ['a blank oid', { oid: '  ', tid: 'tenant-1' }],
    ['no tid', { oid: 'oid-1' }],
    ['a non-string oid', { oid: 42 as unknown as string, tid: 'tenant-1' }],
  ])('refuses a token with %s', (_label, claims) => {
    expect(() => resolveMicrosoftIdentityObject(claims)).toThrow('No Microsoft object id / tenant claim available');
  });
});
