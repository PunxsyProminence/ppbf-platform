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

  if (!row) {
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
  // Who an athlete's coach is, is an administrator's decision. The create
  // route already refuses to let a coach file an athlete under anyone but
  // themselves ("coach can only create athletes assigned to self"); update
  // had no matching rule, so the same column the create path guards was
  // writable here by any coach who could reach the record.
  //
  // Left unguarded this converts read access into permanent ownership: a
  // coach reaching an athlete through a TEMPORARY grant can set coach_id to
  // their own account, at which point the grant's expiry stops mattering --
  // they match the permanent assignment check from then on -- and the
  // athlete's actual coach, who no longer matches coach_id, loses access.
  // A bound that the bounded party can write their way out of is not a bound.
  //
  // The knock-on is worse than the record access. profileDb grants
  // 'coach_of_subject' straight from athletes.coach_id, and that relationship
  // is one of the three in profileVisibility's MINOR_CIRCLE -- the circle a
  // minor's PHOTOGRAPH never leaves, and one organization admins are
  // deliberately outside of. So this column is not only roster bookkeeping;
  // writing to it admits the writer to a child's portrait.
  //
  // Refused outright rather than restricted to self-assignment: handing an
  // athlete to a different coach is equally an administrator's call, and
  // "only to yourself" would still permit the escalation above.
  if (actor.role === 'coach' && before.coach_id !== after.coach_id) {
    throw new Error('Forbidden: coach cannot change coach assignment');
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
