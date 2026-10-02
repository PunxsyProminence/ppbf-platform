import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { PASSWORD_ROLES } from '@/src/server/pilot/credentialPolicy';
import { ForbiddenError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { passwordSetupLinkRequired, setOwnPasswordFromLinkSession } from '@/src/server/pilot/parentPassword';
import {
  checkDurableRateLimit,
  checkRateLimit,
  clearDurableRateLimit,
  getClientIp,
  recordDurableFailedAttempt,
} from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

// The password is already committed when this runs, so a lost audit row must
// not turn a saved password into a 500 -- the consume route's own doctrine.
async function auditPasswordSet(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'pilot-auth-password-set-audit-write-failed',
      ...(code ? { code } : {}),
    });
  }
}

/**
 * A parent sets, or replaces, their own password.
 *
 * Who may, and on what proof, is decided in parentPassword.ts: a session
 * minted by an emailed sign-in link in the last fifteen minutes, on an account
 * credentialPolicy admits to a password. This route adds the session check
 * every authenticated route has, and the attempt limit.
 *
 * Limited per account and per IP, durable and volatile, like change-pin. It
 * takes no existing secret, so there is nothing to guess here; the limit is on
 * refusals, so a session that is not entitled cannot be used to hammer the
 * route. A password the rules refuse is not counted: that is a parent choosing
 * a password, and it must not spend their attempts.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const accountKey = `password_set_account:${principal.accountId}`;
    const ipKey = `password_set_ip:${getClientIp(request)}`;

    const durableAccountCheck = await checkDurableRateLimit(accountKey);
    const durableIpCheck = await checkDurableRateLimit(ipKey);
    if (
      checkRateLimit(accountKey).isLimited
      || checkRateLimit(ipKey).isLimited
      || durableAccountCheck.isLimited
      || durableIpCheck.isLimited
    ) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    // Not trimmed: a space at either end is part of the password as typed.
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      throw new Error('Missing password');
    }

    try {
      // The role gate, by name, on credentialPolicy's own list. A role outside
      // it gets the answer every other refusal here gets, not a different one.
      // The session proof is decided in parentPassword.ts.
      try {
        requireRole(principal, [...PASSWORD_ROLES]);
      } catch {
        throw passwordSetupLinkRequired();
      }

      await setOwnPasswordFromLinkSession({
        accountId: principal.accountId,
        sessionToken: principal.sessionToken,
        password,
      });
    } catch (error) {
      if (error instanceof ForbiddenError) {
        await recordDurableFailedAttempt(accountKey);
        await recordDurableFailedAttempt(ipKey);
      }
      throw error;
    }

    await clearDurableRateLimit(accountKey);
    await clearDurableRateLimit(ipKey);

    await auditPasswordSet({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: principal.accountId,
      details: { action: 'set_own_password' },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
