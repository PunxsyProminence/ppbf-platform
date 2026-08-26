import { randomInt } from 'node:crypto';

import type { PilotRole } from './contracts';
import { DEFAULT_ACTIVATION_TTL_HOURS, MAX_ACTIVATION_TTL_HOURS } from './activationPolicy';
import { query, withTransaction } from './db';
import { assertChosenPinAllowed, validatePinPolicy } from './pinPolicy';
import { hashPin, hashToken } from './security';

// Crockford-style base32: no I, L, O, or U. Codes get read off a printed slip
// and typed by a teenager on a phone, so the alphabet excludes the glyph pairs
// that are routinely mis-transcribed (I/1, L/1, O/0) and U (which turns
// accidental words into unfortunate ones).
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const CODE_GROUP_SIZE = 4;

export interface IssuedActivationCode {
  // The plaintext code. This is the only moment it exists outside the
  // recipient's hands -- only its hash is persisted, so it cannot be recovered
  // or re-displayed later. Losing it means issuing a new one.
  code: string;
  accountId: string;
  organizationId: string;
  expiresAt: string;
}

export interface OutstandingActivationCode {
  account_id: string;
  athlete_id: string | null;
  organization_id: string;
  issued_by_account_id: string;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
}

export interface RedeemedActivation {
  accountId: string;
  organizationId: string;
  athleteId: string | null;
}

export async function provisionAthleteActivation(params: {
  accountId: string;
  athleteId?: string;
  organizationId: string;
  issuedByAccountId: string;
  issuedByRole: PilotRole;
  mode: 'create' | 'reset';
}): Promise<IssuedActivationCode> {
  const code = generateActivationCode();
  const tokenHash = hashActivationCode(normalizeActivationCode(code));
  const expiresAt = await withTransaction(async (client) => {
    if (params.mode === 'create') {
      if (!params.athleteId) throw new Error('Missing athlete_id');
      const athlete = await client.query(
        'select athlete_id from pilot.athletes where organization_id = $1 and athlete_id = $2',
        [params.organizationId, params.athleteId],
      );
      if (athlete.rows.length === 0) throw new Error('Athlete not found in organization');
      const bound = await client.query(
        'select account_id from pilot.accounts where organization_id = $1 and athlete_id = $2 limit 1',
        [params.organizationId, params.athleteId],
      );
      if (bound.rows.length > 0) throw new Error('Athlete is already linked to another account');
      const existing = await client.query('select account_id from pilot.accounts where account_id = $1 limit 1', [params.accountId]);
      if (existing.rows.length > 0) throw new Error('Account already exists');
      await client.query(
        `insert into pilot.accounts
           (account_id, role, organization_id, athlete_id, pin_hash, must_change_pin, active_flag, is_platform_owner)
         values ($1, 'athlete', $2, $3, null, false, false, false)`,
        [params.accountId, params.organizationId, params.athleteId],
      );
    } else {
      const reset = await client.query(
        `update pilot.accounts set pin_hash = null, must_change_pin = false, active_flag = false, updated_at = now()
         where account_id = $1 and organization_id = $2 and role = 'athlete' and is_platform_owner = false
         returning athlete_id`,
        [params.accountId, params.organizationId],
      );
      if (reset.rows.length === 0) throw new Error('Account not found or cannot be reset');
      await client.query('update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null', [params.accountId]);
    }

    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'athlete', false)
       on conflict (account_id, organization_id) do update set role = 'athlete', active_flag = false, updated_at = now()`,
      [params.accountId, params.organizationId],
    );
    await client.query(
      `update pilot.account_activation_tokens set superseded_at = now()
       where account_id = $1 and consumed_at is null and superseded_at is null`,
      [params.accountId],
    );
    const inserted = await client.query<{ expires_at: string }>(
      `insert into pilot.account_activation_tokens
         (token_hash, account_id, organization_id, issued_by_account_id, issued_by_role, expires_at)
       values ($1,$2,$3,$4,$5,now() + ($6 || ' hours')::interval) returning expires_at`,
      [tokenHash, params.accountId, params.organizationId, params.issuedByAccountId, params.issuedByRole, DEFAULT_ACTIVATION_TTL_HOURS],
    );
    return inserted.rows[0].expires_at;
  });
  return { code, accountId: params.accountId, organizationId: params.organizationId, expiresAt };
}

/**
 * Generates a 12-character activation code using rejection-free uniform
 * selection (`randomInt` over an alphabet whose length divides evenly into the
 * generator's range), formatted in dash-separated groups for transcription.
 */
export function generateActivationCode(): string {
  let raw = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }

  const groups: string[] = [];
  for (let index = 0; index < raw.length; index += CODE_GROUP_SIZE) {
    groups.push(raw.slice(index, index + CODE_GROUP_SIZE));
  }

  return groups.join('-');
}

/**
 * Canonicalizes a code as typed by a human into the exact form that was
 * hashed at issue time: uppercased, separators removed, and the
 * commonly-confused glyphs folded onto the alphabet's real characters.
 *
 * This runs on both sides (issue hashes the canonical form; redeem
 * canonicalizes before hashing), so "o" typed for zero still redeems.
 */
export function normalizeActivationCode(raw: string): string {
  const stripped = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');

  if (stripped.length !== CODE_LENGTH) {
    throw new Error('Missing code: activation code must be 12 characters');
  }

  for (const character of stripped) {
    if (!CODE_ALPHABET.includes(character)) {
      throw new Error('Missing code: activation code contains invalid characters');
    }
  }

  return stripped;
}

function hashActivationCode(canonicalCode: string): string {
  return hashToken(`activation:${canonicalCode}`);
}

function resolveTtlHours(requested?: number): number {
  if (requested === undefined) {
    return DEFAULT_ACTIVATION_TTL_HOURS;
  }

  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > MAX_ACTIVATION_TTL_HOURS) {
    throw new Error('Missing ttl_hours: must be a positive integer of at most 2160');
  }

  return requested;
}

/**
 * Issues a one-time activation code for a pending athlete account and
 * supersedes every code previously issued for that account.
 *
 * Re-issuing is therefore safe and idempotent in effect: whatever slip was
 * handed out before this call stops working the moment this one commits, so a
 * code that went to the wrong person is revoked by simply issuing a new one.
 */
export async function issueActivationCode(params: {
  accountId: string;
  organizationId: string;
  issuedByAccountId: string;
  issuedByRole: PilotRole;
  ttlHours?: number;
}): Promise<IssuedActivationCode> {
  const accountId = params.accountId.trim();
  const organizationId = params.organizationId.trim();

  if (!accountId || !organizationId) {
    throw new Error('Missing account_id or organization_id');
  }

  const ttlHours = resolveTtlHours(params.ttlHours);
  const code = generateActivationCode();
  const tokenHash = hashActivationCode(normalizeActivationCode(code));

  const expiresAt = await withTransaction(async (client) => {
    // The target must be an athlete in this organization. Anything else --
    // a coach, an admin, an account in a different organization, or one that
    // does not exist -- is rejected with the same message, so this endpoint
    // cannot be used to probe which accounts exist or what role they hold.
    const target = await client.query<{ account_id: string }>(
      `select account_id
       from pilot.accounts
       where account_id = $1
         and organization_id = $2
         and role = 'athlete'
         and is_platform_owner = false`,
      [accountId, organizationId],
    );

    if (target.rows.length === 0) {
      throw new Error('Not found: no pending athlete account matches that identifier');
    }

    await client.query(
      `update pilot.account_activation_tokens
       set superseded_at = now()
       where account_id = $1
         and consumed_at is null
         and superseded_at is null`,
      [accountId],
    );

    const inserted = await client.query<{ expires_at: string }>(
      `insert into pilot.account_activation_tokens (
         token_hash,
         account_id,
         organization_id,
         issued_by_account_id,
         issued_by_role,
         expires_at
       )
       values ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval)
       returning expires_at`,
      [tokenHash, accountId, organizationId, params.issuedByAccountId, params.issuedByRole, ttlHours],
    );

    return inserted.rows[0].expires_at;
  });

  return { code, accountId, organizationId, expiresAt };
}

/**
 * Redeems an activation code, setting the athlete's own PIN and activating
 * the account and its membership.
 *
 * This is reachable unauthenticated -- it is the athlete's first contact with
 * the system -- so every failure mode returns the same generic error and the
 * PIN policy is validated *before* the token is consumed. A caller who
 * supplies a valid code with a malformed PIN gets to retry with the same code
 * rather than burning it.
 */
export async function redeemActivationCode(rawCode: string, pin: string): Promise<RedeemedActivation> {
  // Validate the PIN first: a rejected PIN must not consume the code.
  validatePinPolicy(pin);
  // Activation is a path where the athlete CHOOSES their own PIN, so the
  // retired shared bootstrap PIN is refused here too. validatePinPolicy
  // deliberately permits it (the admin reset flow used to issue it, and rows
  // holding its hash still exist in deployed databases), so this
  // unauthenticated, credential-establishing boundary rejects it explicitly:
  // a code redemption must never leave an account on the published PIN.
  assertChosenPinAllowed(pin);

  const canonicalCode = normalizeActivationCode(rawCode);
  const tokenHash = hashActivationCode(canonicalCode);
  const pinHash = await hashPin(pin);

  return withTransaction(async (client) => {
    // `for update` serializes concurrent redemptions of the same code: the
    // second one blocks, then sees consumed_at set and is rejected, so a code
    // can never be redeemed twice.
    const tokenRows = await client.query<{
      account_id: string;
      organization_id: string;
    }>(
      `select account_id, organization_id
       from pilot.account_activation_tokens
       where token_hash = $1
         and consumed_at is null
         and superseded_at is null
         and expires_at > now()
       for update`,
      [tokenHash],
    );

    if (tokenRows.rows.length === 0) {
      // Never the submitted code itself -- it is a bearer credential for the
      // duration it is live, same reason a PIN is never logged. Nothing else
      // records this rejection: the durable rate-limit bucket the caller
      // checks separately is deleted after 15 minutes (rateLimit.ts), so a
      // guesser spacing attempts out previously left no trace anywhere.
      console.warn('pilot-auth activation rejected', { reason: 'code_unknown_used_or_expired' });
      throw new Error('Unauthorized: activation code is invalid, already used, or expired');
    }

    const { account_id: accountId, organization_id: organizationId } = tokenRows.rows[0];

    // The organization must still be usable. Activating into a suspended or
    // inactive organization would produce an account that passes activation
    // and then fails every subsequent login with no explanation.
    const organization = await client.query<{ status: string }>(
      'select status from pilot.organizations where organization_id = $1',
      [organizationId],
    );

    if (organization.rows.length === 0 || organization.rows[0].status !== 'active') {
      console.warn('pilot-auth activation rejected', { accountId, reason: 'organization_not_active' });
      throw new Error('Unauthorized: activation code is invalid, already used, or expired');
    }

    const updated = await client.query<{ athlete_id: string | null }>(
      `update pilot.accounts
       set pin_hash = $1,
           active_flag = true,
           updated_at = now()
       where account_id = $2
         and organization_id = $3
         and role = 'athlete'
         and is_platform_owner = false
       returning athlete_id`,
      [pinHash, accountId, organizationId],
    );

    if (updated.rows.length === 0) {
      // The account changed role or organization between issue and redemption.
      console.warn('pilot-auth activation rejected', { accountId, reason: 'account_role_or_org_changed' });
      throw new Error('Unauthorized: activation code is invalid, already used, or expired');
    }

    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'athlete', true)
       on conflict (account_id, organization_id) do update
         set role = 'athlete',
             active_flag = true,
             updated_at = now()`,
      [accountId, organizationId],
    );

    await client.query(
      'update pilot.account_activation_tokens set consumed_at = now() where token_hash = $1',
      [tokenHash],
    );

    // The credential just changed. Any session minted before this point --
    // including one created under a previous PIN if this is a re-activation --
    // must not survive it.
    await client.query(
      'update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null',
      [accountId],
    );

    return {
      accountId,
      organizationId,
      athleteId: updated.rows[0].athlete_id,
    };
  });
}

/**
 * Lists activation codes still awaiting redemption in an organization, so the
 * console can show which athletes have not claimed their account yet.
 *
 * Returns metadata only -- the code itself is not recoverable from storage.
 */
export async function listOutstandingActivationCodes(organizationId: string): Promise<OutstandingActivationCode[]> {
  return query<OutstandingActivationCode>(
    `select
       t.account_id,
       a.athlete_id,
       t.organization_id,
       t.issued_by_account_id,
       t.created_at,
       t.expires_at,
       (t.expires_at <= now()) as is_expired
     from pilot.account_activation_tokens t
     join pilot.accounts a on a.account_id = t.account_id
     where t.organization_id = $1
       and t.consumed_at is null
       and t.superseded_at is null
     order by t.created_at desc`,
    [organizationId],
  );
}

/**
 * Deletes activation tokens that reached a terminal state (consumed,
 * superseded, or expired) at least `retentionDays` ago. Mirrors the session
 * cleanup contract: a short forensic window, then hard delete.
 */
export async function cleanupActivationTokens(retentionDays = 30): Promise<{ deletedCount: number }> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0 || retentionDays > 365) {
    throw new Error('Missing retention_days: must be a positive integer of at most 365');
  }

  const rows = await query<{ token_hash: string }>(
    `delete from pilot.account_activation_tokens
     where (expires_at < now() - ($1 || ' days')::interval)
        or (consumed_at is not null and consumed_at < now() - ($1 || ' days')::interval)
        or (superseded_at is not null and superseded_at < now() - ($1 || ' days')::interval)
     returning token_hash`,
    [retentionDays],
  );

  return { deletedCount: rows.length };
}
