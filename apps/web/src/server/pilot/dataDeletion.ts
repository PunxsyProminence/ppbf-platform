import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';

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
    coachObservations?: number;
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

    const deletionTime = new Date().toISOString();

    // Soft-delete the parent account (triggers cascade)
    await client.query(
      `update pilot.accounts
       set deleted_at = now(), updated_at = now()
       where account_id = $1`,
      [parentAccountId],
    );

    // Count how many athletes were cascaded
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
          deleted_at: deletionTime,
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
      deletedAt: deletionTime,
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

    const deletionTime = new Date().toISOString();

    // Soft-delete the athlete (cascades to linked records via FK)
    await client.query(
      `update pilot.athletes
       set deleted_at = now(), updated_at = now()
       where athlete_id = $1 and organization_id = $2`,
      [athleteId, actor.organizationId],
    );

    // Count deleted observations (cascade delete happens automatically via FK)
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
          cascade_deleted_observations: parseInt(observationCount.rows[0].count, 10),
          deleted_at: deletionTime,
        }),
      ],
    );

    return {
      deletedEntityType: 'athlete',
      deletedEntityId: athleteId,
      deletedRecordsCounts: {
        athletes: 1,
        coachObservations: parseInt(observationCount.rows[0].count, 10),
      },
      deletedAt: deletionTime,
      auditEventId: auditResult.rows[0].audit_id,
    };
  });
}

/**
 * Hard-deletes data that has been soft-deleted and reached its retention window.
 * Runs as a background process. Returns count of rows deleted.
 */
export async function purgeExpiredDeletedData(): Promise<{ rowsDeleted: number }> {
  let totalDeleted = 0;

  // Delete athletes soft-deleted more than 2 years ago
  const athleteDelete = await query<{ count: string }>(
    `delete from pilot.athletes
     where deleted_at is not null
       and deleted_at < (now() - interval '2 years')
     returning athlete_id`,
  );
  totalDeleted += athleteDelete.length;

  // Delete accounts (parents) soft-deleted more than 1 year ago
  const accountDelete = await query<{ count: string }>(
    `delete from pilot.accounts
     where deleted_at is not null
       and deleted_at < (now() - interval '1 year')
       and role = 'parent'
     returning account_id`,
  );
  totalDeleted += accountDelete.length;

  // Log the purge operation
  if (totalDeleted > 0) {
    await query<{ audit_id: number }>(
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
          athletes_deleted: athleteDelete.length,
          accounts_deleted: accountDelete.length,
          total_rows_deleted: totalDeleted,
          purged_at: new Date().toISOString(),
        }),
      ],
    );
  }

  return { rowsDeleted: totalDeleted };
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
