import { NextResponse, type NextRequest } from 'next/server';

import { readGymEmailAlertEvents, setGymEmailAlertEvent } from '@/src/server/pilot/emailAlertGymEvents';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The gym's choice of which events send the email alert, per user type (lane
 * W4-1, EM-5; OW27-10 A; every event starts ticked, OW27-39 A).
 *
 * WHO (Overwatch GO on #2159, plan section 8): the organization admin only,
 * for both reading and writing ('admin' by alias). Coach, parent, athlete,
 * staff, volunteer, board and the platform owner are refused. The gym comes
 * from the session only; any query field is refused.
 *
 * GET: every event on every user type's list, with ticked and whether it is
 * still the starting value.
 * PUT { user_type, event_kind, ticked }: one tick box. The pair must be on the
 * list (src/shared/emailAlerts.ts). The write and its audit row commit together.
 */

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
    requireRole(principal, ['organization_admin']);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const events = await readGymEmailAlertEvents(principal.organizationId);
    return NextResponse.json({ ok: true, events });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
    requireRole(principal, ['organization_admin']);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: send user_type, event_kind and ticked in the body only');
    }
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object with user_type, event_kind and ticked');
    }
    const fields = Object.keys(body).sort();
    if (fields.join(',') !== 'event_kind,ticked,user_type') {
      throw new ValidationError('Unsupported fields: send user_type, event_kind and ticked only');
    }
    const fieldValues = body as { user_type: unknown; event_kind: unknown; ticked: unknown };
    const event = await setGymEmailAlertEvent({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      userType: fieldValues.user_type,
      eventKind: fieldValues.event_kind,
      ticked: fieldValues.ticked,
    });
    return NextResponse.json({ ok: true, event });
  } catch (error) {
    return jsonError(error);
  }
}
