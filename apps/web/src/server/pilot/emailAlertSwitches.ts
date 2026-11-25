/**
 * EACH PERSON'S EMAIL ALERT SWITCH (lane W4-1, EM-1; W4 item 1).
 *
 * Jason, OD-2026-11-19-019: an opt-in, content-free email that says only
 * "open the app". OW27-10 A: "Each person turns their own email on or off with
 * one switch on their own settings page." This module reads and writes that
 * switch, for the caller's own account only. Which events send, the sender
 * and the email itself are other PRs (EM-5, EM-3, EM-4a/b).
 *
 * WHO IS OFFERED A SWITCH (OW27-02 C): coach, admin and organization admin
 * (user type 'staff'), parents ('parent'), and athletes 18 or over
 * ('adult_athlete'). An athlete's age is read from their own athlete record on
 * every call; no date of birth, or no live athlete record, counts as a minor
 * (OD-2026-10-04-010). A person who is not offered one gets `{ offered: false }`
 * and nothing else: no reason, no warning (the brief's L1 rule). If they still
 * have a row from when they were offered one, it is switched off and any
 * address cleared at that moment (retireSwitchIfAny, below).
 *
 * AN ADULT ATHLETE NEEDS A CONFIRMED ADDRESS FIRST (OW27-38 B; Overwatch GO on
 * #2159, condition 3). Athletes have no sign-in address; the address and its
 * code are EM-2b. Until a confirmed address exists, switching on is refused
 * here, and the table's CHECK refuses it again.
 *
 * Every save writes one audit row (user type, on/off before and after) in the
 * same transaction. No address is ever written to the audit stream.
 */

import { isMinor } from '@/src/lib/minorAge';
import { emailAlertCandidateUserType, type EmailAlertUserType } from '@/src/shared/emailAlerts';

import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { queryOne, withTransaction } from './db';
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
 * The user type this account may switch under right now, or null. For an
 * athlete, null unless the athlete record linked to this very account, in this
 * gym, is live and says 18 or over. The link is read from pilot.accounts, so a
 * caller cannot point the age check at somebody else's record.
 */
export async function emailAlertUserTypeFor(
  subject: EmailAlertSwitchSubject,
  now: Date = new Date(),
): Promise<EmailAlertUserType | null> {
  const candidate = emailAlertCandidateUserType(subject.role);
  if (candidate !== 'adult_athlete') return candidate;
  const athleteId = subject.athleteId?.trim();
  if (!athleteId) return null;
  const row = await queryOne<{ dob: string | null }>(
    `select to_char(ath.dob, 'YYYY-MM-DD') as dob
       from pilot.accounts acc
       join pilot.athletes ath
         on ath.organization_id = $1 and ath.athlete_id = acc.athlete_id
      where acc.account_id = $2 and acc.athlete_id = $3 and ath.deleted_at is null`,
    [subject.organizationId, subject.accountId, athleteId],
  );
  if (!row) return null;
  return isMinor(row.dob, now) ? null : 'adult_athlete';
}

interface SwitchRow {
  user_type: EmailAlertUserType;
  switched_on: boolean;
  address_confirmed: boolean;
  holds_address: boolean;
}

const SWITCH_ROW_COLUMNS = `user_type, switched_on, confirmed_address is not null as address_confirmed,
            (pending_address is not null or pending_code_hash is not null or confirmed_address is not null) as holds_address`;

type OfferedState = Extract<EmailAlertSwitchState, { offered: true }>;

function stateFrom(userType: EmailAlertUserType, row: SwitchRow | null | undefined): OfferedState {
  // A row saved under another user type (a changed role) is not this switch.
  const same = row && row.user_type === userType ? row : null;
  return userType === 'adult_athlete'
    ? { offered: true, user_type: userType, switched_on: same?.switched_on ?? false, address_confirmed: same?.address_confirmed ?? false }
    : { offered: true, user_type: userType, switched_on: same?.switched_on ?? false };
}

/**
 * A person who is no longer offered a switch (an athlete whose date of birth
 * was corrected to under 18, a record deleted, a changed role that still
 * reaches this module) keeps no switch that is on and no address. Done quietly,
 * with nothing shown to the person, the next time they read or write their own
 * switch; the same lazy clean-up the escalations read does for ended holds
 * (escalations/route.ts, closeEndedHoldNotices). The sender (EM-3) is to check
 * eligibility again before every send whether or not this has run.
 */
async function retireSwitchIfAny(subject: EmailAlertSwitchSubject): Promise<void> {
  // Most people not offered a switch (every athlete under 18) never had one:
  // one plain read, and no transaction or lock, unless there is something to do.
  const leftover = await queryOne<{ found: boolean }>(
    `select true as found from pilot.email_alert_switches
      where organization_id = $1 and account_id = $2
        and (switched_on or pending_address is not null or pending_code_hash is not null or confirmed_address is not null)`,
    [subject.organizationId, subject.accountId],
  );
  if (!leftover) return;
  await withTransaction(async (client) => {
    await client.query('select 1 from pilot.accounts where account_id = $1 for no key update', [subject.accountId]);
    const before = await client.query<SwitchRow>(
      `select ${SWITCH_ROW_COLUMNS}
         from pilot.email_alert_switches
        where organization_id = $1 and account_id = $2
        for update`,
      [subject.organizationId, subject.accountId],
    );
    const row = before.rows[0];
    if (!row || (!row.switched_on && !row.holds_address)) return;
    await client.query(
      `update pilot.email_alert_switches s set
         switched_on = false,
         switched_off_at = case when s.switched_on then clock_timestamp() else s.switched_off_at end,
         set_at = clock_timestamp(),
         pending_address = null,
         pending_code_hash = null,
         pending_code_expires_at = null,
         pending_code_attempts = 0,
         confirmed_address = null,
         confirmed_at = null
       where s.organization_id = $1 and s.account_id = $2`,
      [subject.organizationId, subject.accountId],
    );
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: subject.accountId,
      actor_role: subject.role,
      organization_id: subject.organizationId,
      entity_type: 'email_alert_switch',
      entity_id: subject.accountId,
      details: {
        user_type: row.user_type,
        switched_on: false,
        previous_switched_on: row.switched_on,
        address_cleared: row.holds_address,
        reason: 'no_longer_offered',
      },
      shadow_mirror: false,
    }, client);
  });
}

export async function readEmailAlertSwitch(
  subject: EmailAlertSwitchSubject,
  now: Date = new Date(),
): Promise<EmailAlertSwitchState> {
  const userType = await emailAlertUserTypeFor(subject, now);
  if (!userType) {
    await retireSwitchIfAny(subject);
    return { offered: false };
  }
  const row = await queryOne<SwitchRow>(
    `select ${SWITCH_ROW_COLUMNS}
       from pilot.email_alert_switches
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
    await retireSwitchIfAny(subject);
    throw new ForbiddenError('Forbidden: email alerts are not offered to this account');
  }

  return withTransaction(async (client) => {
    // Lock the person's own account row first: with no switch row yet there
    // is nothing for the select below to lock, and two first saves at once
    // would both take the INSERT branch, and the second would fail on the
    // primary key (23505, a 500 to the person). With the lock the second waits,
    // then reads the first's committed row and takes the UPDATE branch. FOR NO
    // KEY UPDATE, so rows that only reference the account are not held up
    // (tabletIdlePolicy.ts's rule).
    await client.query('select 1 from pilot.accounts where account_id = $1 for no key update', [subject.accountId]);
    const before = await client.query<SwitchRow>(
      `select ${SWITCH_ROW_COLUMNS}
         from pilot.email_alert_switches
        where organization_id = $1 and account_id = $2
        for update`,
      [subject.organizationId, subject.accountId],
    );
    const stored = before.rows[0];
    const previous = stateFrom(userType, stored);
    // The row as stored, whatever user type it was saved under: the times and
    // the audit describe what the row did, not what this switch reads as.
    const storedOn = stored?.switched_on ?? false;
    const retyped = stored !== undefined && stored.user_type !== userType;

    if (userType === 'adult_athlete' && switchedOn && previous.address_confirmed !== true) {
      throw new ConflictError('Confirm an email address before switching email alerts on');
    }

    // An UPDATE of the locked row, or an INSERT when there is none; not
    // INSERT ... ON CONFLICT, because Postgres checks the CHECKs against the
    // proposed new row before the conflict is found, and that row carries no
    // address, so an adult athlete with a confirmed address could never switch
    // on. switched_on_at moves when it goes on (or comes on under a new user
    // type), switched_off_at when a row that was on goes off. A row saved under
    // another user type loses any address, which only an adult athlete's row
    // may hold.
    if (stored) {
      await client.query(
        `update pilot.email_alert_switches s set
           user_type = $3,
           switched_on = $4,
           switched_on_at = case when $4 and (not $5 or $6) then clock_timestamp() else s.switched_on_at end,
           switched_off_at = case when not $4 and $5 then clock_timestamp() else s.switched_off_at end,
           set_at = clock_timestamp(),
           pending_address = case when $3 = 'adult_athlete' then s.pending_address end,
           pending_code_hash = case when $3 = 'adult_athlete' then s.pending_code_hash end,
           pending_code_expires_at = case when $3 = 'adult_athlete' then s.pending_code_expires_at end,
           pending_code_attempts = case when $3 = 'adult_athlete' then s.pending_code_attempts else 0 end,
           confirmed_address = case when $3 = 'adult_athlete' then s.confirmed_address end,
           confirmed_at = case when $3 = 'adult_athlete' then s.confirmed_at end
         where s.organization_id = $1 and s.account_id = $2`,
        [subject.organizationId, subject.accountId, userType, switchedOn, storedOn, retyped],
      );
    } else {
      await client.query(
        `insert into pilot.email_alert_switches
           (organization_id, account_id, user_type, switched_on, switched_on_at, switched_off_at, set_at)
         values ($1, $2, $3, $4,
                 case when $4 then clock_timestamp() end,
                 case when not $4 then clock_timestamp() end,
                 clock_timestamp())`,
        [subject.organizationId, subject.accountId, userType, switchedOn],
      );
    }
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: subject.accountId,
      actor_role: subject.role,
      organization_id: subject.organizationId,
      entity_type: 'email_alert_switch',
      entity_id: subject.accountId,
      details: {
        user_type: userType,
        switched_on: switchedOn,
        previous_switched_on: storedOn,
        ...(retyped && stored ? { previous_user_type: stored.user_type } : {}),
      },
      // A person's own notification preference: nothing for SHADOW to learn from.
      shadow_mirror: false,
    }, client);

    return userType === 'adult_athlete'
      ? { offered: true, user_type: userType, switched_on: switchedOn, address_confirmed: previous.address_confirmed === true }
      : { offered: true, user_type: userType, switched_on: switchedOn };
  });
}
