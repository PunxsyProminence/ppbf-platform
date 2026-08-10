/**
 * Gets a Microsoft Graph access token from the container app's managed
 * identity.
 *
 * NO SECRET ANYWHERE
 *
 * Azure Container Apps injects IDENTITY_ENDPOINT and IDENTITY_HEADER into the
 * container. The endpoint is only reachable from inside that container, and
 * the header proves the caller is the app rather than something else on the
 * host. There is no client secret to store, rotate, leak, or find in a
 * repository six months from now -- which, after a week spent removing exactly
 * those, is the whole reason this platform authenticates to Azure this way.
 *
 * The token this returns is only useful for sending mail as
 * Admin@punxsyprominence.org: Mail.Send is restricted to that one mailbox by
 * an Exchange Application Access Policy, verified Denied against three other
 * real mailboxes before the permission was granted.
 */

const GRAPH_RESOURCE = 'https://graph.microsoft.com';
const IDENTITY_API_VERSION = '2019-08-01';

export interface TokenFetchDependencies {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  identityEndpoint: string | undefined;
  identityHeader: string | undefined;
  now: () => number;
}

export class ManagedIdentityError extends Error {
  constructor(reason: string, readonly statusCode?: number) {
    // Reason only. The identity endpoint's error bodies can echo the header
    // value, and that header is the credential.
    super(reason);
    this.name = 'ManagedIdentityError';
  }
}

interface CachedToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

let cache: CachedToken | null = null;

/** Discards the cached token. Tests call this; nothing else needs to. */
export function resetTokenCache(): void {
  cache = null;
}

/**
 * Refresh this long before actual expiry.
 *
 * A token that passes the check and then expires mid-request fails the send
 * with a 401 that looks like a permission problem, which is a genuinely
 * confusing thing to debug at 2am. Graph tokens last an hour; five minutes of
 * headroom costs nothing.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** How long a token with no usable expiry stays usable, after the margin. */
const FALLBACK_USABLE_MS = 5 * 60 * 1000;

export async function getGraphAccessToken(
  dependencies: TokenFetchDependencies,
): Promise<string> {
  const { fetchImpl, identityEndpoint, identityHeader, now } = dependencies;

  if (cache && cache.expiresAt - REFRESH_MARGIN_MS > now()) {
    return cache.token;
  }

  if (!identityEndpoint || !identityHeader) {
    // Running outside a container app -- locally, or in a container that was
    // never given an identity. Named distinctly so it is not mistaken for a
    // permissions failure.
    throw new ManagedIdentityError('NO_MANAGED_IDENTITY_AVAILABLE');
  }

  const url = `${identityEndpoint}?resource=${encodeURIComponent(GRAPH_RESOURCE)}&api-version=${IDENTITY_API_VERSION}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-IDENTITY-HEADER': identityHeader },
    });
  } catch {
    // The endpoint is link-local. A network failure here means the platform,
    // not the internet.
    throw new ManagedIdentityError('IDENTITY_ENDPOINT_UNREACHABLE');
  }

  if (!response.ok) {
    throw new ManagedIdentityError('IDENTITY_TOKEN_REFUSED', response.status);
  }

  const payload = (await response.json().catch(() => null)) as
    | { access_token?: string; expires_on?: string | number }
    | null;

  if (!payload?.access_token) {
    throw new ManagedIdentityError('IDENTITY_TOKEN_MALFORMED');
  }

  // expires_on is seconds since epoch, and arrives as a string from some API
  // versions and a number from others. Treating a string as milliseconds would
  // put expiry in 1970 and refetch on every single send.
  const expiresOnSeconds = Number(payload.expires_on);
  const expiresAt = Number.isFinite(expiresOnSeconds) && expiresOnSeconds > 0
    ? expiresOnSeconds * 1000
    // No usable expiry: cache conservatively rather than trusting it for an
    // hour. The margin is added on top deliberately -- a fallback of exactly
    // REFRESH_MARGIN_MS would be subtracted straight back out by the staleness
    // check above, caching for precisely zero seconds and refetching a token
    // on every single message. That is what the first version did, and the
    // test below is what noticed.
    : now() + REFRESH_MARGIN_MS + FALLBACK_USABLE_MS;

  cache = { token: payload.access_token, expiresAt };
  return payload.access_token;
}

/** Binds the provider to the real runtime. */
export function graphTokenProvider(): () => Promise<string> {
  return () =>
    getGraphAccessToken({
      fetchImpl: fetch,
      identityEndpoint: process.env.IDENTITY_ENDPOINT,
      identityHeader: process.env.IDENTITY_HEADER,
      now: () => Date.now(),
    });
}
