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
 * GO on #2159, condition 3); the table's CHECK refuses it too. Every change is
 * audited in the same transaction. No address field is audited; the audit row
 * names the account by its id, which can itself be the sign-in address (see
 * the email-alert-switches migration).
 */

import type { PoolClient } from 'pg';

import { isMinor } from '@/src/lib/minorAge';
import { emailAlertCandidateUserType, type EmailAlertUserType } from '@/src/shared/emailAlerts';

import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { queryOne, withTransaction } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { ConflictError, ForbiddenError, ValidationError } from './errors';

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
  };

/**
 * The user type this account may switch under now, or null. An athlete's age
 * is read through pilot.accounts, so a caller cannot point it at another record.
 */
export async function emailAlertUserTypeFor(
  subject: EmailAlertSwitchSubject,
  now: Date = new Date(),
): Promise<EmailAlertUserType | null> {
  const candidate = emailAlertCandidateUserType(subject.role);
  if (candidate !== 'adult_athlete') return candidate;
  const athleteId = subject.athleteId?.trim();
  if (!athleteId) return null;
  const row = await queryOne<{ dob: string | null }>(LINKED_ATHLETE_DOB_SQL, [subject.organizationId, subject.accountId, athleteId]);
  if (!row) return null;
  return isMinor(row.dob, now) ? null : 'adult_athlete';
}

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
}

const HOLDS_ADDRESS = 'pending_address is not null or pending_code_hash is not null or confirmed_address is not null';
const SWITCH_ROW_COLUMNS = `user_type, switched_on, confirmed_address is not null as address_confirmed,
            (${HOLDS_ADDRESS}) as holds_address`;

/** The address columns, kept where `keep` is true and cleared where it is not. */
function addressColumns(keep: string): string {
  return ['pending_address', 'pending_code_hash', 'pending_code_expires_at', 'confirmed_address', 'confirmed_at']
    .map((column) => `${column} = case when ${keep} then s.${column} end`)
    .concat(`pending_code_attempts = case when ${keep} then s.pending_code_attempts else 0 end`)
    .join(',\n           ');
}

type OfferedState = Extract<EmailAlertSwitchState, { offered: true }>;

function stateFrom(userType: EmailAlertUserType, row: SwitchRow | null | undefined): OfferedState {
  // A row saved under another user type (a changed role) is not this switch.
  const same = row && row.user_type === userType ? row : null;
  return userType === 'adult_athlete'
    ? { offered: true, user_type: userType, switched_on: same?.switched_on ?? false, address_confirmed: same?.address_confirmed ?? false }
    : { offered: true, user_type: userType, switched_on: same?.switched_on ?? false };
}

/**
 * Locks the person's account row, then reads their switch row for update.
 * With no switch row yet there is nothing else to lock: without the account
 * lock two first saves would both INSERT and the second would fail on the
 * primary key (23505). FOR NO KEY UPDATE holds up no row that only references
 * the account (tabletIdlePolicy.ts's rule).
 */
async function lockSwitchRow(client: PoolClient, subject: EmailAlertSwitchSubject): Promise<SwitchRow | undefined> {
  await client.query('select 1 from pilot.accounts where account_id = $1 for no key update', [subject.accountId]);
  const before = await client.query<SwitchRow>(
    `select ${SWITCH_ROW_COLUMNS} from pilot.email_alert_switches
      where organization_id = $1 and account_id = $2 for update`,
    [subject.organizationId, subject.accountId],
  );
  return before.rows[0];
}

/**
 * EVERY CHECK A WRITE RESTS ON, MADE UNDER THE WRITE'S OWN LOCKS (Overwatch and
 * Codex on #2169). Locks this person's rows in the order every other writer
 * takes them -- the athlete row first (FOR SHARE, for an athlete), then the
 * account, then the switch row -- and answers, under those locks, the user type
 * they may switch under now (null if none), their switch row as stored, and
 * whether that row is to be retired (retireReason).
 * Every writer of an account's state or memberships takes the account row
 * first, role upserts included (auth.ts setAccountActiveStatus and its
 * membership upserts, activation.ts, staffProvisioning.ts, dataDeletion.ts,
 * guardianLoginMove.ts), and every writer of an athlete row locks it before
 * the account (deleteAthleteRecord, the guardian-retirement trigger), so
 * nothing this answer rests on can change until the caller commits:
 *   - the login is active and not deleted;
 *   - its membership in this gym is active, and its role still gives the user
 *     type the session's role gives;
 *   - for an athlete, the record linked to this very account is live and 18
 *     or over (the same read as emailAlertUserTypeFor).
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
  const stored = await lockSwitchRow(client, subject);
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
  // under 18 retires the switch even while the login is off.
  let adult: boolean | null = null;
  if (candidate === 'adult_athlete') {
    const athlete = athleteId
      ? await client.query<{ dob: string | null }>(LINKED_ATHLETE_DOB_SQL, [subject.organizationId, subject.accountId, athleteId])
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
 *     whatever their sign-in (A1's guarantee; OD-2026-10-04-010);
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
    return stateFrom(userType, await readRow());
  }
  return stateFrom(userType, row);
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
    throw new ForbiddenError('Forbidden: email alerts are not offered to this account');
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
      return await saveSwitch(client, subject, userType, switchedOn, current);
    } catch (error) {
      // Defensive: a membership row deleted after lockPerson read it, by a
      // writer that takes neither the account nor the gym row. No writer does
      // that today: the only delete of membership rows
      // (scripts/pilot-cleanup-membership-orphans.mjs) removes rows whose
      // account is already gone, which lockPerson refuses. EM-1a's membership
      // key then refuses the insert: the same answer as anyone not offered a
      // switch, not a raw error. Only that key's 23503; anything else stays an
      // error. The pg suite times it with a held delete.
      const pgError = error as { code?: unknown; constraint?: unknown };
      if (pgError.code === '23503' && pgError.constraint === 'pilot_email_alert_switch_membership_fk') {
        throw new ForbiddenError('Forbidden: email alerts are not offered to this account');
      }
      throw error;
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
  throw new ForbiddenError('Forbidden: email alerts are not offered to this account');
}

async function saveSwitch(
  client: PoolClient,
  subject: EmailAlertSwitchSubject,
  userType: EmailAlertUserType,
  switchedOn: boolean,
  stored: SwitchRow | undefined,
): Promise<EmailAlertSwitchState> {
  const previous = stateFrom(userType, stored);
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

  return userType === 'adult_athlete'
    ? { offered: true, user_type: userType, switched_on: switchedOn, address_confirmed: previous.address_confirmed === true }
    : { offered: true, user_type: userType, switched_on: switchedOn };
}
