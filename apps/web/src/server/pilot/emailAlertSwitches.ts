/**
 * EACH PERSON'S EMAIL ALERT SWITCH (lane W4-1, EM-1b). OD-2026-11-19-019: an
 * opt-in email that says only "open the app"; OW27-10 A: one switch on each
 * person's own settings page. Reads and writes the caller's own switch only.
 *
 * WHO (OW27-02 C): coach, admin, organization admin ('staff'), parents
 * ('parent'), and athletes 18 or over ('adult_athlete'), judged on the athlete
 * record linked to this account; no date of birth counts as a minor
 * (OD-2026-10-04-010). Anyone else gets `{ offered: false }` and nothing more
 * (no new warning, L1 rule); a row left from when they were offered one is
 * switched off and its address cleared then (retireSwitchIfAny).
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
 * they may switch under now (null if none) and their switch row as stored.
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
): Promise<{ userType: EmailAlertUserType | null; gymActive: boolean; stored: SwitchRow | undefined }> {
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
  let userType = member.rows[0] && emailAlertCandidateUserType(member.rows[0].role) === candidate ? candidate : null;
  if (userType === 'adult_athlete') {
    const athlete = athleteId
      ? await client.query<{ dob: string | null }>(LINKED_ATHLETE_DOB_SQL, [subject.organizationId, subject.accountId, athleteId])
      : { rows: [] };
    if (!athlete.rows[0] || isMinor(athlete.rows[0].dob, now)) userType = null;
  }
  return { userType, gymActive: gym.rows[0]?.status === 'active', stored };
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
 * ended holds. Whether they are offered is decided again under the retire's own
 * locks (lockPerson), so a person offered again by then keeps their row. The
 * sender (EM-3) re-checks every person before every send anyway.
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
    const { userType, stored: row } = await lockPerson(client, subject, now);
    if (userType !== null) return;
    if (!row || (!row.switched_on && !row.holds_address)) return;
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
      reason: 'no_longer_offered',
    });
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
  const row = await queryOne<SwitchRow>(
    `select ${SWITCH_ROW_COLUMNS} from pilot.email_alert_switches
      where organization_id = $1 and account_id = $2`,
    [subject.organizationId, subject.accountId],
  );
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

  const saved = await withTransaction(async (client) => {
    // Everything the save rests on, again under its own locks (lockPerson):
    // nothing is written unless the person is still offered this user type.
    // A gym not active refuses a switch-on; a switch-off grants nothing and is
    // kept, so an opt-out is never lost to a suspension lifted later.
    const { userType: underLock, gymActive, stored } = await lockPerson(client, subject, now);
    if (underLock !== userType || (switchedOn && !gymActive)) return null;
    try {
      return await saveSwitch(client, subject, userType, switchedOn, stored);
    } catch (error) {
      // A membership row deleted after lockPerson read it, by a writer that
      // takes neither the account nor the gym row (EM-1a's membership key):
      // the same answer as anyone not offered a switch, not a raw error. Only
      // that key's 23503; anything else stays an error.
      const pgError = error as { code?: unknown; constraint?: unknown };
      if (pgError.code === '23503' && pgError.constraint === 'pilot_email_alert_switch_membership_fk') {
        throw new ForbiddenError('Forbidden: email alerts are not offered to this account');
      }
      throw error;
    }
  });
  if (saved) return saved;
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
