/**
 * Opt-in, content-free email alerts (lane W4-1; W4 item 1,
 * docs/content-review/w4-sizing/W4_SIZING.md section 1): who may have a switch.
 *
 * Jason, OD-2026-11-19-019: an opt-in email that says only "open the app".
 * OW27-10 A: the gym picks the events "for each user type (staff, parents,
 * athletes 18 or over)", and each person has one switch on their own
 * settings page. OW27-02 C names who may opt in: "Coach, admin, organization
 * admin and parents", plus athletes 18 or over.
 *
 * THE USER TYPE 'staff' IS NOT THE ROLE 'staff'. OW27-10's "staff" means the
 * coaches and admins OW27-02 names. The account roles 'staff', 'volunteer',
 * 'board' and 'platform_owner' get no switch. The mapping below is written
 * out role by role so that nobody maps the role 'staff' to the user type
 * 'staff' by name.
 *
 * 'adult_athlete' from this function is only a candidate: EVERY athlete,
 * minors included, maps to it. The server decides on the athlete's date of
 * birth (src/lib/minorAge.ts isMinor, an unknown date counting as a minor,
 * OD-2026-10-04-010). A screen must never use this to decide whether to show a
 * switch: it shows one only when GET /api/pilot/email-alerts/me answers
 * `offered: true`. Shared so screens can name the three user types without
 * loading pg.
 */

export const EMAIL_ALERT_USER_TYPES = ['staff', 'parent', 'adult_athlete'] as const;
export type EmailAlertUserType = (typeof EMAIL_ALERT_USER_TYPES)[number];

export function isEmailAlertUserType(value: unknown): value is EmailAlertUserType {
  return typeof value === 'string' && (EMAIL_ALERT_USER_TYPES as readonly string[]).includes(value);
}

/**
 * The user type a role would switch under, or null for a role with no switch.
 * Takes the role as a plain string so the browser can call it; an unknown
 * string is null.
 */
export function emailAlertCandidateUserType(role: string): EmailAlertUserType | null {
  switch (role) {
    case 'coach':
    case 'admin':
    case 'organization_admin':
      return 'staff';
    case 'parent':
      return 'parent';
    case 'athlete':
      return 'adult_athlete';
    default:
      // 'staff', 'volunteer', 'board', 'platform_owner' and anything else.
      return null;
  }
}
