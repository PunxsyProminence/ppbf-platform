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

export const DEFAULT_COVERAGE_TTL_HOURS = 24;

// A substitute covering one session needs hours, not months. The cap is what
// makes this design defensible over the roster-wide alternative that was
// rejected: coverage is bounded exposure to one athlete's record, and a bound
// nobody enforces is not a bound. Mirrors resolveTtlHours in activation.ts.
const MAX_COVERAGE_TTL_HOURS = 14 * 24;

function resolveCoverageTtlHours(requested?: number): number {
  if (requested === undefined) {
    return DEFAULT_COVERAGE_TTL_HOURS;
  }

  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > MAX_COVERAGE_TTL_HOURS) {
    throw new Error('Missing ttl_hours: must be a positive integer of at most 336');
  }

  return requested;
}

export async function grantCoachCoverage(params: {
  organizationId: string;
  athleteId: string;
  coveringCoachId: string;
  grantedByAccountId: string;
  ttlHours?: number;
}): Promise<{ coverageId: string; expiresAt: string }> {
  await assertAthleteBelongsToOrganization(params.organizationId, params.athleteId);

  const ttlHours = resolveCoverageTtlHours(params.ttlHours);

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

/**
 * Ends an active coverage grant immediately.
 *
 * Without this there was no way to withdraw coverage through the application
 * at all -- a grant issued to the wrong coach, or for longer than intended,
 * could only be undone with direct SQL against production. Re-granting does
 * not help either: unlike activation codes, a second grant does not supersede
 * the first, so both stay live until they expire on their own.
 *
 * Expires rather than deletes, so the row survives as an audit trail of who
 * held access and when it was cut short. The `expires_at > now()` guard makes
 * this idempotent -- revoking twice is not an error, and it cannot be used to
 * silently extend an already-expired grant.
 */
export async function revokeCoachCoverage(params: {
  organizationId: string;
  coverageId: string;
}): Promise<{ revoked: boolean }> {
  const row = await queryOne<{ coverage_id: string }>(
    `update pilot.coach_coverage
     set expires_at = now()
     where organization_id = $1
       and coverage_id = $2
       and expires_at > now()
     returning coverage_id`,
    [params.organizationId, params.coverageId],
  );

  return { revoked: Boolean(row) };
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
