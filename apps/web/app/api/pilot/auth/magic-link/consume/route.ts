import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';
import { redeemMagicLink } from '@/src/server/pilot/magicLinkStore';
import { getClientIp, checkRateLimit, recordFailedAttempt } from '@/src/server/pilot/rateLimit';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

export const runtime = 'nodejs';

/**
 * Redeems a sign-in link.
 *
 * POST ONLY, AND THAT IS LOAD-BEARING
 *
 * The link in the email points at a page, not at this route, and the page
 * POSTs here. It would be simpler to let the emailed URL be a GET that
 * consumes the token directly -- and it would break constantly.
 *
 * Mail infrastructure fetches links. Outlook Safe Links, Defender, corporate
 * mail gateways and antivirus scanners all follow URLs in messages to check
 * them. Every one of those is a GET. With a GET-consumes design the scanner
 * burns the single-use token seconds after delivery, and the parent clicks a
 * link that is already dead -- reliably, and only for the users whose mail
 * provider protects them best.
 *
 * A scanner will not POST. So the token survives until a human acts.
 *
 * GET returns 405 here deliberately rather than 404, so a prefetch is a
 * recorded no-op instead of looking like a routing mistake.
 */
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Sign-in links are redeemed by the page, not by fetching the URL.' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { token?: string };
    const token = body.token?.trim() || '';

    if (!token) {
      return NextResponse.json({ ok: false, reason: 'TOKEN_MISSING' }, { status: 400 });
    }

    // Per-IP only. There is no account to key on until the token resolves, and
    // resolving it is the expensive part -- so the limiter has to sit in front
    // of the lookup rather than after it. Guards against someone grinding
    // random tokens against the endpoint.
    const clientIp = getClientIp(request);
    const ipKey = `magic_link_consume_ip:${clientIp}`;
    if (checkRateLimit(ipKey).isLimited) {
      return NextResponse.json(
        { ok: false, reason: 'RATE_LIMITED' },
        { status: 429 },
      );
    }
    recordFailedAttempt(ipKey);

    const result = await redeemMagicLink(token);

    if (!result.ok || !result.session || !result.principal) {
      // The reason IS returned, unlike the request route. Different situation:
      // whoever holds a link already knows the address it went to, so there is
      // no enumeration to protect against -- and "this link expired, ask for a
      // new one" is the difference between a parent who retries and a parent
      // who gives up.
      return NextResponse.json({ ok: false, reason: result.reason ?? 'REDEMPTION_FAILED' }, { status: 401 });
    }

    await writePilotAuditEvent({
      event_type: 'login',
      actor_account_id: result.principal.accountId,
      actor_role: result.principal.role,
      organization_id: result.principal.organizationId,
      entity_type: 'account',
      entity_id: result.principal.accountId,
      details: { auth_provider: 'magic_link' },
    });

    const response = NextResponse.json({
      ok: true,
      account_id: result.principal.accountId,
      role: result.principal.role,
      organization_id: result.principal.organizationId,
    });

    response.cookies.set(PILOT_SESSION_COOKIE, result.session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_ABSOLUTE_LIFETIME_SECONDS,
    });

    return response;
  } catch (error) {
    return jsonError(error);
  }
}
