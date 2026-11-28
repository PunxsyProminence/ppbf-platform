import { NextResponse, type NextRequest } from 'next/server';

import { emailAlertCodeMailer } from '@/src/server/pilot/emailAlertCode';
import {
  confirmEmailAlertAddress,
  refuseUnlessAdultAthlete,
  requestEmailAlertAddressCode,
} from '@/src/server/pilot/emailAlertSwitches';
import { ValidationError } from '@/src/server/pilot/errors';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * An adult athlete's address for their email alert switch (lane W4-1,
 * EM-2b-2; plan on #2159, section 8). OW27-38 B: they type an address beside
 * their switch, and it is used only after they enter the code the app emails
 * to it.
 *
 *   POST { address }  emails a code to it        200, the switch's state
 *   PUT  { code }     enters the code            200, the switch's state
 *
 * No DELETE. Neither answer ever holds an address. Confirming never switches
 * the alert on: that stays PUT /me (OD-2026-11-19-019).
 *
 * WHO (OW27-02 C): athletes only, then the store's adult check: an athlete
 * under 18, with no date of birth (OD-2026-10-04-010), or with a deleted or
 * unlinked record gets 403, and nothing is stored, audited or sent (L1 rule:
 * nothing new shown to a minor). Self-scoped: no account_id parameter, ever;
 * gym and account from the session; any query field and any other body field
 * refused (me/route.ts's rule).
 *
 * L1: the adult check comes before anything the request sent is judged. The
 * route reads the query and the whole body first, then asks the store's adult
 * check (refuseUnlessAdultAthlete, which also retires a leftover row), then
 * judges what was sent, with nothing awaited between the check and that
 * judgement (Codex and a reviewer on EM-2b-2): a date of birth corrected while
 * a slow body arrives is read by the check. So a minor, or an athlete with no
 * valid record, gets the store's plain 403 whatever they sent; the store asks
 * it again, and again under its own locks. Only an adult gets the route's 400
 * for a body that is not exactly one string field, which names nothing about
 * email; the address's and code's own 400s are the store's.
 *
 * Other answers: 400 a malformed address or code; 409 a wrong, expired or
 * used-up code (five tries a code); 429 too many code emails, the same answer
 * for each of the three limits; 503 the code email could not be sent (its code
 * is voided). Whether the address belongs to any account is never looked up,
 * so no answer can say (emailAlertSwitches.ts, requestEmailAlertAddressCode).
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

/** Everything the request sent, read before anything is judged: whether it has a query, and its body. */
async function readSent(request: NextRequest): Promise<{ query: boolean; body: unknown }> {
  const text = await request.text().catch(() => '');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: refused below, as a missing body is.
  }
  return { query: request.nextUrl.searchParams.size > 0, body };
}

/** The one string field, or a 400 that says nothing about what the field is for. */
function onlyField({ query, body }: { query: boolean; body: unknown }, field: 'address' | 'code'): string {
  if (query) {
    throw new ValidationError('Unsupported query: this request takes no query fields');
  }
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const value = fields.length === 1 && fields[0] === field ? (body as Record<string, unknown>)[field] : undefined;
  if (typeof value !== 'string') {
    throw new ValidationError('Unsupported request body: this request takes one JSON field');
  }
  return value;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const subject = subjectOf(principal);
    // L1: read everything, then the adult check, then judge it (nothing awaited between).
    const sent = await readSent(request);
    await refuseUnlessAdultAthlete(subject);
    const address = onlyField(sent, 'address');
    const state = await requestEmailAlertAddressCode({ ...subject, address }, emailAlertCodeMailer());
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);
    const subject = subjectOf(principal);
    // L1: read everything, then the adult check, then judge it (nothing awaited between).
    const sent = await readSent(request);
    await refuseUnlessAdultAthlete(subject);
    const code = onlyField(sent, 'code');
    const state = await confirmEmailAlertAddress({ ...subject, code });
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    return jsonError(error);
  }
}
