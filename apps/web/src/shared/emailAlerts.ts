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

/**
 * Which events can send the email, per user type (lane W4-1, EM-5).
 *
 * Overwatch's Q1.9 reading on #2050 (INFERRED, not Jason's words): the gym's
 * list offers every event named in the OW27-01 card, each only to the user
 * types who read it in the app. Gym announcements are the 'notice' kind only;
 * the Chalkboard's 'motivation' kind says of itself "Not a notification"
 * (Overwatch GO on #2159, condition 1). The organization admin ticks each one
 * per user type (OW27-10 A); with no choice saved, every one is ticked
 * (OW27-39 A).
 *
 * 'safety_escalation' is every new row of pilot.safety_escalations a staff
 * member can read, SHADOW safety alerts and pain-note alerts included (Q1.9:
 * "safety escalations (SHADOW safety alerts included)"); they get no key of
 * their own, so an unticked gym or an off-list key can never drop them alone.
 *
 * 'guardian_message' is a guardian's new message in a family thread (W4-4;
 * OW27-25 A), added in EM-4c (GO on #2159, Q-2 = A). It goes only to the staff
 * it nudges (OW27-27 A), not to every staff member who can read it. The
 * database checks only the key's shape, so it needed no migration. Keep each
 * list in the order a screen should show it.
 *
 * DO NOT RENAME A KEY. A gym's stored choice is keyed by it: a renamed key
 * reads as having no choice, so an event a gym had unticked would start
 * sending again. Add a new key and keep the old one, or migrate the rows.
 */
export const EMAIL_ALERT_EVENTS = {
  staff: ['safety_escalation', 'parent_reply', 'guardian_message', 'gym_notice'],
  parent: ['family_note', 'gym_notice'],
  adult_athlete: ['coach_message', 'gym_notice'],
} as const satisfies Record<EmailAlertUserType, readonly string[]>;

export type EmailAlertEventKind = (typeof EMAIL_ALERT_EVENTS)[EmailAlertUserType][number];

/** Whether this event is on this user type's list. */
export function isEmailAlertEventFor(userType: unknown, eventKind: unknown): boolean {
  return isEmailAlertUserType(userType)
    && typeof eventKind === 'string'
    && (EMAIL_ALERT_EVENTS[userType] as readonly string[]).includes(eventKind);
}
