/* Pure, so a client page can name a coach the same way the server does
   (the schedule's coaching-request picker, #1536). Moved unchanged from
   src/server/pilot/achievements.ts, which still re-exports it. */

/**
 * The name a recognition is signed with.
 *
 * Derived server-side from the coach's own login, never taken from the request
 * body: a signature the sender supplies is a signature anybody in the coach
 * role can forge, and the whole value of this feature is that an athlete can
 * believe a named person said it.
 *
 * pilot.accounts has no display-name column today (logged as a gap — identity
 * work is in flight elsewhere), so the local part of the login address is the
 * best true thing available. When accounts grow a real name, this is the one
 * function to change.
 */
export function deriveCoachDisplayName(loginEmail: string | null | undefined): string {
  const spoken = deriveStaffDisplayName(loginEmail);
  return spoken ? `Coach ${spoken}` : 'Your coach';
}

/**
 * The same name without the title, for a list of staff who are not all
 * coaches (#1558 item three: staff-credentials). Digits are dropped, as above:
 * a login like "mike1987" is most of an account id. Null when the address
 * gives no name; the caller chooses the floor.
 */
export function deriveStaffDisplayName(loginEmail: string | null | undefined): string | null {
  const local = (loginEmail ?? '').split('@')[0]?.trim() ?? '';
  const spoken = local
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return spoken || null;
}
