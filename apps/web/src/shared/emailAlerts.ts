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
 * A parent's new message (W4-4) joins the staff list in EM-4c (GO on #2159,
 * Q-2 = A); the database checks only the key's shape, so that needs no
 * migration. Keep each list in the order a screen should show it.
 *
 * DO NOT RENAME A KEY. A gym's stored choice is keyed by it: a renamed key
 * reads as having no choice, so an event a gym had unticked would start
 * sending again. Add a new key and keep the old one, or migrate the rows.
 */
export const EMAIL_ALERT_EVENTS = {
  staff: ['safety_escalation', 'parent_reply', 'gym_notice'],
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
