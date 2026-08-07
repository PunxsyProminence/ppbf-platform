import type { PilotRole } from './contracts';

/**
 * Which credential a given person must use to sign in. The single source of
 * truth for that question.
 *
 * WHY THIS EXISTS
 *
 * The rule used to live in five places, and they had already drifted:
 *
 *   auth.ts:136              PIN sign-in admits only 'athlete'
 *   auth.ts:204              Microsoft platform_owner must match the primary owner email
 *   auth.ts:284              a live ppbf_local session for a non-athlete is revoked on sight
 *   staffProvisioning.ts:19  which roles may be invited as Microsoft accounts
 *   app/login/page.tsx       which sign-in tab opens by default
 *
 * The login page lost that argument. It defaulted to the PIN tab and offered an
 * Account ID/PIN form to everyone, while PIN sign-in accepts only athletes -- so
 * every coach, parent and staff member met a form that could not authenticate
 * them, and a generic "Invalid account ID or PIN" that blamed their credential
 * rather than the door. The rule was correct in the server and wrong in the one
 * place a user actually reads.
 *
 * Five copies of a rule is five chances to disagree. This is one copy.
 * credentialPolicyDrift.test.ts fails the build if an auth path decides for
 * itself instead of asking here.
 *
 * THE POLICY
 *
 *   administrators use Microsoft, adults use their email, kids use a stage
 *   name and a PIN
 *
 * Board seats are appointments, not roles: a board member is also a coach or a
 * parent underneath. Holding an OFFICER seat therefore upgrades that person to
 * Microsoft regardless of what their role would otherwise allow -- the seats
 * carrying fiduciary and legal authority get the strongest credential, and the
 * three director seats follow their holder's role.
 */

export type PilotCredential = 'microsoft' | 'magic_link' | 'pin';

/** Roles that administer the platform or an organization. */
export const MICROSOFT_ROLES = [
  'platform_owner',
  'organization_admin',
  // Legacy alias retained for existing rows. New accounts use
  // organization_admin, but anything still carrying it holds admin authority
  // and must not fall through to a weaker credential.
  'admin',
] as const satisfies readonly PilotRole[];

/**
 * Board seats whose holders must use Microsoft regardless of role.
 *
 * The five officers carry fiduciary and legal authority for the organization.
 * safety-director, community-director and at-large are program appointments
 * and follow their holder's role.
 */
export const OFFICER_BOARD_SEATS = [
  'president',
  'chair',
  'vice-chair',
  'treasurer',
  'secretary',
] as const;

/**
 * Adults who participate but do not administer. They sign in with a one-time
 * link sent to their real email address.
 *
 * Parents are here deliberately. A parent reaches identifying data about a
 * minor, so this credential protects real PII -- weaker than Microsoft, and
 * chosen anyway because requiring a Microsoft account of every parent at a
 * community gym is an adoption wall rather than a security control. Parents
 * are also never permitted an alias: the real name on the account is how an
 * adult is matched to the child they are responsible for.
 */
export const MAGIC_LINK_ROLES = [
  'coach',
  'staff',
  'volunteer',
  'parent',
  'board',
] as const satisfies readonly PilotRole[];

export interface CredentialSubject {
  role: PilotRole;
  /** Board seat slugs this account holds, if any. Absent is the same as none. */
  boardSeats?: readonly string[];
}

export function isOfficerSeat(seat: string): boolean {
  return (OFFICER_BOARD_SEATS as readonly string[]).includes(seat);
}

// Type predicates rather than bare .includes(). Widening the tuple to
// readonly string[] to call .includes erases the narrowing, so the compiler
// could not see that the branches below are exhaustive and the `never` check
// at the end was decorative. These restore it: adding a role to PilotRole
// without classifying it is a compile error again.
function isMicrosoftRole(role: PilotRole): role is (typeof MICROSOFT_ROLES)[number] {
  return (MICROSOFT_ROLES as readonly string[]).includes(role);
}

function isMagicLinkRole(role: PilotRole): role is (typeof MAGIC_LINK_ROLES)[number] {
  return (MAGIC_LINK_ROLES as readonly string[]).includes(role);
}

/**
 * The credential this person must present. Total over PilotRole -- adding a
 * role to the union without deciding its credential is a compile error, not a
 * silent fallthrough to the weakest option.
 */
export function requiredCredentialFor(subject: CredentialSubject): PilotCredential {
  // Checked before role, so an officer seat upgrades a coach or parent rather
  // than their role downgrading the seat.
  if (subject.boardSeats?.some(isOfficerSeat)) {
    return 'microsoft';
  }

  const { role } = subject;

  if (isMicrosoftRole(role)) {
    return 'microsoft';
  }

  if (role === 'athlete') {
    return 'pin';
  }

  if (isMagicLinkRole(role)) {
    return 'magic_link';
  }

  // Unreachable while every PilotRole is classified above. The annotation makes
  // that a compile error the moment a new role is added, and the throw means a
  // role that somehow arrives unclassified at runtime is refused rather than
  // handed the weakest credential by default.
  const unclassified: never = role;
  throw new Error(`UNCLASSIFIED_ROLE:${String(unclassified)}`);
}

/** True when this person signs in with an account ID and PIN. */
export function usesPin(subject: CredentialSubject): boolean {
  return requiredCredentialFor(subject) === 'pin';
}

/** True when this person signs in through Microsoft. */
export function usesMicrosoft(subject: CredentialSubject): boolean {
  return requiredCredentialFor(subject) === 'microsoft';
}
