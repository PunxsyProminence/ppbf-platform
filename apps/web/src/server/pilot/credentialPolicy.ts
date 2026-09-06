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
 * parent underneath. Holding ANY seat upgrades that person to Microsoft
 * regardless of what their role would otherwise allow, because every board
 * office has a mailbox on punxsyprominence.org and therefore already has the
 * Microsoft identity.
 */

export type PilotCredential = 'microsoft' | 'magic_link' | 'pin';

/** Roles that administer the platform, an organization, or the board. */
export const MICROSOFT_ROLES = [
  'platform_owner',
  'organization_admin',
  // Legacy alias retained for existing rows. New accounts use
  // organization_admin, but anything still carrying it holds admin authority
  // and must not fall through to a weaker credential.
  'admin',
  // Every board office has a mailbox on punxsyprominence.org, so a board
  // member already has the Microsoft identity -- there is nothing to make
  // easier for them by dropping to a magic link.
  'board',
] as const satisfies readonly PilotRole[];

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
] as const satisfies readonly PilotRole[];

export interface CredentialSubject {
  role: PilotRole;
  /** Board seat slugs this account holds, if any. Absent is the same as none. */
  boardSeats?: readonly string[];
}

/**
 * Holding ANY board seat requires Microsoft, whatever the holder's role.
 *
 * There is deliberately no list of qualifying seats. Every board office has a
 * mailbox on punxsyprominence.org, so every seat holder already has a Microsoft
 * identity -- and a list of "seats that count" is one more thing to fall out of
 * date the day a ninth seat is added. Holding a seat is the whole test.
 */
export function seatRequiresMicrosoft(boardSeats: readonly string[] | undefined): boolean {
  return (boardSeats?.length ?? 0) > 0;
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
  // Checked before role, so a seat upgrades a coach or parent rather than their
  // role downgrading the seat.
  if (seatRequiresMicrosoft(subject.boardSeats)) {
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

/**
 * Roles the BASE-03 offline exception may admit, and no others.
 *
 * These are exactly the two base roles whose production credential depends on
 * a service the offline runtime cannot reach: organization_admin needs Entra,
 * coach needs a magic link delivered by Graph mail. The offline network guard
 * refuses both, so on a local machine those two accounts have no door at all --
 * the offline launcher already seeds them with a PIN, and the production policy
 * below correctly refuses it.
 *
 * Athlete is deliberately absent: athletes already sign in with a PIN under the
 * ordinary policy, so an exception would be a second answer to a settled
 * question. Every other role is absent because BASE-03's scope is these three
 * roles and nothing else.
 */
export const OFFLINE_LOCAL_PIN_ROLES = [
  'organization_admin',
  'coach',
] as const satisfies readonly PilotRole[];

/**
 * Runtime facts the offline exception is fenced on.
 *
 * databaseIsLoopback is REQUIRED rather than optional, and deliberately so. An
 * optional boolean defaults to "not loopback" only if every caller remembers to
 * think about it; a required one is a compile error at any call site that does
 * not. This module is imported by client components, so it cannot read a
 * connection string itself -- the fact has to arrive from a server-only caller,
 * and the type is the only thing that can insist it does.
 *
 * holdsBoardSeat is required for the same reason and carries the same warning.
 * It is the authoritative answer to "does this account hold a seat on the board
 * of the organization being authenticated", loaded from pilot.board_seats by
 * the caller. An optional flag would default to "no seat", which is exactly the
 * silent answer that made the guard below unenforceable in the first place.
 *
 * nodeEnv and offlineRuntimeFlag stay optional because they fall back to
 * process.env, which is correct in every runtime; they are injectable so the
 * policy matrix is testable without mutating global state.
 */
export interface RuntimeCredentialEnvironment {
  databaseIsLoopback: boolean;
  holdsBoardSeat: boolean;
  nodeEnv?: string;
  offlineRuntimeFlag?: string;
}

/**
 * Whether this person may authenticate with an account ID and PIN *in the
 * current runtime*.
 *
 * This is deliberately a SEPARATE question from requiredCredentialFor, which
 * remains the production credential policy and is not environment-aware. A
 * person is admitted here when either
 *
 *   - the ordinary policy already says they use a PIN (athletes), or
 *   - the narrow BASE-03 offline exception applies.
 *
 * The exception opens only when all three of these hold: NODE_ENV is exactly
 * 'development', PPBF_OFFLINE_RUNTIME is exactly 'true', and this process's
 * PostgreSQL connection is loopback. That is the same three-condition fence
 * db.ts's resolveSslConfig requires for the loopback TLS opt-out, and for the
 * same reasons. NODE_ENV keeps the flag from weakening a real deploy, which
 * never runs with NODE_ENV=development, so staging and production cannot reach
 * this branch even if the flag leaks into their environment. The loopback
 * condition covers the case NODE_ENV cannot: a developer who exports the flag
 * -- next.config.ts reads it to move distDir off .next, so there is an ordinary
 * reason to -- while still pointed at a real database. The two environment
 * strings say what a process calls itself; only the connection says what it is
 * connected to, and the PIN this exception admits is a published constant.
 *
 * A board-seat holder is refused outright. Their production credential is
 * Microsoft because they hold an office with a mailbox, and an offline
 * convenience must not quietly downgrade a governance identity. The seat is
 * asked about two ways because there are two kinds of caller: a subject that
 * carries its own seat list, and a runtime that loaded the fact from
 * pilot.board_seats. Either answering yes refuses the exception. Neither
 * defines what a seat is -- the table does.
 *
 * Accepts an injected environment so the policy matrix is directly unit
 * testable without mutating global process.env.
 */
export function pinLoginPermitted(
  subject: CredentialSubject,
  environment: RuntimeCredentialEnvironment,
): boolean {
  if (usesPin(subject)) {
    return true;
  }

  if (seatRequiresMicrosoft(subject.boardSeats) || environment.holdsBoardSeat) {
    return false;
  }

  const nodeEnv = environment.nodeEnv ?? process.env.NODE_ENV;
  const offlineRuntimeFlag = environment.offlineRuntimeFlag ?? process.env.PPBF_OFFLINE_RUNTIME;

  if (nodeEnv !== 'development' || offlineRuntimeFlag !== 'true' || !environment.databaseIsLoopback) {
    return false;
  }

  return (OFFLINE_LOCAL_PIN_ROLES as readonly string[]).includes(subject.role);
}
