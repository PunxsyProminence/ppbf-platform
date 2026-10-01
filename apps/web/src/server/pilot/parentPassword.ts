import type { PilotRole } from './contracts';
import { PASSWORD_ROLES, passwordLoginPermitted } from './credentialPolicy';
import { queryOne, withTransaction } from './db';
import { accountDeletedSql, isDeletedAccount, type AccountDeletionFlag } from './deletedAccountSignIn';
import { ForbiddenError } from './errors';
import { validatePasswordPolicy } from './passwordPolicy';
import { hashPassword, hashToken } from './security';

/**
 * A parent setting, or replacing, their own password.
 *
 * THE ONE PROOF IT ACCEPTS
 *
 * A session minted by an emailed sign-in link, no more than fifteen minutes
 * ago. Not any live session: a session cookie lifted from a shared tablet
 * would otherwise be enough to set a password and keep the account after the
 * session is gone. Opening the link proves control of the inbox, which is the
 * same proof the link itself rests on (magicLink.ts) -- so the link is how a
 * password is first made, how it is changed, and how a forgotten one is
 * replaced, and there is no separate reset flow to get wrong.
 *
 * A session with no recorded method (null: every session minted before the
 * parent-password migration, and every other door) is not proof.
 *
 * The window is the link's own lifetime (MAGIC_LINK_LIFETIME_MS), measured on
 * the database clock, from the session's created_at.
 */
export const PASSWORD_SETUP_WINDOW_MINUTES = 15;

/**
 * One answer for every way the proof can be missing, so the page has one
 * thing to say: go back to your email. Deleted, deactivated and wrong-role
 * accounts get it too -- this route does not explain an account to its caller.
 */
function linkRequired(): ForbiddenError {
  return new ForbiddenError(
    'Forbidden: open a new sign-in link from your email to set a password',
    'PASSWORD_SETUP_LINK_REQUIRED',
  );
}

/** The session's proof, as SQL over session_tokens `st`. Read once, written once. */
const LINK_SESSION_PROOF_SQL = `st.revoked_at is null
  and st.expires_at > now()
  and st.sign_in_method = 'magic_link'
  and st.created_at > now() - interval '${PASSWORD_SETUP_WINDOW_MINUTES} minutes'`;

/**
 * "Holds a board seat", for the account under `a`: a seat on ANY board, not
 * only the session organization's. The password lives on the account, which
 * is not per-organization, so a seat anywhere is a seat for this purpose.
 */
const HOLDS_ANY_BOARD_SEAT_SQL = `exists (
  select 1 from pilot.board_seats bs where bs.account_id = a.account_id
)`;

interface SetupRow extends AccountDeletionFlag {
  role: PilotRole;
  login_email: string | null;
  active_flag: boolean;
  holds_board_seat: boolean;
  link_session_proof: boolean;
}

export async function setOwnPasswordFromLinkSession(input: {
  accountId: string;
  sessionToken: string;
  password: string;
}): Promise<void> {
  const tokenHash = hashToken(input.sessionToken);

  const row = await queryOne<SetupRow>(
    `select a.role, a.login_email, a.active_flag,
            ${accountDeletedSql('a')} as account_deleted,
            ${HOLDS_ANY_BOARD_SEAT_SQL} as holds_board_seat,
            (${LINK_SESSION_PROOF_SQL}) as link_session_proof
       from pilot.session_tokens st
       join pilot.accounts a on a.account_id = st.account_id
      where st.token_hash = $1
        and st.account_id = $2`,
    [tokenHash, input.accountId],
  );

  // Deleted before inactive, as every sign-in path orders them
  // (deletedAccountSignIn.ts): an account can be active again and still deleted.
  if (!row || isDeletedAccount(row) || !row.active_flag) {
    console.warn('pilot-auth set-password rejected', { reason: 'unknown_deleted_or_inactive_account' });
    throw linkRequired();
  }
  if (!passwordLoginPermitted({ role: row.role }, { holdsBoardSeat: row.holds_board_seat })) {
    console.warn('pilot-auth set-password rejected', { reason: 'role_not_password_eligible' });
    throw linkRequired();
  }
  if (row.link_session_proof !== true) {
    console.warn('pilot-auth set-password rejected', { reason: 'no_recent_link_session' });
    throw linkRequired();
  }

  // After the proof, so only someone entitled to set a password learns what
  // the rules refuse; before the hash, so a refused password costs no scrypt.
  validatePasswordPolicy(input.password, { loginEmail: row.login_email });
  const passwordHash = await hashPassword(input.password);

  await withTransaction(async (client) => {
    // The read above is outside this transaction and a scrypt sits between
    // them. So the write restates every condition it relied on: an account
    // deleted, deactivated, re-roled or given a board seat, or a session
    // revoked or aged out in that gap, matches no row. A role change revokes
    // the account's sessions; a seat grant (boardSeats.ts) does not, which is
    // why the role and the seat are restated and not left to the session.
    // The roles are passwordLoginPermitted's own list, passed in, not named.
    const updated = await client.query<{ account_id: string }>(
      `update pilot.accounts a
          set password_hash = $1, password_set_at = now(), updated_at = now()
        where a.account_id = $2
          and a.active_flag
          and not ${accountDeletedSql('a')}
          and a.role = any($4::text[])
          and not ${HOLDS_ANY_BOARD_SEAT_SQL}
          and exists (
            select 1 from pilot.session_tokens st
             where st.token_hash = $3
               and st.account_id = a.account_id
               and ${LINK_SESSION_PROOF_SQL}
          )
        returning a.account_id`,
      [passwordHash, input.accountId, tokenHash, [...PASSWORD_ROLES]],
    );

    if (updated.rows.length === 0) {
      console.warn('pilot-auth set-password rejected', { reason: 'state_changed_before_write' });
      throw linkRequired();
    }

    // Every OTHER session ends: if someone else was signed in to this account,
    // the moment its owner sets a password is the moment that stops. This one
    // stays, so the parent who just made a password is not thrown back out.
    await client.query(
      `update pilot.session_tokens
          set revoked_at = now()
        where account_id = $1 and token_hash <> $2 and revoked_at is null`,
      [input.accountId, tokenHash],
    );
  });
}
