import { sessionCredentialFits } from './auth';
import type { PilotRole } from './contracts';
import { MAGIC_LINK_ROLES, MICROSOFT_ROLES } from './credentialPolicy';
import { query, queryOne } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { ConflictError, ForbiddenError, PilotError, ValidationError } from './errors';
import {
  checkDurableRateLimit,
  checkRateLimit,
  clearDurableRateLimit,
  recordDurableFailedAttempt,
} from './rateLimit';
import { hashPin, verifyPin } from './security';

/**
 * The labelling PIN: four digits that let a member take over the Teach Shadow
 * labelling station on a shared tablet (OD-2026-10-02-010 section 2 item 4;
 * Jason's H1-H8 answers, 2026-10-03).
 *
 * WHAT IT IS NOT. It is not a sign-in credential. It lives in its own table,
 * never in pilot.accounts.pin_hash, and nothing in auth.ts reads it: no login
 * route, no session mint. Its only reader is verifyLabellerPin below, which
 * answers "is this the person they say they are" for a station that a member
 * already opened with their own full sign-in. Four digits are 10,000
 * possibilities; what stands between a guesser and a match is the attempt
 * limiter, not the hash.
 *
 * Who holds one: a live member of the organization whose membership role in
 * that organization is a labelling role. The membership is the role a session
 * at this gym acts with (resolvePrincipal reads it, #1197). pilot.accounts.role,
 * the home role, is read only as resolvePrincipal reads it: the credential the
 * account signs in with must fit the membership role (sessionCredentialFits),
 * so a coach at home who is an admin here, whose session here resolves to
 * nobody, is no labelling admin here either.
 * The labelling roles are ANNOTATOR_ROLES (annotatorGate.ts) plus 'admin',
 * which access.ts treats as an alias of 'organization_admin'; a test pins the
 * two lists together so they cannot drift.
 */
export const LABELLER_ACCOUNT_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export const LABELLER_DISPLAY_NAME_MAX = 40;

/** One answer for every way a name-and-PIN pair can fail, so a refusal says nothing about the person picked. */
export function labellerPinRefused(): ForbiddenError {
  return new ForbiddenError('That name and PIN do not match', 'LABELLER_PIN_REFUSED');
}

/**
 * The PIN rule: exactly four digits, any four. Jason, 2026-10-03, asked
 * whether to refuse the 24 easiest (one repeated digit, straight runs):
 * "B" -- allow any 4 digits.
 */
export function assertLabellerPinAllowed(pin: unknown): asserts pin is string {
  if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) {
    throw new ValidationError('The labelling PIN must be exactly 4 digits', 'LABELLER_PIN_FORMAT');
  }
}

/**
 * The picker name as stored: trimmed, 1-40 characters, no control or
 * invisible formatting characters (a zero-width space or a direction override
 * would let two names look identical in the picker and still be "unique").
 */
export function normalizeLabellerDisplayName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) {
    throw new ValidationError('Enter the name the labelling station should show', 'LABELLER_NAME_REQUIRED');
  }
  if (name.length > LABELLER_DISPLAY_NAME_MAX) {
    throw new ValidationError(
      `The name can be at most ${LABELLER_DISPLAY_NAME_MAX} characters`,
      'LABELLER_NAME_TOO_LONG',
    );
  }
  if (/[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new ValidationError('The name contains a character that cannot be shown', 'LABELLER_NAME_INVALID');
  }
  return name;
}

/**
 * The live eligibility of account `a` in organization `$1`, as SQL. Read at
 * every use, never remembered: a coach removed from the gym, deactivated,
 * deleted or moved out of a labelling role stops verifying at once.
 */
function roleList(roles: readonly string[]): string {
  return roles.map((role) => `'${role}'`).join(', ');
}

const HOME_ROLES: readonly PilotRole[] = [...MICROSOFT_ROLES, ...MAGIC_LINK_ROLES, 'athlete'];

/**
 * Membership `om` names one of `roles`, and the home role on account `a` holds
 * a credential that fits it: the same rule resolvePrincipal applies, expanded
 * to SQL from sessionCredentialFits so the two cannot drift.
 */
function membershipRoleFitsSql(roles: readonly PilotRole[]): string {
  return `(${roles.map((role) => {
    const homes = HOME_ROLES.filter((homeRole) =>
      sessionCredentialFits({ homeRole, sessionRole: role, isPlatformOwner: false }));
    return `(om.role = '${role}' and a.role in (${roleList(homes)}))`;
  }).join(' or ')})`;
}

function eligibleLabellerSql(organizationParam: string): string {
  return `a.active_flag = true
    and not ${accountDeletedSql('a')}
    and exists (
      select 1 from pilot.organization_memberships om
       where om.account_id = a.account_id
         and om.organization_id = ${organizationParam}
         and om.active_flag = true
         and ${membershipRoleFitsSql(LABELLER_ACCOUNT_ROLES)}
    )
    and exists (
      select 1 from pilot.organizations o
       where o.organization_id = ${organizationParam}
         and o.status = 'active'
    )`;
}

export interface OwnLabellerCredential {
  display_name: string;
  set_at: Date;
}

/** Whether the caller has a labelling PIN, and under what name. Never the hash. */
export async function getOwnLabellerCredential(
  organizationId: string,
  accountId: string,
): Promise<OwnLabellerCredential | null> {
  return queryOne<OwnLabellerCredential>(
    `select display_name, set_at
       from pilot.labeller_credentials
      where organization_id = $1 and account_id = $2`,
    [organizationId, accountId],
  );
}

/**
 * A member sets, or replaces, their OWN labelling PIN and picker name.
 *
 * The caller is the signed-in member; the route passes the principal's own
 * ids and nobody else's, so there is no way to set a PIN for another person.
 * Eligibility is restated in the write itself: an account that is not a live
 * labeller in this organization writes nothing.
 */
export async function setOwnLabellerCredential(input: {
  organizationId: string;
  accountId: string;
  displayName: unknown;
  pin: unknown;
}): Promise<void> {
  const displayName = normalizeLabellerDisplayName(input.displayName);
  assertLabellerPinAllowed(input.pin);
  const pinHash = await hashPin(input.pin);

  // A name held by someone who is no longer a live labeller here (taken off
  // the member list, deactivated, deleted, moved to another role) is freed:
  // their row is invisible to the picker and would otherwise block the name
  // with a refusal nobody can see the reason for. They set a new PIN if they
  // come back.
  await query(
    `delete from pilot.labeller_credentials lc
      using pilot.accounts a
      where a.account_id = lc.account_id
        and lc.organization_id = $1
        and lc.account_id <> $2
        and lower(lc.display_name) = lower($3)
        and not (${eligibleLabellerSql('$1')})`,
    [input.organizationId, input.accountId, displayName],
  );

  let written: Array<{ account_id: string }>;
  try {
    written = await query<{ account_id: string }>(
      `insert into pilot.labeller_credentials (organization_id, account_id, display_name, pin_hash)
       select $1, a.account_id, $3, $4
         from pilot.accounts a
        where a.account_id = $2
          and ${eligibleLabellerSql('$1')}
       on conflict (organization_id, account_id) do update
          set display_name = excluded.display_name,
              pin_hash = excluded.pin_hash,
              set_at = now(),
              updated_at = now()
       returning account_id`,
      [input.organizationId, input.accountId, displayName, pinHash],
    );
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === '23505') {
      throw new ConflictError(
        'Another labeller in this gym already uses that name. Add an initial or surname',
        'LABELLER_NAME_TAKEN',
      );
    }
    throw error;
  }
  if (written.length !== 1) {
    throw new ForbiddenError('Only an active coach or organization admin can set a labelling PIN', 'LABELLER_NOT_ELIGIBLE');
  }
}

/** Who may clear another member's labelling PIN: an admin of that gym. */
export const LABELLER_CLEAR_ROLES = ['organization_admin', 'admin'] as const;

/**
 * An organization admin clears a member's labelling PIN, which removes it;
 * the member sets a new one themselves. The admin never sees or chooses one.
 *
 * The actor must be a live admin OF THIS ORGANIZATION by membership, the
 * role its session here acts with: an admin at its home gym who is a parent
 * or staff member here is refused, and so is a coach at home who is an admin
 * here (a magic-link credential does not fit an admin session); a board member
 * at home who is an admin here may clear. Returns whether there was a PIN to
 * clear.
 */
export async function clearLabellerCredential(input: {
  organizationId: string;
  actorAccountId: string;
  accountId: string;
}): Promise<boolean> {
  const actor = await queryOne<{ ok: boolean }>(
    `select true as ok
       from pilot.accounts a
       join pilot.organization_memberships om
         on om.account_id = a.account_id
        and om.organization_id = $1
        and om.active_flag = true
      where a.account_id = $2
        and ${membershipRoleFitsSql(LABELLER_CLEAR_ROLES)}
        and a.active_flag = true
        and not ${accountDeletedSql('a')}`,
    [input.organizationId, input.actorAccountId],
  );
  if (!actor) {
    throw new ForbiddenError('Only an organization admin of this gym can clear a labelling PIN', 'LABELLER_CLEAR_NOT_ALLOWED');
  }
  const rows = await query<{ account_id: string }>(
    `delete from pilot.labeller_credentials
      where organization_id = $1 and account_id = $2
      returning account_id`,
    [input.organizationId, input.accountId],
  );
  return rows.length === 1;
}

export interface LabellerPickerEntry {
  account_id: string;
  display_name: string;
}

/** The station's picker: live labellers of this organization who have set a PIN. */
export async function listLabellerPicker(organizationId: string): Promise<LabellerPickerEntry[]> {
  return query<LabellerPickerEntry>(
    `select lc.account_id, lc.display_name
       from pilot.labeller_credentials lc
       join pilot.accounts a on a.account_id = lc.account_id
      where lc.organization_id = $1
        and ${eligibleLabellerSql('$1')}
      order by lower(lc.display_name), lc.account_id`,
    [organizationId],
  );
}

/** The limiter's word for "wait": a 429, not a refusal of the person. */
export function labellerPinSlowDown(): PilotError {
  return new PilotError(429, 'Too many PIN attempts. Wait a moment and try again', 'LABELLER_PIN_SLOW_DOWN');
}

export function labellerPinTargetKey(organizationId: string, accountId: string): string {
  return `labeller_pin_target:${organizationId}:${accountId}`;
}

// A real hash of a PIN nobody holds, so an unknown or ineligible pick costs
// the same scrypt as a known one and the time taken does not say which.
// Built at load, not on the first miss, so the first miss on a fresh process
// does not pay for an extra hash.
const decoyHash: Promise<string> = hashPin('labeller-decoy');
function decoy(): Promise<string> {
  return decoyHash;
}

/**
 * Is `pin` the labelling PIN of `accountId`, a live labeller in
 * `organizationId`? Returns that labeller's picker entry, or throws.
 *
 * THE LIMITER (rateLimit.ts, the existing one: in memory and durable, a pause
 * of a second after each counted attempt, doubling after the fifth to a
 * minute, forgotten fifteen minutes after the last; no permanent lockout).
 * Buckets: the picked labeller, always, plus whatever the caller adds (the
 * station, in the station slice).
 *
 * COUNTED BEFORE IT IS CHECKED, refunded on success. Every attempt is
 * recorded in the same tick as the in-memory check that admitted it, before
 * any await, so of any number of guesses arriving together on one process one
 * runs and the rest wait. A correct PIN clears the PICKED LABELLER'S bucket
 * only; a wrong one keeps its count everywhere. The caller's buckets are never
 * cleared here: if a correct PIN reset the station bucket, someone at the
 * tablet could spray guesses across several coaches and reset the station
 * count with their own PIN after every round.
 *
 * No failed attempt is written anywhere durable beyond the limiter's own
 * bucket (H8: no failed-PIN record), and the PIN is never logged.
 */
export async function verifyLabellerPin(input: {
  organizationId: string;
  accountId: string;
  pin: unknown;
  extraLimiterKeys?: string[];
}): Promise<LabellerPickerEntry> {
  const keys = [labellerPinTargetKey(input.organizationId, input.accountId), ...(input.extraLimiterKeys ?? [])];

  const durableChecks = await Promise.all(keys.map((key) => checkDurableRateLimit(key)));
  // NOTHING MAY AWAIT BETWEEN THIS CHECK AND THE RECORDS BELOW: the in-memory
  // record is the first, synchronous, step of recordDurableFailedAttempt.
  if (durableChecks.some((check) => check.isLimited) || keys.some((key) => checkRateLimit(key).isLimited)) {
    throw labellerPinSlowDown();
  }
  await Promise.all(keys.map((key) => recordDurableFailedAttempt(key)));

  const row = await queryOne<LabellerPickerEntry & { pin_hash: string }>(
    `select lc.account_id, lc.display_name, lc.pin_hash
       from pilot.labeller_credentials lc
       join pilot.accounts a on a.account_id = lc.account_id
      where lc.organization_id = $1
        and lc.account_id = $2
        and ${eligibleLabellerSql('$1')}`,
    [input.organizationId, input.accountId],
  );

  const pin = typeof input.pin === 'string' && /^[0-9]{4}$/.test(input.pin) ? input.pin : null;
  const matched = await verifyPin(pin ?? '0000', row?.pin_hash ?? (await decoy()));
  if (!row || pin === null || !matched) {
    throw labellerPinRefused();
  }

  await clearDurableRateLimit(keys[0]);
  return { account_id: row.account_id, display_name: row.display_name };
}
