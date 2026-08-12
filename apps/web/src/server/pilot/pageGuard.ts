import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';

import { resolvePrincipal, type PilotPrincipal } from './auth';
import type { PilotRole } from './contracts';
import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';

/**
 * The server-side guard for a role-restricted page.
 *
 * WHY THIS EXISTS. Ten pages each carried this shape:
 *
 *   try {
 *     const principal = await requirePrincipal(request);
 *     requireRole(principal, ['coach']);
 *   } catch {
 *     redirect('/login');
 *   }
 *
 * One catch, one destination -- so three different situations were answered
 * identically with a login form:
 *
 *   not signed in          -> /login   (correct)
 *   signed in, wrong role  -> /login   (WRONG: they already satisfied it)
 *   signed in, PIN pending -> /login   (WRONG: signing in again loops)
 *
 * The middle case is the one users noticed. An authenticated coach who opened
 * an athlete URL was shown the login form, and because /login's own effect
 * sees a valid session and forwards them on, the visible result was a login
 * page flashing past on the way back to where they started -- indistinguishable
 * from having been logged out. That is the same symptom as the 405 bug fixed
 * earlier, arriving through a different door.
 *
 * BoardRoleGate already got this right on the client and says so in a comment:
 * "Signed in, just not to this surface. Their own dashboard is a better answer
 * than a login form they have already satisfied." This is that rule, server-side.
 *
 * NOTES ON THE IMPLEMENTATION
 *
 * - redirect() signals by throwing NEXT_REDIRECT, so nothing here may sit
 *   inside a try/catch -- swallowing that throw is precisely how the old shape
 *   ended up with one destination for every outcome.
 * - A genuine failure (the database is unreachable, so resolvePrincipal
 *   throws) is deliberately NOT converted into a redirect. It propagates and
 *   renders an error, because "the gym's database is down" must not be
 *   presented to a member as "you are signed out" -- the old shape did exactly
 *   that, and it makes an outage unreportable.
 * - Role matching stays an exact list membership, the same test requireRole
 *   applies. This function changes only WHERE a refusal is sent, never WHO is
 *   admitted; widening authorization is a separate decision from fixing a
 *   redirect target.
 * - No request path is threaded in: resolvePrincipal reads the session cookie
 *   and nothing else from the request (auth.ts:241), so the URL used to build
 *   the NextRequest is immaterial.
 */
export async function requirePageRole(allowedRoles: PilotRole[]): Promise<PilotPrincipal> {
  const incomingHeaders = await headers();
  const request = new NextRequest('http://pilot.internal/page-guard', {
    headers: new Headers(incomingHeaders),
  });

  const principal = await resolvePrincipal(request);

  if (!principal) {
    redirect('/login');
  }

  // A valid session still on the PIN the gym handed out. The server refuses
  // every other route in this state, so /login would loop: signing in again
  // arrives back here. /change-pin is the one page that resolves it.
  if (principal.mustChangePin === true) {
    redirect('/change-pin');
  }

  if (!allowedRoles.includes(principal.role)) {
    // Their own workspace, not a login form. Falls back to /login only for a
    // role with no routable destination at all, which loginWithMicrosoftEmail
    // already refuses to mint a session for.
    redirect(getPilotRoleDestination(principal.role) ?? '/login');
  }

  return principal;
}
