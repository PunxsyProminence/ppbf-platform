import { NextResponse, type NextRequest } from 'next/server';

import type { PilotPrincipal } from './auth';
import type { PilotRole } from './contracts';
import { resolvePrincipal } from './auth';
import { PilotError } from './errors';
import { ShadowRuntimeUnavailableError } from './shadowRuntimeError';
import { MedicalStatusBlockedError } from './shadowRecommendations';
import { GuardianConsentMissingError } from './guardianConsent';

/**
 * Determines whether cookies should be sent over secure (HTTPS-only) channels.
 * Uses the actual request protocol to detect HTTPS, accounting for proxies that
 * set x-forwarded-proto headers.
 */
export function shouldUseCookieSecureFlag(request: NextRequest): boolean {
  // Check x-forwarded-proto for proxy-detected protocol
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto === 'https') {
    return true;
  }
  if (forwardedProto === 'http') {
    return false;
  }

  // Fall back to request protocol
  return request.nextUrl.protocol === 'https:';
}

/**
 * The default gate for every authenticated route.
 *
 * It deliberately refuses an account that is still on its bootstrap PIN. New
 * athlete accounts are created live on a PIN that is public knowledge
 * (DEFAULT_FIRST_LOGIN_PIN), so the starting PIN must not be able to read
 * anything -- enforcing that here rather than in each route means a new route
 * is covered by default, and cannot forget to check.
 *
 * The two routes that must still work mid-bootstrap -- reading the session and
 * changing the PIN -- call resolvePrincipal or
 * requirePrincipalAllowingPinChange instead.
 */
export async function requirePrincipal(request: NextRequest): Promise<PilotPrincipal> {
  const principal = await requirePrincipalAllowingPinChange(request);
  // Explicit === true: the field is optional on the interface, and a
  // security stop should read as "block when this is set", not "block on
  // anything truthy".
  if (principal.mustChangePin === true) {
    throw new Error('Forbidden: PIN change required before using this account');
  }
  return principal;
}

// Same authentication, without the bootstrap-PIN stop. Only for the PIN
// change route itself; anything else must use requirePrincipal.
export async function requirePrincipalAllowingPinChange(request: NextRequest): Promise<PilotPrincipal> {
  const principal = await resolvePrincipal(request);
  if (!principal) {
    throw new Error('Unauthorized');
  }
  return principal;
}

// Microsoft-authenticated principal requirement for privileged operations.
// PIN/local sessions are explicitly restricted to athlete self-service and
// cannot be used for user management, role management, or other privileged
// actions.
export async function requireMicrosoftAuthenticatedPrincipal(request: NextRequest): Promise<PilotPrincipal> {
  const principal = await requirePrincipal(request);
  if (principal.authProvider !== 'microsoft') {
    throw new Error('Forbidden: Microsoft-authenticated session required');
  }
  return principal;
}

export function requireRole(principal: PilotPrincipal, allowedRoles: PilotRole[]): void {
  if (!allowedRoles.includes(principal.role)) {
    throw new Error('Forbidden');
  }
}

// Used for per-record lookups where a distinct 403 would disclose that a
// record exists but the caller can't access it. Every "doesn't exist" and
// "exists but forbidden" case for these routes must return this exact
// response so the two are indistinguishable to the caller.
export function hiddenNotFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export function jsonError(error: unknown, fallbackStatus = 500): NextResponse {
  const message = error instanceof Error ? error.message : 'Unknown server error';

  // Checked FIRST, before the three specific types below and before any
  // message matching. A PilotError carries its own status and asserts, by
  // being that type, that its message was authored for the caller to read --
  // which is the property the string-prefix branches further down were trying
  // to infer from spelling. See errors.ts for why the inference failed.
  //
  // This is deliberately additive: every prefix branch below still runs for
  // un-migrated call sites, so nothing changes for a throw that has not moved
  // onto the type yet.
  if (error instanceof PilotError) {
    return NextResponse.json(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status },
    );
  }

  // Checked by type before any message matching. A missing migration or unset
  // environment variable is a server-side availability problem, not a bad
  // request, and must not be reported to the caller as one. The diagnostic
  // detail is logged here and deliberately kept out of the response body.
  // A blocked clearance is an expected, safe-to-disclose outcome -- not a
  // server fault -- so it must not fall through to the generic 500 branch
  // below, which replaces the message with "Internal server error" and
  // would leave the coach with no idea why the action was refused.
  if (error instanceof MedicalStatusBlockedError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  // T-008: same reasoning as MedicalStatusBlockedError above -- missing
  // guardian consent is an expected, safe-to-disclose precondition failure
  // on a DIFFERENT resource (the guardian's consent record), not a fault of
  // this request. A 400/403 would misdescribe it; 500 would hide the reason.
  if (error instanceof GuardianConsentMissingError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  if (error instanceof ShadowRuntimeUnavailableError) {
    console.error('shadow-runtime-unavailable', {
      ...(error.missingTables.length > 0 ? { missingTables: error.missingTables } : {}),
      ...(error.missingEnvVar ? { missingEnvVar: error.missingEnvVar } : {}),
    });
    return NextResponse.json(
      { error: 'SHADOW is temporarily unavailable. Please try again later.' },
      { status: 503 },
    );
  }

  if (message.startsWith('Unauthorized')) {
    return NextResponse.json({ error: message }, { status: 401 });
  }
  if (message.startsWith('Forbidden')) {
    return NextResponse.json({ error: message }, { status: 403 });
  }
  if (message.startsWith('Missing') || message.startsWith('Request body') || message.startsWith('Unsupported') || message.startsWith('PIN')) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (message.startsWith('Not found') || message.startsWith('Athlete not found')) {
    return NextResponse.json({ error: message }, { status: 404 });
  }

  // A caller retrying a partially-failed create (e.g. account created but
  // code issuance failed) hits this on the second attempt -- it must read
  // as "already done", not an opaque 500, or the UI has no way to tell the
  // admin the account already exists and stop them retrying forever. The
  // roster-create conflict belongs here for the same reason: the admin needs
  // to see that the athlete_id is taken so they correct the id rather than
  // resubmit and overwrite someone else's record.
  if (
    message.startsWith('Account already exists')
    || message.startsWith('Athlete is already linked')
    || message.startsWith('Athlete record already exists')
    || message.startsWith('Coverage already exists')
    || message.startsWith('Hold already exists')
  ) {
    return NextResponse.json({ error: message }, { status: 409 });
  }

  // Anything else is an unexpected failure (database, parser, upstream
  // provider, ...). The fallback status of 500 means the caller never
  // authored a specific, safe-to-disclose message for it, so the raw
  // message -- which can contain connection strings, SQL, or stack
  // details -- must never reach the client. Non-500 fallbacks are always
  // an explicit, intentional status a route chose for a known condition,
  // so those are left untouched.
  if (fallbackStatus === 500) {
    const safeClass = error instanceof Error
      ? error.constructor?.name?.replace(/[^A-Za-z0-9_$-]/g, '').slice(0, 80) || 'Error'
      : typeof error;
    const safeCode = error && typeof error === 'object' && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string'
      && /^[0-9A-Z_]{3,20}$/.test((error as { code: string }).code)
      ? (error as { code: string }).code
      : undefined;
    console.error('unhandled-route-error', {
      errorClass: safeClass,
      ...(safeCode ? { code: safeCode } : {}),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ error: message }, { status: fallbackStatus });
}

const MAX_SAFE_LIMIT_VALUE = 1_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Parses a "limit" query parameter into a finite positive integer clamped to
// `max`. Returns null for anything that isn't a plain positive integer
// string (empty, negative, zero, decimal, NaN, Infinity, non-numeric) so
// the caller can reject the request instead of silently coercing it.
export function parseSafeLimit(raw: string | null, defaultValue: number, max: number): number | null {
  if (raw === null || raw === '') {
    return defaultValue;
  }

  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0 || value > MAX_SAFE_LIMIT_VALUE) {
    return null;
  }

  return Math.min(value, max);
}
