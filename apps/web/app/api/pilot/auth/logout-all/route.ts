import { NextResponse, type NextRequest } from 'next/server';

import { revokeAllSessionsForAccountInOrganization } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Sign out of every session this account holds in this organization.
 *
 * WHY THIS EXISTS. /api/pilot/auth/logout ends ONE session -- the token in the
 * request's own cookie. For an account whose credential is a magic link, the
 * credential is the person's email inbox, and the thing they need after
 * noticing that inbox is compromised is to end the sessions they are not
 * holding. Until this route, only an organization admin could do that
 * (/api/pilot/admin/accounts/revoke), so the interval between "someone is in
 * my email" and "an admin is awake" was an interval in which the attacker kept
 * a working session. That interval is worst overnight and at weekends, which
 * is when a guardian is most likely to be reading their own mail.
 *
 * NO account_id PARAMETER, AND THERE MUST NEVER BE ONE. The account acted on
 * is the caller's, read from the resolved principal. This is the same rule
 * /api/pilot/profile/me states for the same reason: a route that can be
 * pointed at an account id is a route that will eventually be pointed at the
 * wrong one. Revoking somebody else's sessions stays with the admin route,
 * where it is a deliberate act by a known human against a named target.
 *
 * SCOPE IS THIS ORGANIZATION, NOT EVERY ORGANIZATION. pilot.session_tokens
 * carries an organization_id and pilot.organization_memberships is keyed
 * (account_id, organization_id), so one account can legitimately hold live
 * sessions at more than one gym. This reuses the existing, tested
 * revokeAllSessionsForAccountInOrganization, which deliberately leaves the
 * other organization's sessions alone. That is a real limit, not an oversight:
 * a caller signed in at two gyms who runs this at one is still signed in at
 * the other. Widening it to every organization would be a new capability with
 * a larger blast radius and is not what this route claims to do.
 *
 * requirePrincipal, not requireMicrosoftAuthenticatedPrincipal. The admin
 * route demands a Microsoft session because it acts on somebody else. This
 * acts only on the caller, and the people who most need it -- guardians on
 * magic links, athletes on PINs -- do not have Microsoft sessions at all.
 * Requiring one here would lock the capability away from exactly the accounts
 * whose credential is the weakest.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    /* Refuses a platform owner and an account with no active membership in
       this organization, both inside the shared function. A platform owner
       reaching this gets the same generic refusal an admin would get. */
    await revokeAllSessionsForAccountInOrganization(principal.accountId, principal.organizationId);

    /* After the revocation, matching the admin route's ordering rather than
       inventing a different one. The principal is already in memory, so the
       record is written from resolved values and not from a re-read of rows
       whose sessions have just been revoked. */
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: principal.accountId,
      details: { action: 'session_revoke_all_self' },
    });

    const response = NextResponse.json({ ok: true });

    /* The caller's own session is one of the ones just revoked, so the cookie
       it is still carrying now points at a dead token. Clearing it means the
       browser stops presenting a token that resolvePrincipal will refuse,
       rather than being told it is signed in until the next request fails. */
    response.cookies.set(PILOT_SESSION_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });

    return response;
  } catch (error) {
    return jsonError(error);
  }
}
