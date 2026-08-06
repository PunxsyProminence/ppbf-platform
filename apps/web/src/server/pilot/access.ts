import type { PilotRole } from './contracts';
import { queryOne } from './db';

export interface ActorIdentity {
  accountId: string;
  role: PilotRole;
  organizationId: string;
  athleteId: string | null;
}

function roleEquals(actual: PilotRole, expected: PilotRole): boolean {
  if (actual === expected) {
    return true;
  }

  // Preserve compatibility while migrating legacy 'admin' rows.
  if ((actual === 'admin' && expected === 'organization_admin') || (actual === 'organization_admin' && expected === 'admin')) {
    return true;
  }

  return false;
}

export function isOrganizationAdminRole(role: PilotRole): boolean {
  return role === 'organization_admin' || role === 'admin';
}

export function requireRole(actor: ActorIdentity, allowed: PilotRole[]): void {
  if (!allowed.some((item) => roleEquals(actor.role, item))) {
    throw new Error('Forbidden: role not allowed');
  }
}

export async function assertCoachAssignedToAthlete(coachId: string, athleteId: string, organizationId: string): Promise<void> {
  const row = await queryOne<{ athlete_id: string }>(
    'select athlete_id from pilot.athletes where athlete_id = $1 and coach_id = $2 and organization_id = $3',
    [athleteId, coachId, organizationId],
  );

  if (row) {
    return;
  }

  const coverage = await queryOne<{ athlete_id: string }>(
    `select athlete_id
     from pilot.coach_coverage
     where organization_id = $1
       and athlete_id = $2
       and covering_coach_id = $3
       and starts_at <= now()
       and expires_at > now()`,
    [organizationId, athleteId, coachId],
  );

  if (coverage) {
    return;
  }

  throw new Error('Forbidden: coach not assigned to athlete');
}

export async function grantCoachCoverage(params: {
  organizationId: string;
  athleteId: string;
  coveringCoachId: string;
  grantedByAccountId: string;
  ttlHours?: number;
}): Promise<{ coverageId: string; expiresAt: string }> {
  await assertAthleteBelongsToOrganization(params.organizationId, params.athleteId);

  const ttlHours = params.ttlHours && params.ttlHours > 0 ? params.ttlHours : 24;

  const inserted = await queryOne<{ coverage_id: string; expires_at: string }>(
    `insert into pilot.coach_coverage (
       organization_id,
       athlete_id,
       covering_coach_id,
       granted_by_account_id,
       starts_at,
       expires_at
     )
     values ($1, $2, $3, $4, now(), now() + ($5 || ' hours')::interval)
     returning coverage_id, expires_at::text`,
    [params.organizationId, params.athleteId, params.coveringCoachId, params.grantedByAccountId, ttlHours],
  );

  if (!inserted) {
    throw new Error('Failed to grant coach coverage');
  }

  return {
    coverageId: inserted.coverage_id,
    expiresAt: inserted.expires_at,
  };
}

export async function assertAthleteBelongsToOrganization(organizationId: string, athleteId: string): Promise<void> {
  const row = await queryOne<{ athlete_id: string }>(
    'select athlete_id from pilot.athletes where athlete_id = $1 and organization_id = $2',
    [athleteId, organizationId],
  );

  if (!row) {
    throw new Error('Forbidden: athlete does not belong to organization');
  }
}

export async function assertActorCanAccessAthlete(actor: ActorIdentity, athleteId: string): Promise<void> {
  if (actor.role === 'platform_owner') {
    throw new Error('Forbidden: platform owner cannot access organization-private athlete records by default');
  }

  if (actor.role === 'board') {
    throw new Error('Forbidden: board role is restricted to organization-level aggregates');
  }

  if (isOrganizationAdminRole(actor.role)) {
    await assertAthleteBelongsToOrganization(actor.organizationId, athleteId);
    return;
  }

  if (actor.role === 'coach') {
    await assertCoachAssignedToAthlete(actor.accountId, athleteId, actor.organizationId);
    return;
  }

  if (actor.role === 'athlete') {
    if (!actor.athleteId || actor.athleteId !== athleteId) {
      throw new Error('Forbidden: athlete cannot access another athlete record');
    }
    return;
  }

  if (actor.role === 'parent') {
    const linked = await queryOne<{ athlete_id: string }>(
      `select athlete_id
       from pilot.guardian_links
       where organization_id = $1 and athlete_id = $2 and parent_id in (
         select parent_id
         from pilot.parents
         where organization_id = $1 and account_id = $3
       )`,
      [actor.organizationId, athleteId, actor.accountId],
    );

    if (!linked) {
      throw new Error('Forbidden: parent not linked to athlete');
    }

    return;
  }

  throw new Error('Forbidden: role not allowed');
}

export function assertAthleteUpdateAllowed(
  actor: ActorIdentity,
  before: { coach_id: string; active_flag: boolean; gym_status: string },
  after: { coach_id: string; active_flag: boolean; gym_status: string },
): void {
  if (actor.role !== 'athlete') {
    return;
  }

  if (before.coach_id !== after.coach_id) {
    throw new Error('Forbidden: athlete cannot change coach assignment');
  }

  if (before.active_flag !== after.active_flag) {
    throw new Error('Forbidden: athlete cannot change status flags');
  }

  if (before.gym_status !== after.gym_status) {
    throw new Error('Forbidden: athlete cannot change gym_status');
  }
}
