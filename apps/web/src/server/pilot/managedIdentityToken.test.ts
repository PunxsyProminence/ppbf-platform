import {
  getGraphAccessToken,
  ManagedIdentityError,
  resetTokenCache,
  type TokenFetchDependencies,
} from './managedIdentityToken';

const NOW = 1_800_000_000_000; // fixed epoch ms

function tokenResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

function deps(overrides: Partial<TokenFetchDependencies> = {}): TokenFetchDependencies {
  return {
    fetchImpl: async () =>
      tokenResponse({ access_token: 'graph-token', expires_on: String((NOW + 3_600_000) / 1000) }),
    identityEndpoint: 'http://localhost:42356/msi/token',
    identityHeader: 'header-secret',
    now: () => NOW,
    ...overrides,
  };
}

describe('managed identity token', () => {
  beforeEach(() => resetTokenCache());

  test('requests a Graph token from the injected identity endpoint', async () => {
    let called = '';
    let headers: Record<string, string> = {};
    const token = await getGraphAccessToken(
      deps({
        fetchImpl: async (url, init) => {
          called = url;
          headers = (init?.headers ?? {}) as Record<string, string>;
          return tokenResponse({ access_token: 'graph-token', expires_on: String((NOW + 3_600_000) / 1000) });
        },
      }),
    );

    expect(token).toBe('graph-token');
    expect(called).toContain('resource=https%3A%2F%2Fgraph.microsoft.com');
    expect(called).toContain('api-version=2019-08-01');
    expect(headers['X-IDENTITY-HEADER']).toBe('header-secret');
  });

  test('caches the token instead of refetching on every send', async () => {
    let calls = 0;
    const d = deps({
      fetchImpl: async () => {
        calls += 1;
        return tokenResponse({ access_token: 'graph-token', expires_on: String((NOW + 3_600_000) / 1000) });
      },
    });
    await getGraphAccessToken(d);
    await getGraphAccessToken(d);
    await getGraphAccessToken(d);
    expect(calls).toBe(1);
  });

  test('refetches before expiry rather than at it', async () => {
    // A token that passes the check and then expires mid-request fails the
    // send with a 401 that looks exactly like a permissions problem.
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return tokenResponse({ access_token: `token-${calls}`, expires_on: String((NOW + 3_600_000) / 1000) });
    };

    await getGraphAccessToken(deps({ fetchImpl }));
    expect(calls).toBe(1);

    // Four minutes before expiry: inside the five-minute margin, so refetch.
    const nearExpiry = NOW + 3_600_000 - 4 * 60 * 1000;
    const second = await getGraphAccessToken(deps({ fetchImpl, now: () => nearExpiry }));
    expect(calls).toBe(2);
    expect(second).toBe('token-2');
  });

  test('treats expires_on as SECONDS whether it arrives as string or number', async () => {
    // Some API versions send a string, some a number. Reading either as
    // milliseconds puts expiry in 1970 and refetches on every single message.
    for (const expires_on of [String((NOW + 3_600_000) / 1000), (NOW + 3_600_000) / 1000]) {
      resetTokenCache();
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return tokenResponse({ access_token: 'graph-token', expires_on });
      };
      await getGraphAccessToken(deps({ fetchImpl }));
      await getGraphAccessToken(deps({ fetchImpl }));
      expect(calls).toBe(1);
    }
  });

  test('falls back to a short cache when expiry is missing or unusable', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return tokenResponse({ access_token: 'graph-token' });
    };
    await getGraphAccessToken(deps({ fetchImpl }));
    // Still inside the conservative five-minute window.
    await getGraphAccessToken(deps({ fetchImpl, now: () => NOW + 60_000 }));
    expect(calls).toBe(1);
  });

  test('names the no-identity case distinctly from a permission failure', async () => {
    // Running locally, or in a container that was never given an identity.
    await expect(getGraphAccessToken(deps({ identityEndpoint: undefined })))
      .rejects.toThrow('NO_MANAGED_IDENTITY_AVAILABLE');
    await expect(getGraphAccessToken(deps({ identityHeader: undefined })))
      .rejects.toThrow('NO_MANAGED_IDENTITY_AVAILABLE');
  });

  test('a refusal carries the status and never the response body', async () => {
    // The endpoint echoes the identity header in some error bodies, and that
    // header IS the credential.
    let thrown: ManagedIdentityError | undefined;
    try {
      await getGraphAccessToken(
        deps({
          fetchImpl: async () =>
            tokenResponse({ error: 'header-secret was rejected' }, false, 403),
        }),
      );
    } catch (error) {
      thrown = error as ManagedIdentityError;
    }
    expect(thrown?.message).toBe('IDENTITY_TOKEN_REFUSED');
    expect(thrown?.statusCode).toBe(403);
    expect(JSON.stringify(thrown)).not.toContain('header-secret');
  });

  test('an unreachable endpoint is named as such', async () => {
    await expect(
      getGraphAccessToken(deps({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })),
    ).rejects.toThrow('IDENTITY_ENDPOINT_UNREACHABLE');
  });

  test('a malformed payload is refused rather than cached', async () => {
    await expect(
      getGraphAccessToken(deps({ fetchImpl: async () => tokenResponse({ nope: true }) })),
    ).rejects.toThrow('IDENTITY_TOKEN_MALFORMED');

    // And nothing was cached, so the next call tries again.
    let calls = 0;
    await getGraphAccessToken(
      deps({
        fetchImpl: async () => {
          calls += 1;
          return tokenResponse({ access_token: 'graph-token', expires_on: String((NOW + 3_600_000) / 1000) });
        },
      }),
    );
    expect(calls).toBe(1);
  });
});
