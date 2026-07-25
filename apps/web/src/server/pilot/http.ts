import { NextResponse, type NextRequest } from 'next/server';

import type { PilotPrincipal } from './auth';
import type { PilotRole } from './contracts';
import { resolvePrincipal } from './auth';

export async function requirePrincipal(request: NextRequest): Promise<PilotPrincipal> {
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

  if (message.startsWith('Unauthorized')) {
    return NextResponse.json({ error: message }, { status: 401 });
  }
  if (message.startsWith('Forbidden')) {
    return NextResponse.json({ error: message }, { status: 403 });
  }
  if (message.startsWith('Missing') || message.startsWith('Request body') || message.startsWith('Unsupported') || message.startsWith('PIN')) {
    return NextResponse.json({ error: message }, { status: 400 });
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
