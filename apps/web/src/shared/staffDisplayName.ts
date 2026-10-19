/* The name a gym types for a coach or staff member (pilot.account_profiles.
   staff_display_name; parent-portal Q1 part B). Pure, so the people screen
   checks a name the same way the server does before it is sent. */

/** The database check's limit (pilot_account_profiles_staff_display_name_check), in characters. */
export const STAFF_DISPLAY_NAME_MAX = 60;

/**
 * The roles a gym may name: every adult who works in the gym and can appear
 * on an athlete's or a family's screen. Not athletes or guardians (they have
 * their own records), and not the platform owner (not a person in the gym).
 */
export const STAFF_DISPLAY_NAME_ROLES: readonly string[] = ['coach', 'staff', 'organization_admin', 'admin', 'volunteer'];

export function canCarryStaffDisplayName(role: string): boolean {
  return STAFF_DISPLAY_NAME_ROLES.includes(role);
}

export type StaffDisplayNameInput =
  | { ok: true; name: string | null }
  | { ok: false; error: string };

/**
 * What the admin typed, as it will be stored. Blank clears the name (null):
 * every screen then names the person from their login again.
 *
 * NFC first, so an accented letter typed two ways is stored one way and
 * counts as one character. Every run of whitespace, including a tab, a line
 * break or a non-breaking space, becomes one plain space, and the ends are
 * trimmed: the database refuses a leading or trailing space and any control
 * character, and this is the friendlier version of the same rule. Length is
 * counted in characters (code points), as the database counts it.
 */
export function normalizeStaffDisplayName(raw: unknown): StaffDisplayNameInput {
  if (raw === null || raw === undefined) return { ok: true, name: null };
  if (typeof raw !== 'string') return { ok: false, error: 'A display name must be text.' };
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!name) return { ok: true, name: null };
  if (/\p{Cc}/u.test(name)) return { ok: false, error: 'A display name cannot contain control characters.' };
  if ([...name].length > STAFF_DISPLAY_NAME_MAX) {
    return { ok: false, error: `A display name is at most ${STAFF_DISPLAY_NAME_MAX} characters.` };
  }
  return { ok: true, name };
}
