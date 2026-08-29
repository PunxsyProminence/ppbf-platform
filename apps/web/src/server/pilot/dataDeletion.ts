import type { PilotRole } from './contracts';
import { query, withTransaction } from './db';

export interface ActorIdentity {
  accountId: string;
  role: PilotRole;
  organizationId: string;
}

export interface DeletionResult {
  deletedEntityType: 'athlete' | 'guardian';
  deletedEntityId: string;
  deletedRecordsCounts: {
    athletes?: number;
    accounts?: number;
    athletePhotos?: number;
    athleteVideos?: number;
    // Retained, not deleted -- a soft delete leaves observations in place.
    coachObservationsRetained?: number;
    medicalRecords?: number;
  };
  deletedAt: string;
  auditEventId: number;
}

/**
 * Deletes a guardian/parent account and cascade-marks all linked athletes for deletion.
 * Organization-admin only. Logs to audit trail before deletion.
 */
export async function deleteGuardianAccount(
  actor: ActorIdentity,
  parentAccountId: string,
  reason?: string,
): Promise<DeletionResult> {
  if (actor.role !== 'organization_admin' && actor.role !== 'admin') {
    throw new Error('Forbidden: only organization admin can delete accounts');
  }

  return withTransaction(async (client) => {
    // Verify the parent account exists and belongs to this organization
    const parentRow = await client.query<{ account_id: string; role: string }>(
      `select account_id, role from pilot.accounts
       where account_id = $1 and organization_id = $2 and role = 'parent'`,
      [parentAccountId, actor.organizationId],
    );

    if (parentRow.rows.length === 0) {
      throw new Error('Not found: parent account does not exist or is not a parent role');
    }

    // Take the timestamp the DATABASE stamped, not one minted in JavaScript.
    // The cascade trigger copies new.deleted_at onto the linked athletes, so
    // this is the only value that can match them. The count previously compared
    // against a JS ISO string, which never equals now() from the same
    // statement, so it reported zero cascaded athletes every time -- including
    // when it had just soft-deleted several.
    // ::text, not the bare column. node-pg parses timestamptz into a JS Date,
    // which holds milliseconds while Postgres stores microseconds -- so a value
    // round-tripped through JS no longer equals the one on the row, and the
    // count below silently returns zero. Keeping it as text preserves the exact
    // value for the comparison.
    /* active_flag = false is not decoration, it is half of what makes this a
       deletion at all.

       Deleting a guardian used to write deleted_at and nothing else, and
       NOTHING in the read path filters on deleted_at: resolvePrincipal's query
       (auth.ts) joins accounts without it, and so does every guardian access
       check. So the flag the rest of the platform actually gates on --
       active_flag -- stayed true, and a "deleted" guardian kept reading their
       linked minor's records.

       Worse than a stale session: `parent` is a magic-link role, and both the
       issue and redeem paths gate on active_flag (magicLink.ts) and never look
       at deleted_at. A deleted guardian could request a fresh link to their own
       inbox and sign in again, indefinitely, until the account row was purged a
       year later. Deletion did not close the door; it did not touch it.

       This is the platform's own stated contract, which only the cleanup script
       implemented: scripts/lib/account-cleanup-plan.mjs defines "retire" as
       "deleted_at set, active_flag cleared, sessions revoked". That script
       deliberately skips parents precisely because deleting one fires the
       cascade trigger across minors' records -- so guardians were only ever
       deleted through the path that did one of the three. */
    const deleted = await client.query<{ deleted_at: string }>(
      `update pilot.accounts
       set deleted_at = now(), active_flag = false, updated_at = now()
       where account_id = $1
       returning deleted_at::text as deleted_at`,
      [parentAccountId],
    );
    const deletionTime = deleted.rows[0].deleted_at;

    /* Membership carries authorization independently of the account row:
       resolvePrincipal INNER JOINs organization_memberships on
       active_flag = true, so leaving it set is what let a deleted guardian's
       existing cookie keep resolving. */
    await client.query(
      `update pilot.organization_memberships
       set active_flag = false, updated_at = now()
       where account_id = $1 and organization_id = $2`,
      [parentAccountId, actor.organizationId],
    );

    /* In the SAME transaction as the deletion, so there is no window in which
       the account is deleted but a live session still resolves. Every other
       account-state mutation in auth.ts already does this -- resetAccountPin,
       activateAccountPin, changeOwnPin, setAccountActiveStatus,
       upsertOrganizationMembership, transferOrganizationAdmin,
       promoteAccountToOrganizationAdmin. Deletion was the one that did not,
       which is the reverse of the priority it should have had. */
    await client.query(
      `update pilot.session_tokens
       set revoked_at = now()
       where account_id = $1 and revoked_at is null`,
      [parentAccountId],
    );

    const athleteCount = await client.query<{ count: string }>(
      `select count(*)::text as count from pilot.athletes
       where deleted_at = $1::timestamptz and organization_id = $2`,
      [deletionTime, actor.organizationId],
    );

    // Log to audit trail
    const auditResult = await client.query<{ audit_id: number }>(
      `insert into pilot.audit_events (
         event_type, actor_account_id, actor_role, organization_id,
         entity_type, entity_id, details
       ) values (
         $1, $2, $3, $4, $5, $6, $7
       ) returning audit_id`,
      [
        'data_deletion_initiated',
        actor.accountId,
        actor.role,
        actor.organizationId,
        'parent_account',
        parentAccountId,
        JSON.stringify({
          reason: reason || 'Not specified',
          cascade_deleted_athletes: parseInt(athleteCount.rows[0].count, 10),
          deleted_at: new Date(deletionTime).toISOString(),
        }),
      ],
    );

    return {
      deletedEntityType: 'guardian',
      deletedEntityId: parentAccountId,
      deletedRecordsCounts: {
        accounts: 1,
        athletes: parseInt(athleteCount.rows[0].count, 10),
      },
      deletedAt: new Date(deletionTime).toISOString(),
      auditEventId: auditResult.rows[0].audit_id,
    };
  });
}

/**
 * Deletes an athlete record and marks all linked data (photos, videos, observations) for deletion.
 * Organization-admin only. Logs to audit trail before deletion.
 */
export async function deleteAthleteRecord(
  actor: ActorIdentity,
  athleteId: string,
  reason?: string,
): Promise<DeletionResult> {
  if (actor.role !== 'organization_admin' && actor.role !== 'admin') {
    throw new Error('Forbidden: only organization admin can delete athlete records');
  }

  return withTransaction(async (client) => {
    // Verify the athlete exists and belongs to this organization
    const athleteRow = await client.query<{ athlete_id: string }>(
      `select athlete_id from pilot.athletes
       where athlete_id = $1 and organization_id = $2`,
      [athleteId, actor.organizationId],
    );

    if (athleteRow.rows.length === 0) {
      throw new Error('Not found: athlete does not exist in this organization');
    }

    const deletedAthlete = await client.query<{ deleted_at: string }>(
      `update pilot.athletes
       set deleted_at = now(), updated_at = now()
       where athlete_id = $1 and organization_id = $2
       returning deleted_at::text as deleted_at`,
      [athleteId, actor.organizationId],
    );
    const deletionTime = deletedAthlete.rows[0].deleted_at;

    /* The athlete's ACCOUNT, which deleting the athlete used to leave running.

       deleteGuardianAccount does all three of these -- deleted_at, active_flag
       and session revocation -- because #690 found that writing deleted_at
       alone left a deleted guardian reading their minor's records. This
       function is the same function for the other party and it did exactly one
       of the three, so the same hole was open on the athlete side and nobody
       had looked.

       Concretely, before this: the athlete row was marked deleted while
       pilot.accounts.active_flag stayed true, so the athlete kept signing in
       with their PIN. The self-access branch of assertActorCanAccessAthlete
       compares actor.athleteId to the requested id and reads no row at all, so
       it could not have noticed either. A withdrawn athlete kept a working
       login to their own record for the entire two-year retention window.

       pilot.accounts.athlete_id is the link, and (organization_id, athlete_id)
       is unique on that table, so this addresses at most one account and cannot
       reach another gym's. Scoped on role as well: the column is nullable and
       only athlete accounts carry it, but an explicit role predicate means a
       future account type that borrows the column cannot be caught by this. */
    const deactivatedAccount = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set deleted_at = now(), active_flag = false, updated_at = now()
       where organization_id = $1 and athlete_id = $2 and role = 'athlete'
       returning account_id`,
      [actor.organizationId, athleteId],
    );

    /* In the SAME transaction as the deletion, so there is no window in which
       the athlete is deleted but a live session still resolves -- the identical
       reasoning deleteGuardianAccount records above. A PIN that no longer works
       is not enough on its own: an athlete already signed in holds a session
       token that resolvePrincipal accepts without re-reading active_flag. */
    let sessionsRevoked = 0;
    if (deactivatedAccount.rows.length > 0) {
      /* rowCount, not `returning` anything. The only columns this table has
         to return are the token hash and the account id, and there is no
         reason to pull session-token material into application memory to
         count rows the driver has already counted. */
      const revoked = await client.query(
        `update pilot.session_tokens
         set revoked_at = now()
         where account_id = $1 and revoked_at is null`,
        [deactivatedAccount.rows[0].account_id],
      );
      sessionsRevoked = revoked.rowCount ?? 0;
    }

    // Observations still on file for this athlete. NOT a deletion count: a soft
    // delete leaves the athlete row in place, so the FK cascade does not fire
    // and nothing here is removed. The audit record used to call this
    // 'cascade_deleted_observations', which claimed a deletion that had not
    // happened -- in the record whose whole purpose is being accurate about
    // what was deleted.
    const observationCount = await client.query<{ count: string }>(
      `select count(*)::text as count from pilot.coach_observations
       where athlete_id = $1 and organization_id = $2`,
      [athleteId, actor.organizationId],
    );

    // Log to audit trail
    const auditResult = await client.query<{ audit_id: number }>(
      `insert into pilot.audit_events (
         event_type, actor_account_id, actor_role, organization_id,
         entity_type, entity_id, details
       ) values (
         $1, $2, $3, $4, $5, $6, $7
       ) returning audit_id`,
      [
        'data_deletion_initiated',
        actor.accountId,
        actor.role,
        actor.organizationId,
        'athlete',
        athleteId,
        JSON.stringify({
          reason: reason || 'Not specified',
          observations_retained: parseInt(observationCount.rows[0].count, 10),
          // Counts, not claims. An athlete record with no account deactivates
          // nothing and revokes nothing, and the audit row should say so
          // rather than imply an access closure that did not happen.
          account_deactivated: deactivatedAccount.rows.length > 0,
          sessions_revoked: sessionsRevoked,
          deleted_at: new Date(deletionTime).toISOString(),
        }),
      ],
    );

    return {
      deletedEntityType: 'athlete',
      deletedEntityId: athleteId,
      deletedRecordsCounts: {
        athletes: 1,
        accounts: deactivatedAccount.rows.length,
        coachObservationsRetained: parseInt(observationCount.rows[0].count, 10),
      },
      deletedAt: new Date(deletionTime).toISOString(),
      auditEventId: auditResult.rows[0].audit_id,
    };
  });
}

/**
 * Hard-deletes data that has been soft-deleted and reached its retention window.
 * Returns count of rows deleted.
 *
 * NOT THE JOB THAT RUNS. retention-cleanup.yml dispatches
 * scripts/pilot-cleanup-deleted-data.mjs, which issues the same statements
 * behind the target, dry-run and blast-radius guards; this function has no
 * caller in the application. The two are kept in step deliberately -- one
 * destructive policy written twice is how the two stop agreeing -- but the
 * script is the one with the per-account isolation, so a guardian it cannot
 * purge does not stop the others. Here a blocked account still aborts the
 * transaction. Consolidating them is a separate change.
 */
export async function purgeExpiredDeletedData(): Promise<{ rowsDeleted: number }> {
  // One transaction. These are the only irreversible deletes in the platform,
  // and the audit row is the sole record that they happened. Run apart, a
  // failure at the audit insert leaves rows permanently gone and nothing
  // saying so -- which is precisely the evidence a retention policy exists to
  // produce.
  return withTransaction(async (client) => {
    let totalDeleted = 0;

    // Delete athletes soft-deleted more than 2 years ago
    const athleteDelete = await client.query(
      `delete from pilot.athletes
       where deleted_at is not null
         and deleted_at < (now() - interval '2 years')
       returning athlete_id`,
    );
    totalDeleted += athleteDelete.rows.length;

    /* The guardian's own record goes first, and the account cannot be deleted
       without it. Owner decision, 2026-08-28 (D-8): "delete the parents row
       too". pilot.parents holds their name, phone and email -- the personal
       data this policy promises to remove -- and pilot.parents.account_id is a
       RESTRICTING foreign key onto pilot.accounts, so the delete below raised
       23503 for every guardian who had ever been recorded as a parent, which
       is all of them.

       guardian_links is ON DELETE CASCADE from pilot.parents, so the
       child-to-guardian links go too. pilot.waivers.parent_id is ON DELETE SET
       NULL, so the waivers SURVIVE -- purging a withdrawn family must never
       destroy the documents that authorised a minor's participation. */
    /* Cleared by hand before the delete: pilot.waivers' foreign key onto
       pilot.parents is COMPOSITE (organization_id, parent_id) and ON DELETE
       SET NULL, and Postgres nulls every column in the key -- including
       organization_id, which is NOT NULL. Deleting the guardian record without
       this fails with 23502. Same reasoning, and the same two statements, as
       scripts/pilot-cleanup-deleted-data.mjs. */
    await client.query(
      `update pilot.waivers w
          set parent_id = null
         from pilot.parents p
        where p.account_id in (
                select account_id from pilot.accounts
                 where deleted_at is not null
                   and deleted_at < (now() - interval '1 year')
                   and role = 'parent'
              )
          and w.organization_id = p.organization_id
          and w.parent_id = p.parent_id`,
    );

    await client.query(
      `delete from pilot.parents
        where account_id in (
          select account_id from pilot.accounts
           where deleted_at is not null
             and deleted_at < (now() - interval '1 year')
             and role = 'parent'
        )`,
    );

    // Delete accounts (parents) soft-deleted more than 1 year ago
    const accountDelete = await client.query(
      `delete from pilot.accounts
       where deleted_at is not null
         and deleted_at < (now() - interval '1 year')
         and role = 'parent'
       returning account_id`,
    );
    totalDeleted += accountDelete.rows.length;

    if (totalDeleted > 0) {
      await client.query(
      `insert into pilot.audit_events (
         event_type, organization_id, entity_type, entity_id, details
       ) values (
         $1, $2, $3, $4, $5
       )`,
        [
          'data_purged',
          null,
          'retention_cleanup',
          'system',
          JSON.stringify({
            athletes_deleted: athleteDelete.rows.length,
            accounts_deleted: accountDelete.rows.length,
            total_rows_deleted: totalDeleted,
          }),
        ],
      );
    }

    return { rowsDeleted: totalDeleted };
  });
}

/**
 * Reports on deletion status for audit/compliance purposes.
 */
export async function getDeletionStatus(organizationId: string) {
  const softDeletedRecords = await query<{
    entity_type: string;
    count: string;
    oldest_deleted_at: string;
  }>(
    `select
       'athletes' as entity_type,
       count(*)::text as count,
       min(deleted_at)::text as oldest_deleted_at
     from pilot.athletes
     where deleted_at is not null and organization_id = $1
     union all
     select
       'parent_accounts' as entity_type,
       count(*)::text as count,
       min(deleted_at)::text as oldest_deleted_at
     from pilot.accounts
     where deleted_at is not null and role = 'parent' and organization_id = $1`,
    [organizationId],
  );

  const recentDeletions = await query<{
    event_id: number;
    deleted_entity: string;
    actor_name: string;
    created_at: string;
    reason: string;
  }>(
    `select
       audit_id::text as event_id,
       entity_id as deleted_entity,
       actor_account_id as actor_name,
       created_at::text as created_at,
       (details->>'reason')::text as reason
     from pilot.audit_events
     where event_type = 'data_deletion_initiated'
       and organization_id = $1
       and created_at > now() - interval '1 year'
     order by created_at desc
     limit 20`,
    [organizationId],
  );

  return {
    softDeletedRecords,
    recentDeletions,
  };
}
