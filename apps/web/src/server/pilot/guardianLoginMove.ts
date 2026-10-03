// Moves a guardian record to a different login, on purpose (OD-2026-09-29-004
// R4, A). Intake refuses this move (GUARDIAN_ACCOUNT_CONFLICT in intake.ts)
// because, done silently, it hands every linked child to whoever holds the
// new login. This is the deliberate path: an organization admin, a named
// record, the login it holds now, and the login it moves to.
//
// The RECORD moves, not the children one by one. pilot.parents.parent_id is
// what guardian_links and the guardian's own waivers (media consent included)
// are keyed by, so re-pointing its account_id carries all of them to the new
// login and leaves the old one with none. Access is resolved from
// pilot.parents.account_id on every request (guardianAccess.ts), so the move
// takes effect on each login's next request.

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { withTransaction } from './db';
import { accountDeletedSql, deletedLoginConflict, isDeletedAccount } from './deletedAccountSignIn';
import { ConflictError, NotFoundError, ValidationError } from './errors';

export interface GuardianLoginMove {
  organizationId: string;
  parentId: string;
  /** The login the admin's screen showed. A different one now refuses the move. */
  fromAccountId: string;
  toAccountId: string;
  actor: { accountId: string; role: PilotRole };
}

export interface GuardianLoginMoveResult {
  parentId: string;
  fromAccountId: string;
  toAccountId: string;
  athleteIds: string[];
  /** True when the old login backed no other guardian record and was switched off. */
  oldLoginSwitchedOff: boolean;
}

interface LoginRow {
  account_id: string;
  organization_id: string;
  role: PilotRole;
  auth_provider: string;
  login_email: string | null;
  is_platform_owner: boolean;
  active_flag: boolean;
  account_deleted: boolean;
  membership_role: PilotRole | null;
  membership_active: boolean | null;
}

/**
 * Locks both logins FOR UPDATE, in account_id order, and reads them. Taken
 * BEFORE the guardian record's lock: a parent invite locks the account row
 * and then writes pilot.parents (staffProvisioning.ts), so the same order here
 * keeps a move and a re-invite from deadlocking.
 *
 * The lock is what makes the checks below hold at commit. A login's deletion
 * is an UPDATE of its pilot.accounts row, so it waits for this transaction.
 * That matters for the OLD login too: its deletion trigger
 * (pilot.cascade_parent_deletion) withdraws the children it finds through
 * pilot.parents.account_id, so it must read the record either before the move
 * or after it, never halfway. FOR UPDATE rather than FOR SHARE because the old
 * login may be switched off below. Sorted, so two moves between the same pair
 * of logins cannot take the locks in opposite orders.
 */
async function lockLogins(
  client: PoolClient,
  organizationId: string,
  accountIds: string[],
): Promise<Map<string, LoginRow>> {
  const rows = await client.query<LoginRow>(
    `select a.account_id, a.organization_id, a.role, a.auth_provider, a.login_email, a.is_platform_owner, a.active_flag,
            ${accountDeletedSql('a')} as account_deleted,
            om.role as membership_role, om.active_flag as membership_active
     from pilot.accounts a
     left join pilot.organization_memberships om
       on om.account_id = a.account_id and om.organization_id = $1
     where a.account_id = any($2::text[]) and a.organization_id = $1
     order by a.account_id
     for update of a`,
    [organizationId, [...accountIds].sort()],
  );
  return new Map(rows.rows.map((row) => [row.account_id, row]));
}

export async function moveGuardianToLogin(params: GuardianLoginMove): Promise<GuardianLoginMoveResult> {
  const organizationId = params.organizationId.trim();
  const parentId = params.parentId.trim();
  const fromAccountId = params.fromAccountId.trim();
  const toAccountId = params.toAccountId.trim();

  if (!organizationId || !parentId || !fromAccountId || !toAccountId) {
    throw new ValidationError('Missing parent_id, from_account_id or to_account_id', 'GUARDIAN_MOVE_MISSING_FIELD');
  }
  if (fromAccountId === toAccountId) {
    throw new ValidationError('The guardian record already uses that login.', 'GUARDIAN_MOVE_SAME_LOGIN');
  }

  try {
    return await withTransaction((client) => moveInTransaction(client, params, {
      organizationId, parentId, fromAccountId, toAccountId,
    }));
  } catch (error) {
    // A deadlock is one side of a race the database already broke; nothing
    // was written. Say so, rather than a 500.
    if ((error as { code?: string })?.code === '40P01') {
      throw new ConflictError(
        'Conflict: this guardian record or login was being changed at the same moment. Nothing was moved; try again.',
        'GUARDIAN_MOVE_BUSY',
      );
    }
    throw error;
  }
}

async function moveInTransaction(
  client: PoolClient,
  params: GuardianLoginMove,
  ids: { organizationId: string; parentId: string; fromAccountId: string; toAccountId: string },
): Promise<GuardianLoginMoveResult> {
  const { organizationId, parentId, fromAccountId, toAccountId } = ids;
  {
    const logins = await lockLogins(client, organizationId, [fromAccountId, toAccountId]);

    // Then the record, locked, so two moves of one record queue rather than
    // both reading the same starting login.
    const record = await client.query<{ account_id: string | null }>(
      `select account_id from pilot.parents
       where organization_id = $1 and parent_id = $2
       for update`,
      [organizationId, parentId],
    );
    if (record.rowCount === 0) {
      throw new NotFoundError(
        `No guardian record "${parentId}" in your organization.`,
        'GUARDIAN_RECORD_NOT_FOUND',
      );
    }

    const current = record.rows[0].account_id;
    if (current !== fromAccountId) {
      // Covers a record with no login as well: attaching a first login is the
      // parent invite's job (it claims an unclaimed record by email), not this.
      throw new ConflictError(
        `Conflict: guardian record "${parentId}" is not on login "${fromAccountId}" any more. `
        + 'Reload the page and check which login it is on before moving it.',
        'GUARDIAN_LOGIN_CHANGED',
      );
    }

    const from = logins.get(fromAccountId);
    if (!from) {
      // The record's login is not one of this organization's. Nothing here can
      // say whether it was deleted, so the move fails closed.
      throw new ConflictError(
        `Conflict: guardian record "${parentId}" is on a login outside your organization, so it is not moved here.`,
        'GUARDIAN_LOGIN_OUTSIDE_ORGANIZATION',
      );
    }
    if (isDeletedAccount(from)) {
      // A deleted guardian's record is waiting for the retention purge
      // (dataDeletion.ts). Moving it would pull it out of that, and a deletion
      // is not undone from the app.
      throw new ConflictError(
        `Conflict: guardian record "${parentId}" is on a login that was deleted. A deleted guardian's record is `
        + 'not moved to another login; invite the parent again with their new email instead.',
        'GUARDIAN_LOGIN_DELETED',
      );
    }

    const to = logins.get(toAccountId);
    if (!to) {
      // Another organization's login reads the same as no login at all.
      throw new NotFoundError(`No login "${toAccountId}" in your organization.`, 'GUARDIAN_MOVE_TARGET_NOT_FOUND');
    }
    if (isDeletedAccount(to)) {
      throw deletedLoginConflict(toAccountId);
    }
    if (to.is_platform_owner || to.role !== 'parent' || to.membership_role !== 'parent') {
      throw new ConflictError(
        `Conflict: login "${toAccountId}" is not a parent login. A guardian record moves only to a parent login; `
        + 'invite the parent with their new email first, then move the record to that login.',
        'GUARDIAN_MOVE_TARGET_NOT_PARENT',
      );
    }
    if (!to.active_flag || to.membership_active !== true) {
      throw new ConflictError(
        `Conflict: login "${toAccountId}" is switched off. Move the record only to a login that can sign in.`,
        'GUARDIAN_MOVE_TARGET_INACTIVE',
      );
    }

    if (to.auth_provider === 'ppbf_local') {
      // A PIN parent login has no sign-in path (authProviders.ts); the family
      // would move to a login nobody can use.
      throw new ConflictError(
        `Conflict: login "${toAccountId}" signs in with a PIN, which a parent cannot use. Move the record to an email login.`,
        'GUARDIAN_MOVE_TARGET_PIN_LOGIN',
      );
    }

    // One login, one guardian slot per child. A target that already guards any
    // of these children would answer consent as both guardians, and the
    // parent consent screen could write only one of its two records
    // (guardianConsent.ts, resolveActingParent).
    const overlap = await client.query<{ athlete_id: string }>(
      `select distinct gl.athlete_id
       from pilot.guardian_links gl
       join pilot.parents p
         on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
       where gl.organization_id = $1 and p.account_id = $2 and p.parent_id <> $3
         and gl.athlete_id in (
           select athlete_id from pilot.guardian_links where organization_id = $1 and parent_id = $3
         )
       order by gl.athlete_id`,
      [organizationId, toAccountId, parentId],
    );
    if ((overlap.rowCount ?? 0) > 0) {
      throw new ConflictError(
        `Conflict: login "${toAccountId}" is already a guardian of ${overlap.rows.map((row) => row.athlete_id).join(', ')} `
        + 'through another guardian record. Moving this record there would give one login two guardian places for '
        + 'the same child.',
        'GUARDIAN_MOVE_TARGET_ALREADY_GUARDIAN',
      );
    }

    // Compare-and-set on the login read above. The row lock already holds it
    // still; the where clause keeps the write honest if that ever changes.
    // The contact email follows the login (OD-2026-09-29-004 R4 follow-up,
    // Q2): the move exists because the parent changed their email, and coaches
    // read this column as the guardian's contact.
    const moved = await client.query(
      `update pilot.parents
       set account_id = $3, email = coalesce($5, email), updated_at = now()
       where organization_id = $1 and parent_id = $2 and account_id = $4`,
      [organizationId, parentId, toAccountId, fromAccountId, to.login_email],
    );
    if (moved.rowCount !== 1) {
      throw new ConflictError(
        `Conflict: guardian record "${parentId}" changed while it was being moved. Reload and try again.`,
        'GUARDIAN_LOGIN_CHANGED',
      );
    }

    const links = await client.query<{ athlete_id: string }>(
      `select athlete_id from pilot.guardian_links
       where organization_id = $1 and parent_id = $2
       order by athlete_id`,
      [organizationId, parentId],
    );
    const athleteIds = links.rows.map((row) => row.athlete_id);

    // The old login is switched off when it backs no guardian record left,
    // anywhere (Q3, A): otherwise it signs in to an empty family page, the
    // state removeGuardianLink refuses to leave. Same steps as switching a
    // login off from the people screen (auth.ts setAccountActiveStatus),
    // sessions included.
    const stillGuardian = await client.query(
      'select 1 from pilot.parents where account_id = $1 limit 1',
      [fromAccountId],
    );
    // Only a parent login: a record somehow held by a staff login never turns
    // that person's own login off.
    const oldLoginSwitchedOff = stillGuardian.rowCount === 0 && from.active_flag && from.role === 'parent';
    if (oldLoginSwitchedOff) {
      await client.query(
        'update pilot.accounts set active_flag = false, updated_at = now() where account_id = $1',
        [fromAccountId],
      );
      await client.query(
        `update pilot.organization_memberships set active_flag = false, updated_at = now()
         where account_id = $1 and organization_id = $2`,
        [fromAccountId, organizationId],
      );
      await client.query(
        'update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null',
        [fromAccountId],
      );
    }

    // Same transaction: the record of the move commits or rolls back with it.
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: params.actor.accountId,
      actor_role: params.actor.role,
      organization_id: organizationId,
      entity_type: 'guardian',
      entity_id: parentId,
      details: {
        action: 'organization_admin_move_guardian_login',
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        athlete_ids: athleteIds,
        old_login_switched_off: oldLoginSwitchedOff,
      },
    }, client);

    return { parentId, fromAccountId, toAccountId, athleteIds, oldLoginSwitchedOff };
  }
}
