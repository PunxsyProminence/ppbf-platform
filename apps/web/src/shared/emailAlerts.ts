/**
 * Who may have an email alert switch (lane W4-1; OD-2026-11-19-019; OW27-02 C:
 * "Coach, admin, organization admin and parents", plus athletes 18 or over).
 *
 * THE USER TYPE 'staff' IS NOT THE ROLE 'staff'. OW27-10's "staff" means those
 * coaches and admins; the roles 'staff', 'volunteer', 'board' and
 * 'platform_owner' get no switch, mapped role by role below.
 *
 * EVERY athlete, minors included, maps to the candidate 'adult_athlete'; the
 * server decides on the date of birth (isMinor; unknown counts as a minor,
 * OD-2026-10-04-010). A screen shows a switch only when GET
 * /api/pilot/email-alerts/me answers `offered: true`, never from this.
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
