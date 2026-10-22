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
 * This is the name from the login: the local part of the address. The name
 * the gym types (Q1 part B) comes first wherever a reader has it -- see
 * coachDisplayNameFor below -- and this is what it falls back to.
 */
export function deriveCoachDisplayName(loginEmail: string | null | undefined): string {
  // "coach.dave@" is Dave, not "Coach Coach Dave" (parent walk 2026-10-19
  // item 6): the title is added once.
  const spoken = deriveStaffDisplayName(loginEmail)?.replace(/^Coach\s+/, '');
  return spoken ? `Coach ${spoken}` : 'Your coach';
}

/**
 * A signature stored as text before the role-word rule, read as the rule
 * would write it today: "Coach Coach" and "Coach Ppbf" read "Your coach",
 * "Coach Coach Dave" reads "Coach Dave" (Codex review of #1786; parent walk
 * 2026-10-19 item 6). Anything that is not a "Coach ..." signature, such as
 * the floor itself, is returned as stored. Nothing stored is rewritten.
 */
export function readStoredCoachSignature(stored: string): string {
  if (!/^Coach\s/.test(stored)) return stored;
  const rest = stored.replace(/^(Coach\s+)+/, '').trim();
  if (rest.split(/\s+/).every((part) => ROLE_WORDS.has(part.toLowerCase()))) return 'Your coach';
  return `Coach ${rest}`;
}

/**
 * Words a shared or role login is made of, which are not anybody's name.
 * coach@ read "Coach Coach" and ppbf@ read "From Ppbf" on family screens
 * (parent walk 2026-10-19 item 6). A stem made only of these names nobody,
 * and the caller's floor stands; one with a name in it ("gym-admin",
 * "pat.office") is read as before. Jason 2026-10-19, Q1
 * "C: A now, B later (Rec.)": a real display-name field comes later.
 */
const ROLE_WORDS: ReadonlySet<string> = new Set(['coach', 'admin', 'staff', 'office', 'info', 'ppbf']);

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
  if (spoken.split(' ').every((part) => ROLE_WORDS.has(part.toLowerCase()))) return null;
  return spoken || null;
}

/* A title typed in front of the name ("Coach Jordan", "Admin: Pat"). Every
   screen adds its own title, so it comes off first; a word that only starts
   like one ("Coachman", "Coach's") is part of the name. */
const LEADING_TITLES = /^(?:(?:coach|admin)(?=[\s\-–—:.,]|$)[\s\-–—:.,]*)+/iu;

/**
 * The name the gym typed (pilot.account_profiles.staff_display_name; Jason
 * 2026-10-19, Q1 part B) without a leading title. Null when nothing is left
 * but titles and role words ("Coach", "Admin", "Staff"): those name nobody,
 * as with a login (ROLE_WORDS above), and the caller falls back to the login.
 */
export function bareTypedStaffName(storedName: string | null | undefined): string | null {
  const bare = (storedName ?? '').trim().replace(LEADING_TITLES, '').trim();
  if (!bare) return null;
  if (bare.split(/\s+/).every((part) => ROLE_WORDS.has(part.toLowerCase()))) return null;
  return bare;
}

/**
 * A coach named by the name the gym typed, titled once ("Coach Jordan"
 * whether "Jordan" or "Coach Jordan" was typed), else by the login as above.
 */
export function coachDisplayNameFor(
  storedName: string | null | undefined,
  loginEmail: string | null | undefined,
): string {
  const bare = bareTypedStaffName(storedName);
  return bare ? `Coach ${bare}` : deriveCoachDisplayName(loginEmail);
}

/** The same without the title, for staff who are not all coaches; null when neither names them. */
export function staffDisplayNameFor(
  storedName: string | null | undefined,
  loginEmail: string | null | undefined,
): string | null {
  return bareTypedStaffName(storedName) ?? deriveStaffDisplayName(loginEmail);
}
