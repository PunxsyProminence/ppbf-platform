import type { PoolClient } from 'pg';

import { isOrganizationAdminRole } from './access';
import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { withTransaction } from './db';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { roleEquals } from './roleAlias';

/**
 * CL-A19 recovery. A Microsoft sign-in is bound to the Entra (tid, oid) it
 * first presented. A directory user deleted and re-created under the same
 * address gets a new oid, and every sign-in is then refused. Clearing the pair
 * lets the next sign-in bind again.
 *
 * Who may clear it (owner ruling 2026-10-06, relayed by overwatch, option A):
 *   - an organization admin, for an ACTIVE member of their own organization,
 *     never the platform owner;
 *   - the platform owner, for any account;
 *   - neither for their own account: if you can sign in you are bound, and
 *     clearing your own pair only opens a window for someone else to bind it;
 *   - the platform owner's own pair is cleared by the bootstrap-key route
 *     (createOrUpdateMicrosoftPlatformOwnerAccount, rebindMicrosoftIdentity).
 */

export type MicrosoftIdentityClearReason = 'admin_unbind' | 'owner_bootstrap';

interface UnbindTarget {
  account_id: string;
  organization_id: string;
  is_platform_owner: boolean;
  microsoft_oid: string | null;
  microsoft_tid: string | null;
}

/**
 * Clears one account's pair inside the caller's transaction and records the
 * pair it held. Only the oid's last four characters are kept: enough to match
 * against the directory, not a full identifier copied into every audit read.
 */
export async function clearMicrosoftIdentityTx(
  client: PoolClient,
  target: Pick<UnbindTarget, 'account_id' | 'microsoft_oid' | 'microsoft_tid'>,
  audit: {
    reason: MicrosoftIdentityClearReason;
    actorAccountId: string | null;
    actorRole: PilotRole | null;
    organizationId: string;
  },
): Promise<boolean> {
  if (!target.microsoft_oid) return false;
  await client.query(
    'update pilot.accounts set microsoft_oid = null, microsoft_tid = null where account_id = $1',
    [target.account_id],
  );
  await writePilotAuditEvent({
    event_type: 'update',
    actor_account_id: audit.actorAccountId,
    actor_role: audit.actorRole,
    organization_id: audit.organizationId,
    entity_type: 'account',
    entity_id: target.account_id,
    details: {
      change: 'microsoft_identity_cleared',
      reason: audit.reason,
      previous_microsoft_tid: target.microsoft_tid,
      previous_microsoft_oid_suffix: target.microsoft_oid.slice(-4),
    },
  }, client);
  return true;
}

export async function unbindMicrosoftIdentity(
  actor: { accountId: string; role: PilotRole; organizationId: string },
  targetAccountId: string,
): Promise<{ accountId: string; cleared: boolean }> {
  const isPlatformOwner = roleEquals(actor.role, 'platform_owner');
  if (!isPlatformOwner && !isOrganizationAdminRole(actor.role)) {
    throw new ForbiddenError('Forbidden: role not allowed');
  }
  const accountId = targetAccountId.trim();
  if (!accountId) {
    throw new ValidationError('Missing account_id');
  }
  if (accountId === actor.accountId) {
    throw new ForbiddenError('Forbidden: an account cannot unbind its own Microsoft identity');
  }

  return withTransaction(async (client) => {
    // Locked, so a sign-in binding the account concurrently is judged either
    // wholly before this clear or wholly after it.
    const found = isPlatformOwner
      ? await client.query<UnbindTarget>(
        `select a.account_id, a.organization_id,
                (a.is_platform_owner or a.role = 'platform_owner') as is_platform_owner,
                a.microsoft_oid, a.microsoft_tid
           from pilot.accounts a
          where a.account_id = $1
          for update of a`,
        [accountId],
      )
      : await client.query<UnbindTarget>(
        // The owner is recognised the way sign-in recognises it (flag, home
        // role, or membership role): the schema does not tie the three together.
        `select a.account_id, a.organization_id,
                (a.is_platform_owner or a.role = 'platform_owner' or om.role = 'platform_owner') as is_platform_owner,
                a.microsoft_oid, a.microsoft_tid
           from pilot.accounts a
           join pilot.organization_memberships om on om.account_id = a.account_id
          where a.account_id = $1 and om.organization_id = $2 and om.active_flag = true
          for update of a`,
        [accountId, actor.organizationId],
      );
    const target = found.rows[0];
    // One answer for every refusal past this point (no such account, another
    // organization, an inactive membership, the platform owner), so an
    // organization admin cannot probe which it was.
    if (!target || (!isPlatformOwner && target.is_platform_owner)) {
      throw new NotFoundError('Not found: account');
    }

    const cleared = await clearMicrosoftIdentityTx(client, target, {
      reason: 'admin_unbind',
      actorAccountId: actor.accountId,
      actorRole: actor.role,
      // An organization admin acts inside their own organization; the platform
      // owner's act is filed under the account's.
      organizationId: isPlatformOwner ? target.organization_id : actor.organizationId,
    });
    return { accountId, cleared };
  });
}
