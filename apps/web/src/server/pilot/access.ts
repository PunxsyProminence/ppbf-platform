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

/**
 * A coach reaches an athlete two ways, checked in order:
 *
 * 1. They are the athlete's coach_id of record -- the original exact-match,
 *    untouched (T-002's own rule: extend, don't replace).
 * 2. They hold an active coverage grant (pilot.coach_coverage): not revoked,
 *    started, not yet expired -- a coach substituting for the coach of
 *    record, granted temporary per-athlete access without ever becoming the
 *    coach_id. Expiry is enforced by comparing against now() at read time,
 *    so a lapsed grant needs no cleanup job to stop working.
 *
 * Both failures throw the SAME message on purpose: whether a coach has no
 * relationship to this athlete, an expired grant, or a revoked one is not
 * something the error channel should disclose -- and the pre-coverage
 * assertion text stays byte-identical for every existing caller and test.
 */
export async function assertCoachAssignedToAthlete(coachId: string, athleteId: string, organizationId: string): Promise<void> {
  const row = await queryOne<{ athlete_id: string }>(
    'select athlete_id from pilot.athletes where athlete_id = $1 and coach_id = $2 and organization_id = $3',
    [athleteId, coachId, organizationId],
  );

  if (row) {
    return;
  }

  let coverage: { coverage_id: string } | null = null;
  try {
    coverage = await queryOne<{ coverage_id: string }>(
      `select coverage_id
       from pilot.coach_coverage
       where athlete_id = $1
         and covering_coach_account_id = $2
         and organization_id = $3
         and revoked_at is null
         and starts_at <= now()
         and expires_at > now()
       limit 1`,
      [athleteId, coachId, organizationId],
    );
  } catch (error) {
    // Migrations are operator-applied (guardrails section 7), so this code
    // legitimately runs against databases the coach_coverage migration has
    // not reached yet. In that window a missing relation (Postgres 42P01)
    // must mean exactly what the pre-T-002 code meant -- no coverage --
    // not turn every non-assigned-coach 403 into an opaque 500 that also
    // takes down the pain-report alert path layered on this gate. Any
    // other database error still propagates.
    const code = (error as { code?: unknown }).code;
    if (code !== '42P01') {
      throw error;
    }
  }

  if (!coverage) {
    throw new Error('Forbidden: coach not assigned to athlete');
  }
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
  // A coach who is not the coach of record reaches this route only through a
  // coverage grant (T-002) -- and a grant is temporary BY DESIGN. Letting
  // the covering coach rewrite coach_id (including to themselves) would
  // convert a 3-day grant into permanent access the moment it was written:
  // the exact-match branch of assertCoachAssignedToAthlete would pass
  // forever after, and revoking or expiring the grant would change nothing.
  // Reassignment is an authority action; a substitute correcting a typo'd
  // date of birth is not the same act as a substitute adopting the athlete.
  if (actor.role === 'coach' && before.coach_id !== after.coach_id && before.coach_id !== actor.accountId) {
    throw new Error('Forbidden: covering coach cannot change coach assignment');
  }

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
