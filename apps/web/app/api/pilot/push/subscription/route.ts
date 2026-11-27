import { NextResponse, type NextRequest } from 'next/server';

import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { isPushOnHere, readPushOffer, removePushBrowser, savePushBrowser } from '@/src/server/pilot/pushSubscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The caller's own web push browsers (lane W5-WP, WP-1b; OW27-18 A, OW27-17 B;
 * plan, answers and GO on #2228). Self-scoped as email-alerts/me is: gym and
 * account from the session, no account parameter ever, any query field
 * refused. The endpoint travels in the body, never the URL, so it reaches no
 * access log.
 *
 * WHO: the role line the GO approved by name, the same list as email-alerts/me
 * ('admin' passes by the http.ts alias); then the store refuses anyone the
 * email switch is not offered to (an athlete under 18 or with no date of
 * birth), and offers push only once its keys are set.
 *
 * GET:    { offered, public_key? }
 * POST:   { endpoint }                  -> { on }   (read only: is this browser on for me here)
 * PUT:    { endpoint, keys: { p256dh, auth } } -> { on: true }
 * DELETE: { endpoint }                  -> { on: false } (always allowed: an opt-out is never refused)
 *
 * GET writes only to remove the browsers of a caller no longer offered push,
 * audited (as email-alerts/me's GET retires a switch); it takes no fields and
 * can only remove the caller's own rows.
 */

const PRIVATE = { 'Cache-Control': 'private, no-store' };

async function caller(request: NextRequest) {
  const principal = await requirePrincipal(request);
  // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
  requireRole(principal, ['coach', 'organization_admin', 'parent', 'athlete']);
  if (request.nextUrl.searchParams.size > 0) {
    throw new ValidationError('Unsupported query: send fields in the body only');
  }
  return {
    organizationId: principal.organizationId,
    accountId: principal.accountId,
    role: principal.role,
    athleteId: principal.athleteId,
  };
}

async function jsonBody(request: NextRequest): Promise<unknown> {
  return request.json().catch(() => null);
}

export async function GET(request: NextRequest) {
  try {
    const subject = await caller(request);
    return NextResponse.json({ ok: true, ...(await readPushOffer(subject)) }, { headers: PRIVATE });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const subject = await caller(request);
    return NextResponse.json({ ok: true, ...(await isPushOnHere(subject, await jsonBody(request))) }, { headers: PRIVATE });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const subject = await caller(request);
    return NextResponse.json({ ok: true, ...(await savePushBrowser(subject, await jsonBody(request))) }, { headers: PRIVATE });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const subject = await caller(request);
    return NextResponse.json({ ok: true, ...(await removePushBrowser(subject, await jsonBody(request))) }, { headers: PRIVATE });
  } catch (error) {
    return jsonError(error);
  }
}
