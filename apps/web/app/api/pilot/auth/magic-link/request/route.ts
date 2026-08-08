import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { getClientIp, checkRateLimit, recordFailedAttempt, checkDurableRateLimit, recordDurableFailedAttempt } from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

/**
 * Requests a sign-in link.
 *
 * ALWAYS ANSWERS THE SAME THING
 *
 * 202 with the same body whether a link was sent or not. issueMagicLink is
 * already silent about unknown, deactivated, wrong-role and mismatched
 * addresses -- this route completes that by refusing to leak the difference
 * through status code, body, or timing-adjacent behaviour like skipping the
 * rate limiter for addresses that do not exist.
 *
 * The alternative is an endpoint that answers "does this family attend this
 * gym" to anonymous callers, one address at a time. For a youth boxing club
 * that is a roster disclosure, not a login inconvenience.
 *
 * RATE LIMITED ON BOTH AXES, AND RECORDED EVEN ON SUCCESS
 *
 * Per-address so one mailbox cannot be flooded with links by a stranger, and
 * per-IP so the endpoint cannot be walked across many addresses to build that
 * roster. Attempts are recorded whatever the outcome -- recording only
 * failures would make "no attempt recorded" a signal that the address was
 * real, which is the leak this route exists to avoid.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const email = body.email?.trim().toLowerCase() || '';

    // Shape only. Whether it belongs to anyone is not this route's business
    // to reveal.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }

    const clientIp = getClientIp(request);
    const emailKey = `magic_link_email:${email}`;
    const ipKey = `magic_link_ip:${clientIp}`;

    const durableEmail = await checkDurableRateLimit(emailKey);
    const durableIp = await checkDurableRateLimit(ipKey);
    if (durableEmail.isLimited || durableIp.isLimited || checkRateLimit(emailKey).isLimited || checkRateLimit(ipKey).isLimited) {
      // Deliberately the same 429 for both axes. Distinguishing them tells a
      // caller whether they hit a per-address limit, which is itself a hint
      // that the address is worth continuing to probe.
      return NextResponse.json(
        { error: 'Too many sign-in requests. Please wait a few minutes.' },
        { status: 429 },
      );
    }

    await recordDurableFailedAttempt(emailKey);
    await recordDurableFailedAttempt(ipKey);
    recordFailedAttempt(ipKey);

    // Issuance is wired in the follow-up that adds the database queries and
    // the Graph transport binding. The contract this route promises -- one
    // answer for every outcome -- is settled here, before there is anything
    // to leak, so it cannot be lost while wiring.
    return NextResponse.json(
      { ok: true, message: 'If that address has an account, a sign-in link is on its way.' },
      { status: 202 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
