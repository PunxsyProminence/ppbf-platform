import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import { isGuardianLinkedToAthlete } from './guardianAccess';

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
 * 2. They hold an active coverage grant (pilot.coach_coverage): started and
 *    not yet expired -- a coach substituting for the coach of record,
 *    granted temporary per-athlete access without ever becoming the
 *    coach_id. Expiry is enforced by comparing against now() at read time,
 *    so a lapsed grant needs no cleanup job to stop working, and a revoked
 *    grant (expires_at forced to now()) stops working the same way.
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

  let coverage: { athlete_id: string } | null = null;
  try {
    coverage = await queryOne<{ athlete_id: string }>(
      `select athlete_id
       from pilot.coach_coverage
       where organization_id = $1
         and athlete_id = $2
         and covering_coach_id = $3
         and starts_at <= now()
         and expires_at > now()`,
      [organizationId, athleteId, coachId],
    );
  } catch (error) {
    // Migrations are operator-applied (guardrails section 7), so this code
    // legitimately runs against databases the coach_coverage migration has
    // not reached yet. In that window a missing relation (Postgres 42P01)
    // must mean exactly what the pre-coverage code meant -- no coverage --
    // not turn every non-assigned-coach 403 into an opaque 500 that also
    // takes down the pain-report alert path layered on this gate. Any
    // other database error still propagates.
    const code = (error as { code?: unknown }).code;
    if (code !== '42P01') {
      throw error;
    }
  }

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

// The account named must be an active coach in the organization before it is
// handed any coach-level relationship to a minor's record. A typo'd id is
// not a bad reference -- it is access granted to whatever account the typo
// names (a parent, an athlete, a deactivated coach). The field name rides
// the error so each caller's refusal names its own input.
export async function assertActiveCoachAccount(
  organizationId: string,
  accountId: string,
  field: string,
): Promise<void> {
  const coach = await queryOne<{ account_id: string }>(
    `select account_id
     from pilot.accounts
     where account_id = $1
       and organization_id = $2
       and role = 'coach'
       and active_flag = true`,
    [accountId, organizationId],
  );

  if (!coach) {
    throw new Error(`Missing ${field}: must be an active coach account in this organization`);
  }
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

  // This table exists to admit its holder through
  // assertCoachAssignedToAthlete, so the grantee check above all else.
  await assertActiveCoachAccount(params.organizationId, params.coveringCoachId, 'covering_coach_id');

  // At most one live grant per (athlete, coach). Stacked overlapping grants
  // make revocation lie: an admin revokes "the" grant, the hidden second one
  // keeps the door open. Refusing the overlap names the live grant so the
  // admin can revoke it first if they really mean to re-issue.
  const overlapping = await queryOne<{ coverage_id: string }>(
    `select coverage_id
     from pilot.coach_coverage
     where organization_id = $1
       and athlete_id = $2
       and covering_coach_id = $3
       and expires_at > now()
     limit 1`,
    [params.organizationId, params.athleteId, params.coveringCoachId],
  );

  if (overlapping) {
    throw new Error(`Coverage already exists: grant ${overlapping.coverage_id} for this coach and athlete is still active`);
  }

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
 * not help either: a second grant does not supersede the first (grant-time
 * overlap refusal blocks it outright while the first is live), so revoking
 * is the only way to end access early.
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

export interface ActiveCoachCoverageRow {
  coverage_id: string;
  athlete_id: string;
  athlete_full_name: string;
  covering_coach_id: string;
  covering_coach_email: string | null;
  granted_by_account_id: string;
  granted_by_email: string | null;
  starts_at: string;
  expires_at: string;
}

/**
 * Every coverage grant currently in effect for the organization, soonest to
 * expire first -- the read an admin needs to see what is about to lapse.
 * Expired and revoked grants (expires_at <= now()) are excluded on purpose:
 * this is "who has access right now," not the audit history. That history
 * already exists in pilot.audit_events under entity_type 'coach_coverage'
 * and is not duplicated here.
 */
export async function listActiveCoachCoverage(organizationId: string): Promise<ActiveCoachCoverageRow[]> {
  return query<ActiveCoachCoverageRow>(
    `select
       cc.coverage_id,
       cc.athlete_id,
       ath.full_name as athlete_full_name,
       cc.covering_coach_id,
       coach.login_email as covering_coach_email,
       cc.granted_by_account_id,
       granter.login_email as granted_by_email,
       cc.starts_at::text,
       cc.expires_at::text
     from pilot.coach_coverage cc
     join pilot.athletes ath
       on ath.organization_id = cc.organization_id and ath.athlete_id = cc.athlete_id
     left join pilot.accounts coach
       on coach.organization_id = cc.organization_id and coach.account_id = cc.covering_coach_id
     left join pilot.accounts granter
       on granter.organization_id = cc.organization_id and granter.account_id = cc.granted_by_account_id
     where cc.organization_id = $1
       and cc.expires_at > now()
     order by cc.expires_at asc`,
    [organizationId],
  );
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
    if (!(await isGuardianLinkedToAthlete(actor.organizationId, actor.accountId, athleteId))) {
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
