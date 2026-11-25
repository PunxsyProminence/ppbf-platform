import { NextResponse, type NextRequest } from 'next/server';

import { readEmailAlertSwitch, setEmailAlertSwitch } from '@/src/server/pilot/emailAlertSwitches';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The caller's own email alert switch (lane W4-1, EM-1; OD-2026-11-19-019,
 * OW27-10 A: "Each person turns their own email on or off with one switch on
 * their own settings page").
 *
 * SELF-SCOPED, structurally: there is no account_id parameter and there must
 * never be one (profile/me/route.ts's rule). The organization and account come
 * from the session only; any query field is refused.
 *
 * WHO (OW27-02 C; Overwatch GO on #2159, section 8): coach, organization admin
 * ('admin' by alias), parent and athlete may call. An athlete is offered a
 * switch only when their own athlete record says 18 or over; no date of birth
 * counts as a minor (OD-2026-10-04-010). GET then answers `{ offered: false }`
 * and nothing else, and PUT refuses (403). Staff, volunteer, board and the
 * platform owner are refused by requireRole.
 *
 * PUT { switched_on: boolean }. An adult athlete cannot switch on until an
 * address is confirmed (409; EM-2b adds the address). The write and its audit
 * row commit together.
 */

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
    requireRole(principal, ['coach', 'organization_admin', 'parent', 'athlete']);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const state = await readEmailAlertSwitch({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      role: principal.role,
      athleteId: principal.athleteId,
    });
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
    requireRole(principal, ['coach', 'organization_admin', 'parent', 'athlete']);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: send switched_on in the body only');
    }
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object with switched_on');
    }
    const fields = Object.keys(body);
    if (fields.length !== 1 || fields[0] !== 'switched_on') {
      throw new ValidationError('Unsupported fields: send switched_on only');
    }
    const state = await setEmailAlertSwitch({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      role: principal.role,
      athleteId: principal.athleteId,
      switchedOn: (body as { switched_on: unknown }).switched_on,
    });
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    return jsonError(error);
  }
}
