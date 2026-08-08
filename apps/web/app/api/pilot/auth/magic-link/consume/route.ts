import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { getClientIp, checkRateLimit, recordFailedAttempt } from '@/src/server/pilot/rateLimit';

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

    // Consumption is wired in the follow-up that binds the database queries.
    // The method contract above is settled first, because it is the piece that
    // silently breaks in production rather than in a test.
    return NextResponse.json({ ok: false, reason: 'NOT_IMPLEMENTED' }, { status: 501 });
  } catch (error) {
    return jsonError(error);
  }
}
