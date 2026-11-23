import { redirect } from 'next/navigation';

/**
 * /athlete/sign-in -- now an address, not a second form (scrub ATH-15).
 *
 * Jason, 2026-11-23, Q5 "A" (with Q4, "both A"), lane SIGNIN-FIX #2143: one
 * athlete PIN form, on /login. This page used to be a second copy of the PIN
 * sign-in: the same POST /api/pilot/auth/login, its own copy of the
 * pin_change_required branch and the gym tablet session boundary, and a
 * different look. Two copies of the sign-in steps are how they drift, and an
 * athlete met two different screens for the same thing.
 *
 * /login is where every sign-out lands, the gym tablet's idle sign-out
 * included (src/lib/signOut.ts), so the one form lives there. Its PIN block
 * is a gym-floor surface (data-surface="kiosk" on the form in SignInPanel),
 * which is what this page's 55px controls and 19.1px labels were for.
 *
 * The address stays, as a redirect, so a bookmark, a printed card or an old
 * link still lands an athlete on the PIN form. The fragment is the PIN
 * block's heading, so the page opens at the athlete's own way in.
 */
export default function AthletePinSignInPage(): never {
  redirect('/login#signin-pin-heading');
}
