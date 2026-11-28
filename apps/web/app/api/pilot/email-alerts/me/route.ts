import { NextResponse, type NextRequest } from 'next/server';

import {
  emailAlertUserTypeFor,
  readEmailAlertSwitch,
  refuseUnlessOffered,
  setEmailAlertSwitch,
} from '@/src/server/pilot/emailAlertSwitches';
import { ValidationError } from '@/src/server/pilot/errors';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The caller's own email alert switch (lane W4-1, EM-1b; OD-2026-11-19-019,
 * OW27-10 A). Self-scoped: no account_id parameter, ever (profile/me's rule);
 * gym and account from the session; any query field refused from a caller
 * offered a switch (L1, below).
 *
 * WHO (OW27-02 C; GO on #2159, section 8): coach, organization admin ('admin'
 * by alias), parent, athlete. An athlete under 18, or with no date of birth,
 * gets `{ offered: false }` on GET and 403 on PUT. PUT { switched_on }: an adult
 * athlete with no confirmed address gets 409 (the address and its code are
 * me/address, EM-2b-2). GET adds code_pending for an adult athlete, never an
 * address.
 *
 * L1 (a reviewer on EM-2b-2, as for me/address): whether a switch is offered
 * is asked before anything the request sent is judged, so a caller offered
 * none (an athlete under 18, with no date of birth or no valid record, or an
 * account linked to such a record) gets the same answer whatever it sent: GET
 * { offered: false } with or without a query; PUT reads the query and the
 * whole body, then asks the store's check (refuseUnlessOffered, which retires a
 * leftover row), then judges the shape with nothing awaited between, so every
 * PUT gets the store's plain 403. Anyone offered a switch gets the 400s as
 * before.
 *
 * GET WRITES, only for a caller no longer offered a switch, or whose user type
 * has changed since their row was saved (T-1 A on #2169): the store switches
 * off the row left from before and clears its address, audited in the same
 * transaction (retireSwitchIfAny; apiRouteInventory.json marks it writing). It
 * takes no fields, touches only the caller's own row, can only switch off a
 * switch the caller is not offered under their user type now, and changes
 * nothing when repeated, so it needs no same-origin check.
 */

/** The session's own subject: no field of the request names anyone. */
function subjectOf(principal: PilotPrincipal) {
  return {
    organizationId: principal.organizationId,
    accountId: principal.accountId,
    role: principal.role,
    athleteId: principal.athleteId,
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
    requireRole(principal, ['coach', 'organization_admin', 'parent', 'athlete']);
    const subject = subjectOf(principal);
    // L1: a query is refused only for a caller offered a switch; anyone else reads { offered: false }.
    if (request.nextUrl.searchParams.size > 0 && (await emailAlertUserTypeFor(subject)) !== null) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const state = await readEmailAlertSwitch(subject);
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
    const subject = subjectOf(principal);
    // L1: read everything, then the offered check, then judge it (nothing awaited between).
    const query = request.nextUrl.searchParams.size > 0;
    const body: unknown = await request.json().catch(() => null);
    await refuseUnlessOffered(subject);
    if (query) {
      throw new ValidationError('Unsupported query: send switched_on in the body only');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object with switched_on');
    }
    const fields = Object.keys(body);
    if (fields.length !== 1 || fields[0] !== 'switched_on') {
      throw new ValidationError('Unsupported fields: send switched_on only');
    }
    const state = await setEmailAlertSwitch({ ...subject, switchedOn: (body as { switched_on: unknown }).switched_on });
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    return jsonError(error);
  }
}
