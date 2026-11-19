import { NextResponse, type NextRequest } from 'next/server';

import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  readTabletIdlePolicy,
  setTabletIdlePolicy,
  TABLET_IDLE_MINUTES,
} from '@/src/server/pilot/tabletIdlePolicy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The gym tablet's idle sign-out time (lane U1, AS2-a; OW25-53 A: the gym
 * admin sets it in gym settings, first value 1 hour).
 *
 * GET: any signed-in member, for their own gym only (the organization comes
 * from the session, never from the request). The tablet asks with whoever is
 * signed in on it, athletes included. The answer is the number and whether it
 * is the default, nothing about any person. Query fields are refused.
 *
 * PUT { idle_minutes }: the gym admin only (organization_admin, and 'admin',
 * its alias). Platform owner, coach, athlete, parent and board are refused.
 * One of 15, 30, 60, 120 or 240; any other field or value is refused. The
 * write and its audit row commit together.
 */

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const policy = await readTabletIdlePolicy(principal.organizationId);
    return NextResponse.json({ ok: true, ...policy, choices: TABLET_IDLE_MINUTES });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
    requireRole(principal, ['organization_admin']);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object with idle_minutes');
    }
    const fields = Object.keys(body);
    if (fields.length !== 1 || fields[0] !== 'idle_minutes') {
      throw new ValidationError('Unsupported fields: send idle_minutes only');
    }
    const policy = await setTabletIdlePolicy({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      idleMinutes: (body as { idle_minutes: unknown }).idle_minutes,
    });
    return NextResponse.json({ ok: true, ...policy, choices: TABLET_IDLE_MINUTES });
  } catch (error) {
    return jsonError(error);
  }
}
