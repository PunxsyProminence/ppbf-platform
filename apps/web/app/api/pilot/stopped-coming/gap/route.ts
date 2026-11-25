import { NextResponse, type NextRequest } from 'next/server';

import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  readStoppedComingPolicy,
  setStoppedComingPolicy,
  STOPPED_COMING_GAP_DAYS,
} from '@/src/server/pilot/stoppedComingPolicy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The gym's "who has stopped coming" number of days (lane W4-6, SC-0a;
 * OW27-30 A: the gym admin sets it, first value 2 weeks).
 *
 * GET: the gym admin only (organization_admin, and 'admin', its alias;
 * Overwatch, W4-6 Q6 A). Their own gym only: the organization comes from the
 * session, never from the request. Answers the number, whether it is the
 * default, and the choices. Query fields are refused.
 *
 * PUT { gap_days }: the gym admin only. One of 7, 14, 21, 28, 42 or 56, or
 * null to put the default back; any other field, query field or value is
 * refused. The write and its audit row commit together.
 *
 * Platform owner, coach, athlete, parent, board, volunteer and staff are
 * refused both.
 */

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
    requireRole(principal, ['organization_admin']);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const policy = await readStoppedComingPolicy(principal.organizationId);
    return NextResponse.json(
      { ok: true, ...policy, choices: STOPPED_COMING_GAP_DAYS },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin']);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: send gap_days in the body only');
    }
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object with gap_days');
    }
    const fields = Object.keys(body);
    if (fields.length !== 1 || fields[0] !== 'gap_days') {
      throw new ValidationError('Unsupported fields: send gap_days only');
    }
    const policy = await setStoppedComingPolicy({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      gapDays: (body as { gap_days: unknown }).gap_days,
    });
    return NextResponse.json(
      { ok: true, ...policy, choices: STOPPED_COMING_GAP_DAYS },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
