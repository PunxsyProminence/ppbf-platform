import crypto from 'node:crypto';

const OIDC_DISCOVERY_PATH = '/v2.0/.well-known/openid-configuration';
const OIDC_SCOPES = 'openid profile email';
const ALLOWED_JWT_ALGORITHMS = new Set(['RS256']);

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  issuer: string;
  jwks_uri: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface JwksResponse {
  keys?: Jwk[];
}

interface ClientConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  postLoginPath: string;
}

export function getMsOidcConfig(): ClientConfig {
  const tenantId = process.env.PPBF_MS_TENANT_ID?.trim() || '';
  const clientId = process.env.PPBF_MS_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.PPBF_MS_CLIENT_SECRET?.trim() || '';
  const callbackUrl = process.env.PPBF_MS_REDIRECT_URI?.trim() || '';
  const postLoginPath = process.env.PPBF_MS_POST_LOGIN_PATH?.trim() || '';

  if (!tenantId || !clientId || !clientSecret || !callbackUrl) {
    throw new Error('Missing Microsoft OIDC configuration');
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    callbackUrl,
    postLoginPath,
  };
}

export function createState(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function createNonce(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function createCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function createCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export async function fetchOidcDiscovery(tenantId: string): Promise<OidcDiscovery> {
  const issuerBase = `https://login.microsoftonline.com/${tenantId}`;
  const response = await fetch(`${issuerBase}${OIDC_DISCOVERY_PATH}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Failed to load Microsoft OIDC metadata');
  }
  return (await response.json()) as OidcDiscovery;
}

export function buildAuthorizeUrl(
  discovery: OidcDiscovery,
  config: ClientConfig,
  state: string,
  codeChallenge: string,
  nonce: string,
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', OIDC_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  // Force an interactive re-auth instead of silent SSO session reuse.
  url.searchParams.set('prompt', 'login');
  // Deliberately no max_age. When max_age is present Entra pins the id_token's
  // expiry to auth_time and clamps its lifetime to five minutes, so any sign-in
  // where the user spends longer than that on the Microsoft pages -- MFA
  // approval, the "Stay signed in?" step, or simply typing slowly -- arrives
  // back at the callback already expired and validateClaims correctly rejects
  // it as 'Expired token', bouncing the user to /login with a generic error.
  // The 'prompt' parameter above is what actually forces the fresh interactive
  // login; max_age added no security on top of it, only an invisible
  // five-minute stopwatch that intermittently locked users out.
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface TokenResponse {
  id_token?: string;
}

export async function exchangeCodeForIdToken(
  discovery: OidcDiscovery,
  config: ClientConfig,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.callbackUrl,
    code_verifier: codeVerifier,
    scope: OIDC_SCOPES,
  });

  const response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    cache: 'no-store',
  });

  if (!response.ok) {
    // Microsoft names the exact failure in the response body (invalid_client
    // for a stale secret, invalid_grant for a redirect_uri or PKCE mismatch).
    // Discarding it leaves an auth outage with no diagnosable cause. The body
    // carries error codes, never the client secret.
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`Failed to exchange authorization code (${response.status}): ${detail}`);
  }

  const tokens = (await response.json()) as TokenResponse;
  if (!tokens.id_token) {
    throw new Error('Missing id_token in token response');
  }

  return tokens.id_token;
}

interface MicrosoftClaims {
  aud?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  nonce?: string;
  oid?: string;
  preferred_username?: string;
  tid?: string;
  upn?: string;
  email?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

function decodeBase64UrlToBuffer(input: string): Buffer {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function decodeBase64Url(input: string): string {
  return decodeBase64UrlToBuffer(input).toString('utf-8');
}

function decodeJwtHeader(jwt: string): JwtHeader {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }
  try {
    return JSON.parse(decodeBase64Url(parts[0])) as JwtHeader;
  } catch {
    throw new Error('Unable to parse token header');
  }
}

export function decodeJwtPayload(jwt: string): MicrosoftClaims {
  const parts = jwt.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid token format');
  }
  try {
    return JSON.parse(decodeBase64Url(parts[1])) as MicrosoftClaims;
  } catch {
    throw new Error('Unable to parse token payload');
  }
}

export function validateBasicClaims(claims: MicrosoftClaims, config: ClientConfig): void {
  const now = Math.floor(Date.now() / 1000);

  if (!claims.aud || claims.aud !== config.clientId) {
    throw new Error('Invalid token audience');
  }
  if (!claims.tid || claims.tid !== config.tenantId) {
    throw new Error('Invalid tenant claim');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new Error('Expired token');
  }
}

function normalizeIssuer(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function validateClaims(claims: MicrosoftClaims, config: ClientConfig, issuer: string, expectedNonce: string): void {
  const now = Math.floor(Date.now() / 1000);

  if (!claims.iss || normalizeIssuer(claims.iss) !== normalizeIssuer(issuer)) {
    throw new Error('Invalid token issuer');
  }

  if (!claims.aud || claims.aud !== config.clientId) {
    throw new Error('Invalid token audience');
  }

  if (!claims.tid || claims.tid !== config.tenantId) {
    throw new Error('Invalid tenant claim');
  }

  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new Error('Expired token');
  }

  if (typeof claims.nbf === 'number' && claims.nbf > now) {
    throw new Error('Token not yet valid');
  }

  if (!claims.nonce || claims.nonce !== expectedNonce) {
    throw new Error('Invalid token nonce');
  }
}

async function fetchJwks(jwksUri: string): Promise<Jwk[]> {
  const response = await fetch(jwksUri, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Failed to load Microsoft JWKS');
  }
  const payload = (await response.json()) as JwksResponse;
  if (!Array.isArray(payload.keys)) {
    throw new TypeError('Invalid JWKS payload');
  }
  return payload.keys;
}

function verifyJwtSignature(jwt: string, key: Jwk, alg: string): void {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  if (!key.n || !key.e || key.kty !== 'RSA') {
    throw new Error('Invalid JWKS key');
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = decodeBase64UrlToBuffer(parts[2]);
  const publicKey = crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: key.n,
      e: key.e,
    },
    format: 'jwk',
  });

  if (alg !== 'RS256') {
    throw new Error('Unsupported token algorithm');
  }

  const valid = crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf-8'), publicKey, signature);
  if (!valid) {
    throw new Error('Invalid token signature');
  }
}

export async function verifyAndDecodeMicrosoftIdToken(params: {
  idToken: string;
  discovery: OidcDiscovery;
  config: ClientConfig;
  expectedNonce: string;
}): Promise<MicrosoftClaims> {
  const { idToken, discovery, config, expectedNonce } = params;
  const header = decodeJwtHeader(idToken);
  if (!header.alg || !ALLOWED_JWT_ALGORITHMS.has(header.alg)) {
    throw new Error('Unsupported token algorithm');
  }
  if (!header.kid) {
    throw new Error('Missing token key id');
  }

  const jwks = await fetchJwks(discovery.jwks_uri);
  const signingKey = jwks.find((item) => item.kid === header.kid);
  if (!signingKey) {
    throw new Error('No matching JWKS signing key');
  }

  verifyJwtSignature(idToken, signingKey, header.alg);

  const claims = decodeJwtPayload(idToken);
  validateClaims(claims, config, discovery.issuer, expectedNonce);
  return claims;
}

export function resolveMicrosoftIdentityEmail(claims: MicrosoftClaims): string {
  const raw = claims.email || claims.preferred_username || claims.upn || '';
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new Error('No Microsoft email/UPN claim available');
  }
  return normalized;
}
