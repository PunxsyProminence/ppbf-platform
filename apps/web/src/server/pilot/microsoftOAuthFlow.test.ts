import {
  hashStateForReplayGuard,
  resolveCanonicalAuthStartRedirect,
  resolveRequestProtocol,
  resolvePublicOrigin,
  shouldUseSecureCookie,
  validateOAuthState,
} from '@/src/server/pilot/microsoftOAuthFlow';

describe('microsoftOAuthFlow', () => {
  test('matching state succeeds', () => {
    const result = validateOAuthState({
      queryState: 'state-123',
      code: 'code-abc',
      expectedState: 'state-123',
      codeVerifier: 'verifier-xyz',
      expectedNonce: 'nonce-123',
      issuedAtEpochSeconds: 1_000,
      usedStateHash: '',
      nowEpochSeconds: 1_100,
      ttlSeconds: 600,
    });

    expect(result).toEqual({ ok: true });
  });

  test('mismatched state fails', () => {
    const result = validateOAuthState({
      queryState: 'state-a',
      code: 'code-abc',
      expectedState: 'state-b',
      codeVerifier: 'verifier-xyz',
      expectedNonce: 'nonce-123',
      issuedAtEpochSeconds: 1_000,
      usedStateHash: '',
      nowEpochSeconds: 1_100,
      ttlSeconds: 600,
    });

    expect(result).toEqual({ ok: false, reason: 'mismatched-state' });
  });

  test('missing state fails', () => {
    const result = validateOAuthState({
      queryState: '',
      code: 'code-abc',
      expectedState: 'state-b',
      codeVerifier: 'verifier-xyz',
      expectedNonce: 'nonce-123',
      issuedAtEpochSeconds: 1_000,
      usedStateHash: '',
      nowEpochSeconds: 1_100,
      ttlSeconds: 600,
    });

    expect(result).toEqual({ ok: false, reason: 'missing-authorization-response' });
  });

  test('missing state cookie/session fails', () => {
    const result = validateOAuthState({
      queryState: 'state-abc',
      code: 'code-abc',
      expectedState: '',
      codeVerifier: 'verifier-xyz',
      expectedNonce: 'nonce-123',
      issuedAtEpochSeconds: 1_000,
      usedStateHash: '',
      nowEpochSeconds: 1_100,
      ttlSeconds: 600,
    });

    expect(result).toEqual({ ok: false, reason: 'missing-cookie-state' });
  });

  test('expired state fails', () => {
    const result = validateOAuthState({
      queryState: 'state-abc',
      code: 'code-abc',
      expectedState: 'state-abc',
      codeVerifier: 'verifier-xyz',
      expectedNonce: 'nonce-123',
      issuedAtEpochSeconds: 1_000,
      usedStateHash: '',
      nowEpochSeconds: 1_701,
      ttlSeconds: 600,
    });

    expect(result).toEqual({ ok: false, reason: 'expired-state' });
  });

  test('reused callback fails when state replay guard cookie matches', () => {
    const state = 'state-abc';
    const result = validateOAuthState({
      queryState: state,
      code: 'code-abc',
      expectedState: state,
      codeVerifier: 'verifier-xyz',
      expectedNonce: 'nonce-123',
      issuedAtEpochSeconds: 1_000,
      usedStateHash: hashStateForReplayGuard(state),
      nowEpochSeconds: 1_100,
      ttlSeconds: 600,
    });

    expect(result).toEqual({ ok: false, reason: 'reused-state' });
  });

  test('duplicate login attempts behave predictably (first callback fails, second succeeds)', () => {
    const firstState = 'state-first';
    const secondState = 'state-second';

    const firstAttemptCallback = validateOAuthState({
      queryState: firstState,
      code: 'code-1',
      expectedState: secondState,
      codeVerifier: 'verifier-xyz',
      expectedNonce: 'nonce-123',
      issuedAtEpochSeconds: 1_000,
      usedStateHash: '',
      nowEpochSeconds: 1_100,
      ttlSeconds: 600,
    });

    const secondAttemptCallback = validateOAuthState({
      queryState: secondState,
      code: 'code-2',
      expectedState: secondState,
      codeVerifier: 'verifier-xyz',
      expectedNonce: 'nonce-123',
      issuedAtEpochSeconds: 1_000,
      usedStateHash: '',
      nowEpochSeconds: 1_100,
      ttlSeconds: 600,
    });

    expect(firstAttemptCallback).toEqual({ ok: false, reason: 'mismatched-state' });
    expect(secondAttemptCallback).toEqual({ ok: true });
  });

  test('localhost development flow uses insecure cookies over http', () => {
    expect(
      shouldUseSecureCookie({
        nextUrlProtocol: 'http:',
        forwardedProtoHeader: null,
        nodeEnv: 'development',
      }),
    ).toBe(false);
  });

  test('production https flow uses secure cookies', () => {
    expect(
      shouldUseSecureCookie({
        nextUrlProtocol: 'https:',
        forwardedProtoHeader: null,
        nodeEnv: 'production',
      }),
    ).toBe(true);
  });

  test('reverse-proxy forwarded protocol is honored', () => {
    expect(
      resolveRequestProtocol({
        nextUrlProtocol: 'http:',
        forwardedProtoHeader: 'https',
      }),
    ).toBe('https');
  });

  test('azure or production canonical-domain behavior enforces callback-origin start route', () => {
    const redirect = resolveCanonicalAuthStartRedirect({
      requestUrl: 'https://app-example.example-env.eastus.azurecontainerapps.io/api/pilot/auth/microsoft/start',
      callbackUrl: 'https://www.punxsyprominence.org/api/pilot/auth/microsoft/callback',
      startPathname: '/api/pilot/auth/microsoft/start',
    });

    expect(redirect).toBe('https://www.punxsyprominence.org/api/pilot/auth/microsoft/start');
  });

  test('localhost callback origin does not trigger canonical redirect', () => {
    const redirect = resolveCanonicalAuthStartRedirect({
      requestUrl: 'http://localhost:3000/api/pilot/auth/microsoft/start',
      callbackUrl: 'http://localhost:3000/api/pilot/auth/microsoft/callback',
      startPathname: '/api/pilot/auth/microsoft/start',
    });

    expect(redirect).toBeNull();
  });

  test('forwarded host determines the public origin for auth redirects', () => {
    expect(
      resolvePublicOrigin({
        requestUrl: 'http://0.0.0.0:3000/api/pilot/auth/microsoft/callback',
        forwardedHostHeader: 'app-example.example-env.eastus.azurecontainerapps.io',
        forwardedProtoHeader: 'https',
        fallbackOrigin: 'https://www.punxsyprominence.org',
      }),
    ).toBe('https://app-example.example-env.eastus.azurecontainerapps.io');
  });
});
