import crypto from 'node:crypto';

const STATE_TTL_SECONDS = 10 * 60;

export const MICROSOFT_AUTH_STATE_COOKIE = 'ppbf_ms_auth_state';
export const MICROSOFT_AUTH_VERIFIER_COOKIE = 'ppbf_ms_auth_verifier';
export const MICROSOFT_AUTH_NONCE_COOKIE = 'ppbf_ms_auth_nonce';
export const MICROSOFT_AUTH_ISSUED_AT_COOKIE = 'ppbf_ms_auth_issued_at';
export const MICROSOFT_AUTH_USED_STATE_COOKIE = 'ppbf_ms_auth_used_state';

export type OAuthStateFailureReason =
  | 'missing-authorization-response'
  | 'missing-cookie-state'
  | 'mismatched-state'
  | 'missing-code-verifier'
  | 'missing-nonce'
  | 'missing-issued-at'
  | 'expired-state'
  | 'reused-state';

export function hashStateForReplayGuard(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex');
}

export function fingerprintValue(value: string): string {
  if (!value) {
    return 'empty';
  }
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function shouldEmitAuthDiagnostics(): boolean {
  return process.env.PPBF_AUTH_DIAGNOSTICS?.trim() === 'true';
}

function stripProtocolSuffix(value: string): string {
  return value.endsWith(':') ? value.slice(0, -1) : value;
}

export function resolveRequestProtocol(input: {
  nextUrlProtocol: string;
  forwardedProtoHeader?: string | null;
}): 'http' | 'https' {
  const forwarded = input.forwardedProtoHeader?.split(',')[0]?.trim().toLowerCase();
  if (forwarded === 'https') {
    return 'https';
  }
  if (forwarded === 'http') {
    return 'http';
  }

  return stripProtocolSuffix(input.nextUrlProtocol).toLowerCase() === 'https' ? 'https' : 'http';
}

export function shouldUseSecureCookie(input: {
  nextUrlProtocol: string;
  forwardedProtoHeader?: string | null;
  nodeEnv?: string;
}): boolean {
  if (input.nodeEnv === 'production') {
    return true;
  }

  return resolveRequestProtocol(input) === 'https';
}

export function resolveCanonicalAuthStartRedirect(input: {
  requestUrl: string;
  callbackUrl: string;
  startPathname: string;
}): string | null {
  const requestUrl = new URL(input.requestUrl);
  const callbackUrl = new URL(input.callbackUrl);

  if (requestUrl.origin === callbackUrl.origin) {
    return null;
  }

  return new URL(input.startPathname, callbackUrl.origin).toString();
}

export function validateOAuthState(input: {
  queryState: string;
  code: string;
  expectedState: string;
  codeVerifier: string;
  expectedNonce: string;
  issuedAtEpochSeconds: number | null;
  usedStateHash: string;
  nowEpochSeconds?: number;
  ttlSeconds?: number;
}): { ok: true } | { ok: false; reason: OAuthStateFailureReason } {
  const queryState = input.queryState.trim();
  const code = input.code.trim();
  const expectedState = input.expectedState.trim();
  const codeVerifier = input.codeVerifier.trim();
  const expectedNonce = input.expectedNonce.trim();
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? STATE_TTL_SECONDS;

  if (!queryState || !code) {
    return { ok: false, reason: 'missing-authorization-response' };
  }

  if (!expectedState) {
    return { ok: false, reason: 'missing-cookie-state' };
  }

  if (queryState !== expectedState) {
    return { ok: false, reason: 'mismatched-state' };
  }

  if (!codeVerifier) {
    return { ok: false, reason: 'missing-code-verifier' };
  }

  if (!expectedNonce) {
    return { ok: false, reason: 'missing-nonce' };
  }

  if (input.issuedAtEpochSeconds === null || !Number.isFinite(input.issuedAtEpochSeconds)) {
    return { ok: false, reason: 'missing-issued-at' };
  }

  if (now - input.issuedAtEpochSeconds > ttl || input.issuedAtEpochSeconds > now + 5) {
    return { ok: false, reason: 'expired-state' };
  }

  if (input.usedStateHash && input.usedStateHash === hashStateForReplayGuard(queryState)) {
    return { ok: false, reason: 'reused-state' };
  }

  return { ok: true };
}
