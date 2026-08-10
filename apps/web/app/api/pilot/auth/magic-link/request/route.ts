import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { issueMagicLink } from '@/src/server/pilot/magicLink';
import { magicLinkDependencies } from '@/src/server/pilot/magicLinkStore';
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

    // Failures are swallowed on purpose, and only here.
    //
    // issueMagicLink already returns silently for an unknown, deactivated,
    // wrong-role or mismatched address. What is caught here is the other kind:
    // Graph refusing, the identity endpoint being unreachable, a database
    // blip. Those must not change the response either -- a 500 for a real
    // address and a 202 for an unknown one distinguishes them just as well as
    // a message would, and the whole contract of this route is that the two
    // are indistinguishable.
    //
    // The cost is that a genuine outage looks like success to the requester.
    // That is the right trade for an endpoint whose failure mode is a roster
    // disclosure: they retry, and the error is logged for us rather than
    // reported to them.
    try {
      await issueMagicLink(email, magicLinkDependencies());
    } catch (issueError) {
      // Shape only, never the address -- this line reaches logs.
      //
      // status_code is included because its absence cost real time: a staging
      // send failed with GRAPH_SEND_FAILED and nothing more, when the 403 that
      // came with it would have said "this identity lacks Mail.Send" outright.
      // The error class carried the status all along; the log threw it away.
      // graph_error_code is here for the same reason status_code is: a 403
      // means "the access policy refused this mailbox" or "the token lacks
      // Mail.Send", and only Graph's error code separates them. It is shape-
      // checked at the mailer so it cannot carry an address.
      const { statusCode: status, graphErrorCode: graphCode } =
        (issueError ?? {}) as { statusCode?: number; graphErrorCode?: string };
      console.error(JSON.stringify({
        event: 'magic_link.issue_failed',
        error_type: issueError instanceof Error ? issueError.name : typeof issueError,
        error_code: issueError instanceof Error ? issueError.message : 'unknown',
        status_code: typeof status === 'number' ? status : null,
        graph_error_code: typeof graphCode === 'string' ? graphCode : null,
      }));
    }

    return NextResponse.json(
      { ok: true, message: 'If that address has an account, a sign-in link is on its way.' },
      { status: 202 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
