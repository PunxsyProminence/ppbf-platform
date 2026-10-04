import { homeMembershipRoleSql, sessionCredentialFits, type PilotPrincipal } from './auth';
import type { AuthProvider } from './authProviders';
import type { PilotRole } from './contracts';
import { passwordLoginPermitted } from './credentialPolicy';
import { queryOne, withTransaction } from './db';
import { accountDeletedSql, isDeletedAccount, type AccountDeletionFlag } from './deletedAccountSignIn';
import { MAX_PASSWORD_LENGTH } from './passwordPolicy';
import { createOpaqueToken, hashPassword, hashToken, verifyPassword } from './security';
import { computeSessionExpiry } from './sessionPolicy';

/**
 * A parent signing in with their email and the password they made.
 *
 * A STORED HASH PROVES NOTHING BY ITSELF
 *
 * Setting a password (parentPassword.ts) leaves the hash where it is when the
 * account is later deleted, deactivated or given another role. So every
 * sign-in reads the account as it is NOW and admits it only if it is not
 * deleted, is active, its organization is active, and credentialPolicy still
 * admits its role to a password. Then it reads it again, locked, at the moment
 * the session is minted.
 *
 * ONE ANSWER
 *
 * Every refusal returns null and the route answers one 401. An unknown email,
 * a wrong password, no password set, a deleted or deactivated login, a
 * suspended organization and a role that may not hold a password are the same
 * to the caller, and each costs one password verification -- the shape of
 * loginWithAccountIdAndPin (auth.ts). The refusal log lines carry a reason and
 * nothing that says who: a guardian's account_id is usually their email.
 */

/** Longer than any address the mail system would deliver to. */
export const MAX_LOGIN_EMAIL_LENGTH = 254;

// A throwaway hash no password is known to match, so a sign-in for an email
// with no account, or an account with no password, still pays one scrypt at
// the cost a real one is stored at. Built once per process, on first need; a
// failed build is not cached. dummyPinHash in auth.ts, for a password.
let dummyPasswordHashPromise: Promise<string> | null = null;

function dummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    const pending = hashPassword(createOpaqueToken());
    dummyPasswordHashPromise = pending;
    pending.catch(() => {
      if (dummyPasswordHashPromise === pending) {
        dummyPasswordHashPromise = null;
      }
    });
  }
  return dummyPasswordHashPromise;
}

interface EligibilityRow extends AccountDeletionFlag {
  role: PilotRole;
  active_flag: boolean;
  is_platform_owner: boolean;
  organization_status: string | null;
  password_hash: string | null;
}

interface AccountRow extends EligibilityRow {
  account_id: string;
  organization_id: string | null;
  athlete_id: string | null;
  auth_provider: AuthProvider;
  has_master_shadow_access: boolean;
  must_change_pin: boolean;
  /** homeMembershipRoleSql: the role the session acts with (auth.ts). */
  membership_role: PilotRole | null;
}

/**
 * Why this account may not sign in with a password right now, or null.
 *
 * Asked twice with the same code: of the unlocked read, and of the locked row
 * the session is minted against. Deleted before inactive, as every sign-in
 * path orders them (deletedAccountSignIn.ts). The role is credentialPolicy's
 * answer; a board seat is not asked about (OD-2026-10-01-007).
 */
function ineligibleReason(row: EligibilityRow | null | undefined): string | null {
  if (row && isDeletedAccount(row)) return 'deleted_account';
  if (!row?.active_flag) return 'unknown_or_inactive_account';
  if (!row.is_platform_owner && row.organization_status && row.organization_status !== 'active') {
    return 'organization_not_active';
  }
  if (!row.password_hash) return 'no_password_set';
  if (!passwordLoginPermitted({ role: row.role })) return 'role_not_password_eligible';
  return null;
}

function rejected(reason: string): null {
  console.warn('pilot-auth password login rejected', { reason });
  return null;
}

export async function loginWithEmailAndPassword(
  emailInput: string,
  password: string,
): Promise<{ principal: PilotPrincipal; token: string } | null> {
  const email = emailInput.trim().toLowerCase();

  // Decided on the request alone, before anything is looked up or hashed: a
  // body of megabytes is neither an address nor a password.
  if (!email || !password || email.length > MAX_LOGIN_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH * 4) {
    return rejected('malformed_credentials');
  }

  // lower(login_email) is unique (pilot_accounts_login_email_uq), so this is
  // one row or none. No auth_provider filter: guardians are provisioned as
  // 'microsoft' (staffProvisioning.ts), and who may use a password is the
  // role's question, asked below.
  const data = await queryOne<AccountRow>(
    `select
       a.account_id,
       a.role,
       a.organization_id,
       a.is_platform_owner,
       a.athlete_id,
       a.auth_provider,
       a.password_hash,
       a.active_flag,
       ${accountDeletedSql('a')} as account_deleted,
       a.has_master_shadow_access,
       a.must_change_pin,
       o.status as organization_status,
       ${homeMembershipRoleSql('a')} as membership_role
     from pilot.accounts a
     left join pilot.organizations o on o.organization_id = a.organization_id
     where lower(a.login_email) = $1`,
    [email],
  );

  // The password is checked FIRST, before any refusal, so every outcome costs
  // one verification. The refusals keep their order; only the timing stops
  // differing.
  //
  // A throwaway hash that could not be built is "does not verify", as a
  // derivation that cannot run is inside verifyPassword: an email with no
  // password must not answer with an error where one with a password answers
  // with a refusal.
  const verifiedHash = data?.password_hash || await dummyPasswordHash().catch(() => null);
  const passwordIsValid = verifiedHash ? await verifyPassword(password, verifiedHash) : false;

  const reason = ineligibleReason(data);
  if (!data || reason) {
    return rejected(reason ?? 'unknown_or_inactive_account');
  }
  // The session acts with the membership role (auth.ts resolvePrincipal), so
  // a password must be a credential that role admits too.
  if (data.membership_role && (
    !passwordLoginPermitted({ role: data.membership_role })
    || !sessionCredentialFits({
      homeRole: data.role,
      sessionRole: data.membership_role,
      isPlatformOwner: data.is_platform_owner,
    })
  )) {
    return rejected('membership_role_credential_mismatch');
  }
  // No organization means no session, as on every sign-in path (auth.ts). It
  // used to fall back to the deployment's default organization.
  const organizationId = data.organization_id;
  if (!organizationId) {
    return rejected('no_organization');
  }
  if (!passwordIsValid) {
    return rejected('wrong_password');
  }

  const token = createOpaqueToken();
  const expiresAt = computeSessionExpiry();

  // THE MINT. The read above is unlocked and a scrypt sits between it and
  // here, so nothing it saw is relied on. The account row is taken FOR UPDATE
  // and the same questions are asked of the locked row: deletion,
  // deactivation and every role change UPDATE that row, so each either waits
  // for this session to exist (and then revokes it with the account's others)
  // or has already committed and is seen here. An insert that only restated
  // the conditions would read a snapshot, lock nothing, and could leave a live
  // session on an account deleted beside it.
  //
  // Two more facts must still be what was verified: the hash (a password
  // replaced or cleared during the scrypt is not the one that was typed) and
  // the sign-in email (the address typed must still be this account's).
  const minted = await withTransaction(async (client) => {
    const locked = (await client.query<EligibilityRow & { login_email: string | null; organization_id: string | null }>(
      `select a.role, a.active_flag, a.is_platform_owner, a.password_hash, a.login_email, a.organization_id,
              ${accountDeletedSql('a')} as account_deleted,
              null::text as organization_status
         from pilot.accounts a
        where a.account_id = $1
          for update`,
      [data.account_id],
    )).rows[0];

    // The organization row, FOR SHARE, as its own statement after the account
    // lock. A suspension UPDATES that row and then revokes the organization's
    // sessions; it takes no account lock, so the account lock above does not
    // order this against it. The share lock does: a suspension in flight makes
    // this wait and then read 'suspended', and one arriving later waits for
    // this session to exist and revokes it. Read without the lock, a session
    // minted beside a suspension could be missed by its revocation and come
    // back to life when the organization is reactivated. setOrganizationStatus
    // is the only writer of the row and holds no account row, so account then
    // organization cannot deadlock with it.
    const organization = locked?.organization_id
      ? (await client.query<{ status: string | null }>(
        'select o.status from pilot.organizations o where o.organization_id = $1 for share',
        [locked.organization_id],
      )).rows[0]
      : undefined;

    if (
      !locked
      || ineligibleReason({ ...locked, organization_status: organization?.status ?? null })
      || locked.password_hash !== verifiedHash
      || (locked.login_email ?? '').trim().toLowerCase() !== email
      || locked.organization_id !== data.organization_id
    ) {
      return false;
    }

    // sign_in_method 'password': set-password accepts only 'magic_link'
    // (parentPassword.ts), so a session minted here can never set or replace
    // a password. A password is changed through a fresh emailed link only.
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at, sign_in_method)
       values ($1, $2, $3, $4, 'password')`,
      [hashToken(token), data.account_id, organizationId, expiresAt],
    );
    return true;
  });

  if (!minted) {
    return rejected('state_changed_before_mint');
  }

  return {
    token,
    principal: {
      accountId: data.account_id,
      role: data.membership_role ?? data.role,
      organizationId,
      athleteId: data.athlete_id,
      sessionToken: token,
      authProvider: data.auth_provider,
      hasMasterShadowAccess: data.has_master_shadow_access,
      mustChangePin: data.must_change_pin,
    },
  };
}
