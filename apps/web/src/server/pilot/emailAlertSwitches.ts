/**
 * EACH PERSON'S EMAIL ALERT SWITCH (lane W4-1, EM-1b). OD-2026-11-19-019: an
 * opt-in email that says only "open the app"; OW27-10 A: one switch on each
 * person's own settings page. Reads and writes the caller's own switch only.
 *
 * WHO (OW27-02 C): coach, admin, organization admin ('staff'), parents
 * ('parent'), and athletes 18 or over ('adult_athlete'), judged on the athlete
 * record linked to this account; no date of birth counts as a minor
 * (OD-2026-10-04-010). Anyone else gets `{ offered: false }` and nothing more
 * (no new warning, L1 rule). What a later change does to a switch already on is
 * retireReason's: an athlete now under 18, with no date of birth, or whose
 * record is deleted or unlinked, has the row switched off and its address
 * cleared at their next own read or write, and a person whose user type has
 * changed at their next own read or write under the new type
 * (retireSwitchIfAny); sign-in switched off and a role with no switch only
 * pause it (OVERWATCH 7182466510 on #2169).
 *
 * An adult athlete cannot switch on before an address is confirmed (OW27-38 B;
 * GO on #2159, condition 3); the table's CHECK refuses it too. The address and
 * its code are EM-2b-2's (requestEmailAlertAddressCode, below). Every change is
 * audited in the same transaction. No address field and no code is audited;
 * the audit row names the account by its id, which can itself be the sign-in
 * address (see the email-alert-switches migration).
 */

import { randomInt } from 'node:crypto';

import type { PoolClient } from 'pg';

import { isMinor } from '@/src/lib/minorAge';
import { emailAlertCandidateUserType, type EmailAlertUserType } from '@/src/shared/emailAlerts';

import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { queryOne, withTransaction } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { ConflictError, ForbiddenError, PilotError, ServiceUnavailableError, ValidationError } from './errors';
import { EMAIL_SHAPE, MailSendError } from './graphMailer';
import { reserveAttempts } from './rateLimit';
import { hashToken } from './security';

export interface EmailAlertSwitchSubject {
  readonly organizationId: string;
  readonly accountId: string;
  readonly role: PilotRole;
  /** The athlete record an athlete account signs in as (principal.athleteId). */
  readonly athleteId?: string | null;
}

export type EmailAlertSwitchState =
  | { readonly offered: false }
  | {
    readonly offered: true;
    readonly user_type: EmailAlertUserType;
    readonly switched_on: boolean;
    /** Adult athletes only: whether an address has been confirmed (EM-2b). */
    readonly address_confirmed?: boolean;
    /** Adult athletes only: whether a code can still be entered (EM-2b-2). Never an address. */
    readonly code_pending?: boolean;
  };

/**
 * The user type this account may switch under now, or null. An athlete's age
 * is read through pilot.accounts, so a caller cannot point it at another record.
 *
 * A5 (carried from EM-2, #2197): any other account linked to an athlete record
 * is that athlete's, whatever its role, as the sender reads it
 * (emailAlertSender.ts recheck): linked to a record under 18, with no date of
 * birth, deleted or not in this gym, it is offered nothing either.
 */
export async function emailAlertUserTypeFor(
  subject: EmailAlertSwitchSubject,
  now: Date = new Date(),
): Promise<EmailAlertUserType | null> {
  const candidate = emailAlertCandidateUserType(subject.role);
  if (candidate === null) return null;
  const athleteId = candidate === 'adult_athlete'
    ? subject.athleteId?.trim()
    : (await queryOne<{ athlete_id: string | null }>(ACCOUNT_LINK_SQL, [subject.accountId]))?.athlete_id;
  if (!athleteId) return candidate === 'adult_athlete' ? null : candidate;
  const row = await queryOne<{ dob: string | null }>(LINKED_ATHLETE_DOB_SQL, [subject.organizationId, subject.accountId, athleteId]);
  return row && !isMinor(row.dob, now) ? candidate : null;
}

/** The athlete record an account is linked to, whatever its role (A5). */
const ACCOUNT_LINK_SQL = 'select athlete_id from pilot.accounts where account_id = $1';

/** The date of birth of the live athlete record linked to this very account in this gym. */
const LINKED_ATHLETE_DOB_SQL = `select to_char(ath.dob, 'YYYY-MM-DD') as dob
       from pilot.accounts acc
       join pilot.athletes ath
         on ath.organization_id = $1 and ath.athlete_id = acc.athlete_id
      where acc.account_id = $2 and acc.athlete_id = $3 and ath.deleted_at is null`;

interface SwitchRow {
  user_type: EmailAlertUserType;
  switched_on: boolean;
  address_confirmed: boolean;
  holds_address: boolean;
  /** The typed address and its code (EM-2b-2): read to check a code, never returned. */
  pending_address: string | null;
  pending_code_hash: string | null;
  code_expires_at: Date | null;
  code_attempts: number;
}

const HOLDS_ADDRESS = 'pending_address is not null or pending_code_hash is not null or confirmed_address is not null';
const SWITCH_ROW_COLUMNS = `user_type, switched_on, confirmed_address is not null as address_confirmed,
            (${HOLDS_ADDRESS}) as holds_address, pending_address, pending_code_hash,
            pending_code_expires_at as code_expires_at, pending_code_attempts as code_attempts`;

/** The address columns, kept where `keep` is true and cleared where it is not. */
function addressColumns(keep: string): string {
  return ['pending_address', 'pending_code_hash', 'pending_code_expires_at', 'confirmed_address', 'confirmed_at']
    .map((column) => `${column} = case when ${keep} then s.${column} end`)
    .concat(`pending_code_attempts = case when ${keep} then s.pending_code_attempts else 0 end`)
    .join(',\n           ');
}

type OfferedState = Extract<EmailAlertSwitchState, { offered: true }>;

function stateFrom(userType: EmailAlertUserType, row: SwitchRow | null | undefined, now: Date): OfferedState {
  // A row saved under another user type (a changed role) is not this switch.
  const same = row && row.user_type === userType ? row : null;
  return userType === 'adult_athlete'
    ? { offered: true, user_type: userType, switched_on: same?.switched_on ?? false,
      address_confirmed: same?.address_confirmed ?? false, code_pending: codePending(same, now) }
    : { offered: true, user_type: userType, switched_on: same?.switched_on ?? false };
}

/**
 * A code that can still be entered: sent, not expired, tries left. GET /me
 * says so (default 9), so a page never offers a code field that can only be
 * refused (GO condition 3).
 */
function codePending(row: SwitchRow | null, now: Date): boolean {
  return Boolean(row?.pending_code_hash && row.code_expires_at
    && row.code_expires_at.getTime() > now.getTime() && row.code_attempts < EMAIL_ALERT_CODE_TRIES);
}

/**
 * Locks the person's account row, then reads their switch row for update.
 * With no switch row yet there is nothing else to lock: without the account
 * lock two first saves would both INSERT and the second would fail on the
 * primary key (23505). FOR NO KEY UPDATE holds up no row that only references
 * the account (tabletIdlePolicy.ts's rule).
 */
async function lockSwitchRow(
  client: PoolClient,
  subject: EmailAlertSwitchSubject,
): Promise<{ stored: SwitchRow | undefined; linkedAthleteId: string | null }> {
  // The account's athlete link is read under its own lock (A5).
  const account = await client.query<{ athlete_id: string | null }>(
    'select athlete_id from pilot.accounts where account_id = $1 for no key update',
    [subject.accountId],
  );
  const before = await client.query<SwitchRow>(
    `select ${SWITCH_ROW_COLUMNS} from pilot.email_alert_switches
      where organization_id = $1 and account_id = $2 for update`,
    [subject.organizationId, subject.accountId],
  );
  return { stored: before.rows[0], linkedAthleteId: account.rows[0]?.athlete_id ?? null };
}

/**
 * EVERY CHECK A WRITE RESTS ON, MADE UNDER THE WRITE'S OWN LOCKS (Overwatch and
 * Codex on #2169). Locks this person's rows -- for an athlete, their own
 * athlete row first (FOR SHARE), then the account, then the switch row -- and
 * answers, under those locks, the user type they may switch under now (null if
 * none), their switch row as stored, and whether that row is to be retired
 * (retireReason).
 * Every writer of an account's state or memberships takes the account row
 * first, role upserts included (auth.ts setAccountActiveStatus and its
 * membership upserts, activation.ts, staffProvisioning.ts, dataDeletion.ts,
 * guardianLoginMove.ts). The writers of an athlete row do not share one order:
 * deleteAthleteRecord locks the athlete row before that athlete's own account
 * (this order), but the guardian-retirement trigger
 * (pilot.cascade_parent_deletion) fires on the guardian's account update and
 * then locks the children's athlete rows FOR UPDATE -- account first. So only
 * an athlete's own row is locked here, never a row some other account is
 * linked to (A5, below). Under these locks nothing this answer rests on can
 * change until the caller commits:
 *   - the login is active and not deleted;
 *   - its membership in this gym is active, and its role still gives the user
 *     type the session's role gives;
 *   - for an athlete, the record linked to this very account is live and 18
 *     or over (the same read as emailAlertUserTypeFor).
 * A5 (carried from EM-2 #2197): for anyone else, the record their account is
 * linked to (the link read under the account lock) is read too, live and 18
 * or over in this gym, but with a plain read, not locked: locking it before
 * the account could deadlock with that trigger (40P01, a raw 500), and after
 * the account it would invert deleteAthleteRecord's order. A date of birth or
 * deletion committed just after that read can let one save through; that is
 * safe because the sender re-reads it before every send
 * (emailAlertSender.ts recheck) and the person's next own read retires the
 * row.
 * The gym's own status is answered apart (gymActive), as sign-in reads it: the
 * organization row FOR SHARE after the account lock, as parentPasswordSignIn.ts
 * does. Its only writer, setOrganizationStatus, and the gym-setting saves that
 * lock it (tabletIdlePolicy.ts, stoppedComingPolicy.ts) take no account lock
 * that waits on this one. A gym not active refuses a switch-on, but is no
 * reason to clear anyone's switch.
 */
async function lockPerson(
  client: PoolClient,
  subject: EmailAlertSwitchSubject,
  now: Date,
): Promise<{
  userType: EmailAlertUserType | null;
  gymActive: boolean;
  stored: SwitchRow | undefined;
  retire: RetireReason | null;
}> {
  const candidate = emailAlertCandidateUserType(subject.role);
  const athleteId = subject.athleteId?.trim() || null;
  if (candidate === 'adult_athlete' && athleteId) {
    await client.query('select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2 for share', [
      subject.organizationId, athleteId,
    ]);
  }
  const { stored, linkedAthleteId } = await lockSwitchRow(client, subject);
  const gym = await client.query<{ status: string }>(
    'select o.status from pilot.organizations o where o.organization_id = $1 for share',
    [subject.organizationId],
  );
  const member = await client.query<{ role: string }>(
    `select m.role
       from pilot.accounts a
       join pilot.organization_memberships m
         on m.account_id = a.account_id and m.organization_id = $2 and m.active_flag
      where a.account_id = $1 and a.active_flag and not ${accountDeletedSql('a')}`,
    [subject.accountId, subject.organizationId],
  );
  // No row: sign-in to this gym is off (the login off or deleted, the membership off or gone).
  const memberRole = member.rows[0]?.role ?? null;
  const memberType = memberRole === null ? null : emailAlertCandidateUserType(memberRole);
  // An athlete's linked record is read whatever the sign-in: a record gone or
  // under 18 retires the switch even while the login is off. So is a record
  // any other account is linked to (A5; a plain read, see above).
  const record = candidate === 'adult_athlete' ? athleteId : linkedAthleteId;
  let adult: boolean | null = null;
  if (candidate === 'adult_athlete' || record) {
    const athlete = record
      ? await client.query<{ dob: string | null }>(LINKED_ATHLETE_DOB_SQL, [subject.organizationId, subject.accountId, record])
      : { rows: [] };
    adult = athlete.rows[0] !== undefined && !isMinor(athlete.rows[0].dob, now);
  }
  const userType = memberType !== null && memberType === candidate && adult !== false ? candidate : null;
  return {
    userType,
    gymActive: gym.rows[0]?.status === 'active',
    stored,
    retire: retireReason(stored, adult, memberType, candidate),
  };
}

type RetireReason = 'no_longer_offered' | 'user_type_changed';

/**
 * WHAT A CHANGE DOES TO A SWITCH (OVERWATCH on #2169, 7182466510, applying
 * OD-2026-11-19-019 and OW27-08 A): an opt-in is the person's choice. It pauses
 * while they cannot receive under its terms, resumes when they can, and is
 * retired only when they themselves would otherwise see it off, or when the
 * record is gone. Decided under lockPerson's locks, for a row that is on or
 * holds an address:
 *   - an athlete whose linked record is gone, unlinked or under 18: retired,
 *     whatever their sign-in (A1's guarantee; OD-2026-10-04-010); so is any
 *     other account linked to such a record (A5);
 *   - sign-in to this gym off (memberType null): kept, paused (T-3 A). The
 *     sender skips it as sign_in_off, and the gym's own status never retires;
 *   - a role with no switch (volunteer, board, the 'staff' role): kept, paused
 *     (T-2 A). The route refuses these roles before the store anyway;
 *   - a role of another user type (staff to parent or back): retired as
 *     user_type_changed (T-1 A), by a read or write under the new type only
 *     (`sessionType` is the type the request is made under). A request still
 *     under the old type, from a session left over a role change (role writers
 *     end sessions), is refused and leaves the row for that read. A change and
 *     back with no own read between keeps it: it was never shown off, and
 *     nothing was sent meanwhile;
 *   - otherwise kept.
 */
function retireReason(
  stored: SwitchRow | undefined,
  adult: boolean | null,
  memberType: EmailAlertUserType | null,
  sessionType: EmailAlertUserType | null,
): RetireReason | null {
  if (!stored || (!stored.switched_on && !stored.holds_address)) return null;
  if (adult === false) return 'no_longer_offered';
  if (memberType === null || memberType === stored.user_type) return null;
  return memberType === sessionType ? 'user_type_changed' : null;
}

function audit(client: PoolClient, subject: EmailAlertSwitchSubject, details: Record<string, unknown>) {
  return writePilotAuditEvent({
    event_type: 'update',
    actor_account_id: subject.accountId,
    actor_role: subject.role,
    organization_id: subject.organizationId,
    entity_type: 'email_alert_switch',
    entity_id: subject.accountId,
    details,
    // A person's own preference: nothing for SHADOW to learn from.
    shadow_mirror: false,
  }, client);
}

/**
 * Someone no longer offered a switch (date of birth corrected to under 18,
 * record deleted) keeps none that is on and no address: cleared quietly at
 * their next own read or write, the lazy clean-up the escalations read does for
 * ended holds. So does someone whose user type has changed (staff to parent or
 * back, T-1 A on #2169): the row left under the other type is switched off, so
 * once they have read or saved under the new type, an old opt-in does not come
 * back with a later change back. Sign-in switched off
 * and a role with no switch only pause it (retireReason). Every case is decided
 * again under the retire's own locks (lockPerson), so a person offered that
 * row's type again by then keeps it. The sender (EM-3) re-checks every person
 * before every send anyway.
 */
async function retireSwitchIfAny(subject: EmailAlertSwitchSubject, now: Date): Promise<void> {
  // Most never had a row (every athlete under 18): one read, no lock.
  const leftover = await queryOne<{ found: boolean }>(
    `select true as found from pilot.email_alert_switches
      where organization_id = $1 and account_id = $2 and (switched_on or ${HOLDS_ADDRESS})`,
    [subject.organizationId, subject.accountId],
  );
  if (!leftover) return;
  await withTransaction(async (client) => {
    const { stored, retire } = await lockPerson(client, subject, now);
    if (stored && retire) await retireRow(client, subject, stored, retire);
  });
}

/** Switches the locked row off and clears its address, audited with the reason (retireReason). */
async function retireRow(client: PoolClient, subject: EmailAlertSwitchSubject, row: SwitchRow, reason: RetireReason) {
  await client.query(
    `update pilot.email_alert_switches s set
         switched_on = false,
         switched_off_at = case when s.switched_on then clock_timestamp() else s.switched_off_at end,
         set_at = clock_timestamp(),
         ${addressColumns('false')}
       where s.organization_id = $1 and s.account_id = $2`,
    [subject.organizationId, subject.accountId],
  );
  await audit(client, subject, {
    user_type: row.user_type,
    switched_on: false,
    previous_switched_on: row.switched_on,
    address_cleared: row.holds_address,
    reason,
  });
}

export async function readEmailAlertSwitch(
  subject: EmailAlertSwitchSubject,
  now: Date = new Date(),
): Promise<EmailAlertSwitchState> {
  const userType = await emailAlertUserTypeFor(subject, now);
  if (!userType) {
    await retireSwitchIfAny(subject, now);
    return { offered: false };
  }
  const readRow = () => queryOne<SwitchRow>(
    `select ${SWITCH_ROW_COLUMNS} from pilot.email_alert_switches
      where organization_id = $1 and account_id = $2`,
    [subject.organizationId, subject.accountId],
  );
  const row = await readRow();
  // A row left on, or holding an address, under another user type is retired
  // now (T-1 A on #2169), so what the page shows off is off. (A sign-in switched
  // off while this waits keeps it, paused: retireReason.)
  if (row && row.user_type !== userType && (row.switched_on || row.holds_address)) {
    await retireSwitchIfAny(subject, now);
    return stateFrom(userType, await readRow(), now);
  }
  return stateFrom(userType, row, now);
}

export async function setEmailAlertSwitch(
  subject: EmailAlertSwitchSubject & { readonly switchedOn: unknown },
  now: Date = new Date(),
): Promise<EmailAlertSwitchState> {
  if (typeof subject.switchedOn !== 'boolean') {
    throw new ValidationError('switched_on must be true or false');
  }
  const switchedOn = subject.switchedOn;
  const userType = await emailAlertUserTypeFor(subject, now);
  if (!userType) {
    await retireSwitchIfAny(subject, now);
    throw notOffered();
  }

  let retiredFirst = false;
  const saved = await withTransaction(async (client) => {
    // Everything the save rests on, again under its own locks (lockPerson):
    // nothing is written unless the person is still offered this user type.
    // A gym not active refuses a switch-on; a switch-off grants nothing and is
    // kept, so an opt-out is never lost to a suspension lifted later.
    const { userType: underLock, gymActive, stored, retire } = await lockPerson(client, subject, now);
    if (underLock !== userType || (switchedOn && !gymActive)) return null;
    // A row left on under another user type is retired first (T-1 A), so the
    // save starts from off, under the new type. A 409 below rolls this back
    // with the save; it is then made again on its own (the catch after).
    let current = stored;
    if (stored && retire === 'user_type_changed') {
      await retireRow(client, subject, stored, retire);
      retiredFirst = true;
      current = { ...stored, switched_on: false, address_confirmed: false, holds_address: false };
    }
    try {
      return await saveSwitch(client, subject, userType, switchedOn, current, now);
    } catch (error) {
      throw notOfferedIfMembershipGone(error);
    }
  }).catch(async (error: unknown) => {
    // A write under the new type that ends in a 409 (an adult athlete's row
    // retyped has no confirmed address) still retires the old row (T-1 A).
    if (retiredFirst && error instanceof ConflictError) {
      // The 409 is the answer; a failure of this retry is logged, not returned instead.
      await retireSwitchIfAny(subject, now).catch((retryError: unknown) => {
        console.warn('email alert switch: retire after a 409 failed', {
          reason: retryError instanceof Error ? retryError.name : 'unknown',
        });
      });
    }
    throw error;
  });
  if (saved) return saved;
  // Refused under the locks. The retire decides again under its own: a record
  // gone or under 18, or a user type changed to the one this request is made
  // under, retires the row; sign-in switched off, a role with no switch, or a
  // request still under the old type leaves it as it was (T-1 A to T-3 A).
  await retireSwitchIfAny(subject, now);
  throw notOffered();
}

function notOffered(): ForbiddenError {
  return new ForbiddenError('Forbidden: email alerts are not offered to this account');
}

/**
 * Defensive: a membership row deleted after lockPerson read it, by a writer
 * that takes neither the account nor the gym row. No writer does that today:
 * the only delete of membership rows
 * (scripts/pilot-cleanup-membership-orphans.mjs) removes rows whose account is
 * already gone, which lockPerson refuses. EM-1a's membership key then refuses
 * the insert: the same answer as anyone not offered a switch, not a raw error.
 * Only that key's 23503; anything else stays an error. The pg suite times it
 * with a held delete.
 */
function notOfferedIfMembershipGone(error: unknown): unknown {
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === '23503' && pgError.constraint === 'pilot_email_alert_switch_membership_fk' ? notOffered() : error;
}

async function saveSwitch(
  client: PoolClient,
  subject: EmailAlertSwitchSubject,
  userType: EmailAlertUserType,
  switchedOn: boolean,
  stored: SwitchRow | undefined,
  now: Date,
): Promise<EmailAlertSwitchState> {
  const previous = stateFrom(userType, stored, now);
  // Times and audit describe the row as stored, whatever type it was saved under.
  const storedOn = stored?.switched_on ?? false;
  const retyped = stored !== undefined && stored.user_type !== userType;

  if (userType === 'adult_athlete' && switchedOn && previous.address_confirmed !== true) {
    throw new ConflictError('Confirm an email address before switching email alerts on');
  }

  // UPDATE the locked row, or INSERT when there is none. Not INSERT ... ON
  // CONFLICT: Postgres checks the CHECKs on the proposed row first, which has
  // no address, so a confirmed adult athlete could never switch on. A row
  // saved under another user type loses any address.
  if (stored) {
    await client.query(
      `update pilot.email_alert_switches s set
         user_type = $3,
         switched_on = $4,
         switched_on_at = case when $4 and (not $5 or $6) then clock_timestamp() else s.switched_on_at end,
         switched_off_at = case when not $4 and $5 then clock_timestamp() else s.switched_off_at end,
         set_at = clock_timestamp(),
         ${addressColumns("$3 = 'adult_athlete'")}
       where s.organization_id = $1 and s.account_id = $2`,
      [subject.organizationId, subject.accountId, userType, switchedOn, storedOn, retyped],
    );
  } else {
    await client.query(
      `insert into pilot.email_alert_switches
         (organization_id, account_id, user_type, switched_on, switched_on_at, switched_off_at, set_at)
       values ($1, $2, $3, $4, case when $4 then clock_timestamp() end,
               case when not $4 then clock_timestamp() end, clock_timestamp())`,
      [subject.organizationId, subject.accountId, userType, switchedOn],
    );
  }
  await audit(client, subject, {
    user_type: userType,
    switched_on: switchedOn,
    previous_switched_on: storedOn,
    ...(retyped && stored ? { previous_user_type: stored.user_type } : {}),
  });

  // A switch save leaves the address and its code as they were.
  return { ...previous, switched_on: switchedOn };
}

/*
 * THE ADULT ATHLETE'S ADDRESS (lane W4-1, EM-2b-2). OW27-38 B: an adult
 * athlete types an address beside their switch; it is used only after they
 * enter a code the app emails to it; that one code email may say more than
 * "open the app" (emailAlertCode.ts writes it). Plan #2159 section 8: POST
 * sends a code, PUT enters it, the tries are capped on the row, no DELETE.
 * OW27-02 C: an athlete under 18 or with no date of birth (OD-2026-10-04-010)
 * never stores or confirms an address (L1 rule: nothing new shown to a minor):
 * the adult check comes before anything is reserved, written, audited or sent,
 * and again under the write's own locks (lockPerson). "Default N" below is
 * item N of the defaults Overwatch GO'd on EM-2b (#2159 comment 7189871985).
 */

/** Jason's Q-1 A: "The code works once and expires in 15 minutes." */
export const EMAIL_ALERT_CODE_LIFETIME_MS = 15 * 60 * 1000;
/** Default 3: tries per code; at the cap every try is refused until a new code is sent. */
export const EMAIL_ALERT_CODE_TRIES = 5;
/** Default 4(b): one person, one code email a minute. */
const CODE_RESEND_MS = 60 * 1000;
/** Default 4(c): one person, five code emails a day in each gym. */
const CODE_EMAILS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sends the one code email (emailAlertCode.ts, emailAlertCodeMailer). Injected so tests never reach Graph. */
export type EmailAlertCodeMailer = (message: { organizationId: string; to: string; code: string }) => Promise<void>;

/** Default 1: six digits from crypto.randomInt, zero-padded. */
export function newEmailAlertCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Trimmed and lowercased, as a sign-in address is (magicLink.ts
 * normalizeEmail), or null: empty, over 254 characters, or not the shape the
 * mailer itself refuses (graphMailer.ts EMAIL_SHAPE).
 */
export function normalizeEmailAlertAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const address = raw.trim().toLowerCase();
  return address.length <= 254 && EMAIL_SHAPE.test(address) ? address : null;
}

/**
 * Default 2: the stored form of a code, bound to one gym, account and address
 * (as activation.ts prefixes its hash), so a code is worth nothing for any
 * other address, even this person's next one.
 */
export function emailAlertCodeHash(organizationId: string, accountId: string, address: string, code: string): string {
  return hashToken(`email-alert-code:${organizationId}:${accountId}:${address}:${code}`);
}

/** Default 4: every limit answers exactly this, so no answer says which limit, or anything about the address. */
export function emailAlertCodeLimitError(): PilotError {
  return new PilotError(429, 'Too many code emails. Wait a few minutes, then ask again.', 'EMAIL_ALERT_CODE_LIMIT');
}

/**
 * The adult check before anything else: anyone else gets the plain 403 once
 * any leftover is retired. The address route asks it too, before it reads the
 * query or the body (L1; Codex on EM-2b-2), so a minor's answer never depends
 * on what they sent; the store asks it again, and again under its locks.
 */
export async function refuseUnlessAdultAthlete(subject: EmailAlertSwitchSubject, now: Date = new Date()): Promise<void> {
  if ((await emailAlertUserTypeFor(subject, now)) === 'adult_athlete') return;
  await retireSwitchIfAny(subject, now);
  throw notOffered();
}

/**
 * lockPerson for an address write: null unless the person is offered an adult
 * athlete's switch under the locks, in an active gym (default 12, as a
 * switch-on is). A row left on under another user type is retired first (T-1
 * A), as a save does. Returns the row as stored before any retire.
 */
async function lockAdultAthlete(client: PoolClient, subject: EmailAlertSwitchSubject, now: Date) {
  const { userType, gymActive, stored, retire } = await lockPerson(client, subject, now);
  if (userType !== 'adult_athlete' || !gymActive) return null;
  if (stored && retire === 'user_type_changed') await retireRow(client, subject, stored, retire);
  return { stored, row: stored?.user_type === 'adult_athlete' ? stored : undefined };
}

/** Clears the typed address and its code, audited with why. */
async function clearPendingCode(client: PoolClient, subject: EmailAlertSwitchSubject, details: Record<string, unknown>) {
  await client.query(
    `update pilot.email_alert_switches
        set pending_address = null, pending_code_hash = null, pending_code_expires_at = null, pending_code_attempts = 0
      where organization_id = $1 and account_id = $2`,
    [subject.organizationId, subject.accountId],
  );
  await audit(client, subject, { user_type: 'adult_athlete', ...details });
}

function codeExpired(row: SwitchRow | undefined, now: Date): boolean {
  return Boolean(row?.code_expires_at && row.code_expires_at.getTime() <= now.getTime());
}

/**
 * Default 4(b) and (c), read under the row lock: whether this person may have
 * another code email now. (b): a code's send time is its expiry less its
 * lifetime, so the minute restarts after a confirm or a voided send, while
 * (c) still holds and counts every send, failed ones too. (c) counts this
 * feature's own audit rows (the entity index serves it), comparing the app's
 * clock with the database-stamped created_at: a skew of seconds under NTP,
 * nothing against a day.
 */
async function personLimited(client: PoolClient, subject: EmailAlertSwitchSubject, row: SwitchRow | undefined, now: Date) {
  const lastSentMs = row?.code_expires_at ? row.code_expires_at.getTime() - EMAIL_ALERT_CODE_LIFETIME_MS : null;
  const tooSoon = lastSentMs !== null && now.getTime() < lastSentMs + CODE_RESEND_MS;
  const sent = await client.query<{ n: number }>(
    `select count(*)::int as n from pilot.audit_events
      where organization_id = $1 and entity_type = 'email_alert_switch' and entity_id = $2
        and details->>'address_action' = 'code_sent' and created_at > $3`,
    [subject.organizationId, subject.accountId, new Date(now.getTime() - DAY_MS)],
  );
  return tooSoon || sent.rows[0].n >= CODE_EMAILS_PER_DAY;
}

/**
 * POST: emails a code to the address typed. Default 5: a confirmed address
 * stays in use until the new one is confirmed, and a new POST replaces the
 * typed address and voids its code. Default 6: whether the address is anyone's
 * sign-in address is never looked up, so no answer, timing or log line can say
 * (magicLink.ts's rule). Default 11: an expired, unconfirmed address is
 * cleared here. Default 13: a send that fails voids its code only while it is
 * still the newest, and answers 503. L1: the adult check comes before the
 * address is even read, so a minor's answer never depends on what they typed.
 */
export async function requestEmailAlertAddressCode(
  subject: EmailAlertSwitchSubject & { readonly address: unknown },
  sendCode: EmailAlertCodeMailer,
  now: Date = new Date(),
): Promise<EmailAlertSwitchState> {
  await refuseUnlessAdultAthlete(subject, now);
  const address = normalizeEmailAlertAddress(subject.address);
  if (!address) throw new ValidationError('Enter a valid email address');
  // Default 4(a): the address's own budget, the sign-in link's limiter
  // (rateLimit.ts), keyed by hashToken (security.ts): an unkeyed SHA-256 of
  // the address. Better than sign-in's buckets, which hold the raw address,
  // but not secret: anyone who can read the buckets can test a guessed
  // address against it.
  const addressKey = `email_alert_code_address:${hashToken(address)}`;

  // This person's own limits first, so a person held by them never spends
  // the address's budget: else one athlete, inside their own minute, could
  // keep any address they chose from ever being confirmed.
  const checked = await withTransaction(async (client) => {
    const person = await lockAdultAthlete(client, subject, now);
    if (!person) return 'refused' as const;
    if (codeExpired(person.row, now)) await clearPendingCode(client, subject, { address_action: 'expired_cleared' });
    return (await personLimited(client, subject, person.row, now)) ? 'limited' as const : 'open' as const;
  });
  if (checked === 'refused') {
    await retireSwitchIfAny(subject, now);
    throw notOffered();
  }
  if (checked === 'limited') throw emailAlertCodeLimitError();
  if ((await reserveAttempts([addressKey])).isLimited) throw emailAlertCodeLimitError();

  const code = newEmailAlertCode();
  const codeHash = emailAlertCodeHash(subject.organizationId, subject.accountId, address, code);
  const outcome = await withTransaction(async (client) => {
    // Everything again under the write's own locks: a POST of this person's
    // that landed meanwhile is the 60 seconds' to refuse.
    const person = await lockAdultAthlete(client, subject, now);
    if (!person) return 'refused' as const;
    const { stored, row } = person;
    if (await personLimited(client, subject, row, now)) return 'limited' as const;
    // One statement whether or not a row exists: the proposed row is off, so
    // every CHECK passes on it, and an existing row keeps its switch and any
    // confirmed address (default 5).
    try {
      await client.query(
        `insert into pilot.email_alert_switches as s
           (organization_id, account_id, user_type, pending_address, pending_code_hash, pending_code_expires_at)
         values ($1, $2, 'adult_athlete', $3, $4, $5)
         on conflict (organization_id, account_id) do update set
           user_type = 'adult_athlete',
           pending_address = excluded.pending_address,
           pending_code_hash = excluded.pending_code_hash,
           pending_code_expires_at = excluded.pending_code_expires_at,
           pending_code_attempts = 0`,
        [subject.organizationId, subject.accountId, address, codeHash, new Date(now.getTime() + EMAIL_ALERT_CODE_LIFETIME_MS)],
      );
    } catch (error) {
      throw notOfferedIfMembershipGone(error);
    }
    await audit(client, subject, {
      user_type: 'adult_athlete',
      address_action: 'code_sent',
      ...(stored && stored.user_type !== 'adult_athlete' ? { previous_user_type: stored.user_type } : {}),
    });
    return { ...stateFrom('adult_athlete', row, now), code_pending: true };
  });
  if (outcome === 'refused') {
    await retireSwitchIfAny(subject, now);
    throw notOffered();
  }
  if (outcome === 'limited') throw emailAlertCodeLimitError();

  // Asked once more just before Graph: a date of birth corrected after the
  // commit sends nothing, and the code is voided while it is still the newest.
  // If the question itself cannot be answered, nothing is sent either, and the
  // code is voided the same way, so no code stands pending without its email
  // (GO condition 3; reviewer A's re-read).
  let stillAdult: boolean;
  try {
    stillAdult = (await emailAlertUserTypeFor(subject, now)) === 'adult_athlete';
  } catch (error) {
    await voidCodeIfNewest(subject, codeHash, 'send_failed').catch((voidError: unknown) => {
      console.error('email alert code: voiding an unsent code failed', { errorClass: errorClass(voidError) });
    });
    console.error('email alert code: the age check before sending failed', { errorClass: errorClass(error) });
    throw new ServiceUnavailableError('The code email could not be sent. Try again in a few minutes.', 'EMAIL_ALERT_CODE_NOT_SENT');
  }
  if (!stillAdult) {
    await voidCodeIfNewest(subject, codeHash, 'no_longer_offered');
    await retireSwitchIfAny(subject, now);
    throw notOffered();
  }
  // Sent after the commit, so no lock waits on Graph.
  try {
    await sendCode({ organizationId: subject.organizationId, to: address, code });
  } catch (error) {
    await voidCodeIfNewest(subject, codeHash, 'send_failed').catch((voidError: unknown) => {
      console.error('email alert code: voiding an unsent code failed', { errorClass: errorClass(voidError) });
    });
    // Shape only: never the address, the code or a message that could carry them.
    console.error('email alert code: the code email was not sent', {
      errorClass: errorClass(error),
      reason: error instanceof MailSendError ? error.reason : null,
      statusCode: error instanceof MailSendError ? error.statusCode ?? null : null,
      // Shape-checked by the mailer so it cannot be an address (extractGraphErrorCode).
      graphErrorCode: error instanceof MailSendError ? error.graphErrorCode ?? null : null,
    });
    throw new ServiceUnavailableError('The code email could not be sent. Try again in a few minutes.', 'EMAIL_ALERT_CODE_NOT_SENT');
  }
  return outcome;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Default 13: the code whose email failed, or was not sent, is voided only
 * while it is still the newest, compared by hash under the row lock, so a
 * later POST's code is never touched. The account then switch row, lockPerson's
 * order.
 */
async function voidCodeIfNewest(subject: EmailAlertSwitchSubject, codeHash: string, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    const { stored } = await lockSwitchRow(client, subject);
    if (stored?.pending_code_hash === codeHash) {
      await clearPendingCode(client, subject, { address_action: 'code_voided', reason });
    }
  });
}

type ConfirmRefusal = 'expired' | 'tries_used' | 'wrong';

const CONFIRM_REFUSALS: Record<ConfirmRefusal, () => ConflictError> = {
  expired: () => new ConflictError('No code is waiting, or it has expired. Ask for a new one.', 'EMAIL_ALERT_CODE_EXPIRED'),
  tries_used: () => new ConflictError('That code has had too many tries. Ask for a new one.', 'EMAIL_ALERT_CODE_TRIES_USED'),
  wrong: () => new ConflictError('That code is not right. Check the email and try again.', 'EMAIL_ALERT_CODE_WRONG'),
};

/**
 * PUT: enters the code. Right, the typed address becomes the confirmed one.
 * Default 10: confirming never switches the alert on (OD-2026-11-19-019); On
 * stays its own press (setEmailAlertSwitch). A wrong code costs one of the
 * row's tries; an expired one is cleared (default 11).
 */
export async function confirmEmailAlertAddress(
  subject: EmailAlertSwitchSubject & { readonly code: unknown },
  now: Date = new Date(),
): Promise<EmailAlertSwitchState> {
  await refuseUnlessAdultAthlete(subject, now);
  // After the adult check (L1): a minor's answer never depends on what they typed.
  const code = typeof subject.code === 'string' ? subject.code.trim() : '';
  if (!/^\d{6}$/.test(code)) throw new ValidationError('Enter the six-digit code from the email');

  const outcome = await withTransaction(async (client): Promise<'refused' | ConfirmRefusal | OfferedState> => {
    const person = await lockAdultAthlete(client, subject, now);
    if (!person) return 'refused';
    const { row } = person;
    if (!row?.pending_code_hash || !row.pending_address || !row.code_expires_at) return 'expired';
    if (codeExpired(row, now)) {
      await clearPendingCode(client, subject, { address_action: 'expired_cleared' });
      return 'expired';
    }
    if (row.code_attempts >= EMAIL_ALERT_CODE_TRIES) return 'tries_used';
    if (emailAlertCodeHash(subject.organizationId, subject.accountId, row.pending_address, code) !== row.pending_code_hash) {
      await client.query(
        `update pilot.email_alert_switches set pending_code_attempts = pending_code_attempts + 1
          where organization_id = $1 and account_id = $2`,
        [subject.organizationId, subject.accountId],
      );
      await audit(client, subject, { user_type: 'adult_athlete', address_action: 'code_wrong', tries: row.code_attempts + 1 });
      return 'wrong';
    }
    await client.query(
      `update pilot.email_alert_switches
          set confirmed_address = pending_address, confirmed_at = clock_timestamp(),
              pending_address = null, pending_code_hash = null, pending_code_expires_at = null, pending_code_attempts = 0
        where organization_id = $1 and account_id = $2`,
      [subject.organizationId, subject.accountId],
    );
    await audit(client, subject, {
      user_type: 'adult_athlete',
      address_action: 'confirmed',
      replaced_confirmed: row.address_confirmed,
      switched_on: row.switched_on,
    });
    return { offered: true, user_type: 'adult_athlete', switched_on: row.switched_on, address_confirmed: true, code_pending: false };
  });
  if (outcome === 'refused') {
    await retireSwitchIfAny(subject, now);
    throw notOffered();
  }
  if (typeof outcome === 'string') throw CONFIRM_REFUSALS[outcome]();
  return outcome;
}
