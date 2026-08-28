import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { ForbiddenError, ValidationError } from './errors';

// Coach self-development: a coach's own development goals, and the
// development work they actually did.
//
// THIS MODULE RECORDS WHAT A COACH SAID AND DID, AND COMPUTES NOTHING. There
// is no progress figure, percentage, score, level, rank, completion ratio or
// hours total here, and none is derivable from what these tables store. The
// Coach Goals tab this feeds used to render three hardcoded goals with
// progress bars, identical for every coach who logged in; they were deleted
// as fake personal data, and nothing in this module can bring them back.
// `developmentFocus` is the coach's own words, written down verbatim and
// read back verbatim -- never parsed into a competency framework.
//
// IT IS NOT A CREDENTIAL RECORD. Certifications, background checks and every
// other clearance live in pilot.person_clearances, are uploaded through
// /coach/credentials and are verified by an administrator. Rows here are
// SELF-ENTERED AND UNVERIFIED. Logging "SafeSport refresher" as an activity
// proves nothing and clears nobody, which is why neither table carries a
// status, a verifier, an expiry or a document reference.
//
// EVERY FUNCTION IS SCOPED TO ONE COACH'S OWN RECORD, by both the
// organization and the account id, in the WHERE clause of every statement
// rather than in a caller's discipline. A goal belonging to a colleague in
// the same gym is a hidden not-found here, exactly like a goal in another
// organization -- so no read over this module can be used to discover that
// somebody else's goal exists. Whether a head coach may see their staff's
// development is a real product question and deliberately not answered by
// building the read first.

export const COACH_DEVELOPMENT_GOAL_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;

export type CoachDevelopmentGoalStatus = (typeof COACH_DEVELOPMENT_GOAL_STATUSES)[number];

export interface CoachDevelopmentGoalRow {
  organization_id: string;
  goal_id: string;
  coach_account_id: string;
  title: string;
  development_focus: string;
  /** Null is the ordinary case: plenty of real development has no deadline. */
  target_on: string | null;
  status: CoachDevelopmentGoalStatus;
  created_at: string;
  updated_at: string;
}

export interface CoachDevelopmentActivityRow {
  organization_id: string;
  activity_id: string;
  coach_account_id: string;
  /** The goal this served, or null -- which is the ordinary case. */
  goal_id: string | null;
  title: string;
  /** Empty means nobody recorded a provider. Never a provider named ''. */
  provider: string;
  occurred_on: string;
  /** Minutes for this one activity, or null. NOTHING SUMS THIS. */
  duration_minutes: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

// Dates come back as text, not as a driver Date: these are calendar days the
// coach typed, and routing them through a JS Date would re-interpret them in
// the server's timezone.
const GOAL_FIELDS = `organization_id, goal_id, coach_account_id, title, development_focus,
  target_on::text as target_on, status, created_at, updated_at`;

const ACTIVITY_FIELDS = `organization_id, activity_id, coach_account_id, goal_id, title,
  provider, occurred_on::text as occurred_on, duration_minutes, notes,
  created_at, updated_at`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar day written as YYYY-MM-DD. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  // Round-tripping catches the days that match the shape and do not exist --
  // 2026-02-30, 2026-13-01 -- which Postgres would reject anyway, later and
  // as an opaque driver error.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Does this account hold an ACTIVE membership in this organization?
 *
 * pilot.accounts.organization_id is the account's single denormalized HOME
 * organization and is the wrong question: a coach whose home gym is
 * elsewhere but who holds an active membership here may legitimately keep a
 * development record here, and an account whose membership was deactivated
 * may not write one, however its home column reads. auth.ts's
 * resolvePrincipal INNER JOINs the membership table for exactly this reason.
 *
 * access.ts's assertActiveCoachAccount is NOT this function despite the
 * name -- it reads pilot.accounts.organization_id, so it answers the home
 * question and would refuse every visiting coach. It is left alone because
 * its own callers depend on the check it actually makes.
 *
 * athleteDevelopmentBlocks.ts holds a private copy of this query. The two
 * are deliberately not merged yet: that file is inside an open PR stack
 * (#767/#771) that another lane's #762 also extends, and hoisting a shared
 * helper out of it mid-stack would collide in a file three branches are
 * already editing. When that stack lands, one of these should move to
 * access.ts and the other should be deleted.
 */
async function hasActiveMembership(accountId: string, organizationId: string): Promise<boolean> {
  const membership = await queryOne<{ account_id: string }>(
    `select om.account_id
     from pilot.organization_memberships om
     where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true`,
    [accountId, organizationId],
  );
  return membership !== null;
}

export interface CoachDevelopmentGoalInput {
  title: string;
  developmentFocus: string;
  targetOn?: string | null;
  status?: CoachDevelopmentGoalStatus;
}

/**
 * The reason a goal input is refused, or null when it is sound.
 *
 * Pure, and deliberately separate from the write: these restate the rules
 * the table's own CHECK constraints hold, where a caller can be told which
 * one they broke rather than receiving a driver error. The database remains
 * the authority -- this function existing is not a reason to trust a write
 * path that skips it.
 */
export function coachDevelopmentGoalShapeError(input: CoachDevelopmentGoalInput): string | null {
  if (!input.title?.trim()) {
    return 'A development goal needs a title.';
  }
  if (!input.developmentFocus?.trim()) {
    // The whole point of the row. A goal with a blank focus is a title, and
    // reading one back later as an intention would be a lie.
    return 'A development goal needs a stated focus, in the coach\'s own words.';
  }
  if (input.targetOn != null && input.targetOn !== '' && !isCalendarDate(input.targetOn)) {
    return 'target_on must be a calendar date written as YYYY-MM-DD, or omitted.';
  }
  if (input.status && !(COACH_DEVELOPMENT_GOAL_STATUSES as readonly string[]).includes(input.status)) {
    return `Unknown goal status '${input.status}'.`;
  }
  return null;
}

export interface CoachDevelopmentActivityInput {
  title: string;
  provider?: string;
  occurredOn: string;
  durationMinutes?: number | null;
  notes?: string;
  goalId?: string | null;
}

/** The reason an activity input is refused, or null when it is sound. */
export function coachDevelopmentActivityShapeError(input: CoachDevelopmentActivityInput): string | null {
  if (!input.title?.trim()) {
    return 'A development activity needs a title -- what it was.';
  }
  if (!isCalendarDate(input.occurredOn ?? '')) {
    // Required on purpose: an activity with no date is a claim, not a record.
    return 'occurred_on must be a calendar date written as YYYY-MM-DD.';
  }
  const minutes = input.durationMinutes;
  if (minutes != null) {
    if (!Number.isInteger(minutes) || minutes <= 0) {
      // Zero is not a duration and a negative one is a typo. Null stays the
      // honest "not recorded" and is handled by the branch above.
      return 'duration_minutes must be a whole number of minutes greater than zero, or omitted.';
    }
  }
  return null;
}

/** Empty string for anything blank or absent -- never null, never the word. */
function optionalText(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Records a coach's own development goal.
 *
 * Throws ForbiddenError when the coach holds no active membership in this
 * organization. The database refuses a non-member outright through the
 * composite FK into pilot.organization_memberships; this check exists for
 * the case the FK cannot see -- a membership row that exists but has been
 * DEACTIVATED, which would otherwise satisfy the constraint and write.
 */
export async function createCoachDevelopmentGoal(input: CoachDevelopmentGoalInput & {
  organizationId: string;
  coachAccountId: string;
}): Promise<CoachDevelopmentGoalRow> {
  const shapeError = coachDevelopmentGoalShapeError(input);
  if (shapeError) {
    throw new ValidationError(shapeError, 'COACH_DEVELOPMENT_GOAL_INVALID');
  }

  if (!(await hasActiveMembership(input.coachAccountId, input.organizationId))) {
    throw new ForbiddenError(
      'This account holds no active membership in this organization.',
      'COACH_DEVELOPMENT_NOT_A_MEMBER',
    );
  }

  const goalId = randomUUID();
  await queryOne(
    `insert into pilot.coach_development_goals
       (organization_id, goal_id, coach_account_id, title, development_focus, target_on, status)
     values ($1, $2, $3, $4, $5, $6::date, $7)
     returning goal_id`,
    [
      input.organizationId,
      goalId,
      input.coachAccountId,
      input.title.trim(),
      input.developmentFocus.trim(),
      input.targetOn?.trim() ? input.targetOn.trim() : null,
      input.status ?? 'draft',
    ],
  );

  const created = await getCoachDevelopmentGoal(input.organizationId, input.coachAccountId, goalId);
  if (!created) {
    // Unreachable through the insert above; thrown rather than returning a
    // null the caller would have to invent a meaning for.
    throw new Error('COACH_DEVELOPMENT_GOAL_VANISHED');
  }
  return created;
}

/**
 * One goal, or null.
 *
 * Scoped by BOTH organization and coach: a colleague's goal in the same gym
 * is null here, indistinguishable from a goal id that never existed. That is
 * the point -- a distinguishable not-found would let any coach enumerate
 * which of their colleagues' goals exist.
 */
export async function getCoachDevelopmentGoal(
  organizationId: string,
  coachAccountId: string,
  goalId: string,
): Promise<CoachDevelopmentGoalRow | null> {
  return queryOne<CoachDevelopmentGoalRow>(
    `select ${GOAL_FIELDS} from pilot.coach_development_goals
     where organization_id = $1 and coach_account_id = $2 and goal_id = $3`,
    [organizationId, coachAccountId, goalId],
  );
}

/** This coach's own goals in this organization, newest first. */
export async function listCoachDevelopmentGoals(
  organizationId: string,
  coachAccountId: string,
): Promise<CoachDevelopmentGoalRow[]> {
  return query<CoachDevelopmentGoalRow>(
    `select ${GOAL_FIELDS} from pilot.coach_development_goals
     where organization_id = $1 and coach_account_id = $2
     order by created_at desc, goal_id`,
    [organizationId, coachAccountId],
  );
}

export interface CoachDevelopmentGoalPatch {
  title?: string;
  developmentFocus?: string;
  /** Explicit null clears the date; omitting the key leaves it alone. */
  targetOn?: string | null;
  status?: CoachDevelopmentGoalStatus;
}

/**
 * Corrects a goal the coach already wrote. Null when there is no such goal
 * of theirs -- the same hidden not-found getCoachDevelopmentGoal gives.
 *
 * The organization, the coach and created_at are absent from the patch type
 * rather than guarded after the fact: a goal does not change gyms, does not
 * change owner, and did not stop having been written when it was.
 *
 * VALIDATION IS AGAINST THE MERGED ROW, NOT THE PATCH. A patch naming only
 * `status` still has its title and focus checked, so a rule cannot be
 * escaped by omitting the field it applies to.
 */
export async function updateCoachDevelopmentGoal(
  organizationId: string,
  coachAccountId: string,
  goalId: string,
  patch: CoachDevelopmentGoalPatch,
): Promise<CoachDevelopmentGoalRow | null> {
  const existing = await getCoachDevelopmentGoal(organizationId, coachAccountId, goalId);
  if (!existing) return null;

  const merged: CoachDevelopmentGoalInput = {
    title: patch.title ?? existing.title,
    developmentFocus: patch.developmentFocus ?? existing.development_focus,
    targetOn: patch.targetOn === undefined ? existing.target_on : patch.targetOn,
    status: patch.status ?? existing.status,
  };

  const shapeError = coachDevelopmentGoalShapeError(merged);
  if (shapeError) {
    throw new ValidationError(shapeError, 'COACH_DEVELOPMENT_GOAL_INVALID');
  }

  const targetOn = merged.targetOn?.trim() ? merged.targetOn.trim() : null;

  await queryOne(
    `update pilot.coach_development_goals
     set title = $4,
         development_focus = $5,
         target_on = $6::date,
         status = $7,
         updated_at = now()
     where organization_id = $1 and coach_account_id = $2 and goal_id = $3
     returning goal_id`,
    [
      organizationId,
      coachAccountId,
      goalId,
      merged.title.trim(),
      merged.developmentFocus.trim(),
      targetOn,
      merged.status ?? existing.status,
    ],
  );

  return getCoachDevelopmentGoal(organizationId, coachAccountId, goalId);
}

/**
 * Records development work the coach did.
 *
 * Returns null when `goalId` is given and names no goal OF THIS COACH'S --
 * a colleague's goal in the same organization reads exactly like one that
 * does not exist. The composite FK would happily accept a colleague's goal
 * id, because it only proves the goal exists in this organization; this
 * check is what keeps one coach's activity off another coach's goal, and
 * what stops the write path being used to probe for goal ids.
 *
 * Throws ForbiddenError for a coach with no active membership, checked
 * FIRST, so a caller with no standing here learns nothing about anything.
 */
export async function createCoachDevelopmentActivity(input: CoachDevelopmentActivityInput & {
  organizationId: string;
  coachAccountId: string;
}): Promise<CoachDevelopmentActivityRow | null> {
  const shapeError = coachDevelopmentActivityShapeError(input);
  if (shapeError) {
    throw new ValidationError(shapeError, 'COACH_DEVELOPMENT_ACTIVITY_INVALID');
  }

  if (!(await hasActiveMembership(input.coachAccountId, input.organizationId))) {
    throw new ForbiddenError(
      'This account holds no active membership in this organization.',
      'COACH_DEVELOPMENT_NOT_A_MEMBER',
    );
  }

  const goalId = input.goalId?.trim() ? input.goalId.trim() : null;
  if (goalId) {
    const goal = await getCoachDevelopmentGoal(input.organizationId, input.coachAccountId, goalId);
    if (!goal) return null;
  }

  const activityId = randomUUID();
  await queryOne(
    `insert into pilot.coach_development_activities
       (organization_id, activity_id, coach_account_id, goal_id, title,
        provider, occurred_on, duration_minutes, notes)
     values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)
     returning activity_id`,
    [
      input.organizationId,
      activityId,
      input.coachAccountId,
      goalId,
      input.title.trim(),
      optionalText(input.provider),
      input.occurredOn,
      input.durationMinutes ?? null,
      optionalText(input.notes),
    ],
  );

  return queryOne<CoachDevelopmentActivityRow>(
    `select ${ACTIVITY_FIELDS} from pilot.coach_development_activities
     where organization_id = $1 and coach_account_id = $2 and activity_id = $3`,
    [input.organizationId, input.coachAccountId, activityId],
  );
}

/**
 * This coach's own activity history in this organization, most recent work
 * first.
 *
 * Ordered by occurred_on rather than created_at: a coach entering last
 * month's clinic today is recording when it HAPPENED, and a list ordered by
 * typing time would put it above this week's work.
 */
export async function listCoachDevelopmentActivities(
  organizationId: string,
  coachAccountId: string,
): Promise<CoachDevelopmentActivityRow[]> {
  return query<CoachDevelopmentActivityRow>(
    `select ${ACTIVITY_FIELDS} from pilot.coach_development_activities
     where organization_id = $1 and coach_account_id = $2
     order by occurred_on desc, created_at desc, activity_id`,
    [organizationId, coachAccountId],
  );
}
