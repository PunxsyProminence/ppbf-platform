import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { ForbiddenError, ValidationError } from './errors';

// Athlete development blocks (register module 036, foundation slice): the
// coach's own multi-week plan for one athlete -- its title, what the coach
// says it is for, the window it runs over, and where it is in its lifecycle.
//
// THIS MODULE RECORDS A PLAN AND COMPUTES NOTHING. There is no readiness,
// load, fatigue, injury-risk, adherence or compliance figure here, and none
// is derivable from what this table stores. `trainingEmphasis` is the
// coach's own words, written down verbatim and read back verbatim -- never
// parsed into a periodization taxonomy, never autocompleted, never given a
// platform-asserted meaning. The refusal is the same one
// interventionExecutions makes when it keeps adherence an enumerated human
// state instead of a percentage.
//
// EVERY FUNCTION HERE IS ORGANIZATION-SCOPED BY ITS FIRST ARGUMENT, and the
// scoping is in the WHERE clause of every statement rather than in a caller's
// discipline. The database enforces the other half: the composite FK into
// pilot.athletes means a block cannot name an athlete in another
// organization even if a caller asks it to.
//
// No API route or UI exists yet. Who may author a block IS now decided --
// owner decision 2026-08-28, "Admin and coaches" -- and it is enforced here
// rather than left to a future route, because the floor this module shipped
// with was too low: an ACTIVE membership of ANY role satisfied it, and
// pilot.organization_memberships.role admits 'athlete', 'parent' and
// 'volunteer'. Nothing could reach it (there is no route), but a data layer
// that would let an athlete file their own development block is not a floor
// worth shipping.

export const DEVELOPMENT_BLOCK_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;

export type DevelopmentBlockStatus = (typeof DEVELOPMENT_BLOCK_STATUSES)[number];

export interface AthleteDevelopmentBlockRow {
  organization_id: string;
  block_id: string;
  athlete_id: string;
  title: string;
  training_emphasis: string;
  starts_on: string;
  ends_on: string;
  status: DevelopmentBlockStatus;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

// Dates come back as text, not as a driver Date: a block window is a
// calendar range the coach typed, and routing it through a JS Date would
// re-interpret it in the server's timezone.
const FIELDS = `organization_id, block_id, athlete_id, title, training_emphasis,
  starts_on::text as starts_on, ends_on::text as ends_on, status,
  created_by_account_id, created_at, updated_at`;

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

export interface DevelopmentBlockInput {
  title: string;
  trainingEmphasis: string;
  startsOn: string;
  endsOn: string;
  status?: DevelopmentBlockStatus;
}

/**
 * The reason an input is refused, or null when it is sound.
 *
 * Pure, and deliberately separate from the write: these are the same rules
 * the table's own CHECK constraints hold, restated where a caller can be
 * told which one it broke rather than receiving a driver error. The database
 * remains the authority -- this function existing is not a reason to trust
 * any write path that skips it.
 */
export function developmentBlockShapeError(input: DevelopmentBlockInput): string | null {
  if (!input.title?.trim()) {
    return 'A development block needs a title.';
  }
  if (!input.trainingEmphasis?.trim()) {
    // The whole point of the row. A block with a blank emphasis is a date
    // range, and reading one back later as a plan would be a lie.
    return 'A development block needs a stated training emphasis, in the coach\'s own words.';
  }
  if (!isCalendarDate(input.startsOn ?? '')) {
    return 'starts_on must be a calendar date written as YYYY-MM-DD.';
  }
  if (!isCalendarDate(input.endsOn ?? '')) {
    return 'ends_on must be a calendar date written as YYYY-MM-DD.';
  }
  // ISO dates of equal length compare correctly as strings.
  if (input.endsOn < input.startsOn) {
    return 'A development block cannot end before it begins.';
  }
  if (input.status && !(DEVELOPMENT_BLOCK_STATUSES as readonly string[]).includes(input.status)) {
    return `Unknown block status '${input.status}'.`;
  }
  return null;
}

/**
 * Who may author a development block or its objectives (owner decision,
 * 2026-08-28: "Admin and coaches").
 *
 * Named and shaped like COMPETITION_WRITE_ROLES and LEAGUE_WRITE_ROLES, the
 * two existing per-surface write vocabularies, and exported so the objectives
 * module enforces the same list rather than a second copy of it.
 *
 * platform_owner is deliberately absent, matching both of those surfaces: a
 * block is one gym's coaching record about one of its athletes, and the
 * platform owner reads across organizations at strictly less depth
 * (shadowRoleSets.ts). athlete, parent and volunteer are not write roles
 * here -- a development block is a coach's plan FOR an athlete, not a thing
 * the athlete files about themselves; pilot.goals is where an athlete's own
 * goals live.
 */
export const DEVELOPMENT_BLOCK_WRITE_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export type DevelopmentBlockWriteRole = (typeof DEVELOPMENT_BLOCK_WRITE_ROLES)[number];

/**
 * Does this account hold an ACTIVE membership in this organization, in a role
 * that may author blocks?
 *
 * Two things this deliberately does not ask:
 *
 * pilot.accounts.organization_id -- the account's single denormalized home
 * organization -- is the wrong question. A coach whose home organization is
 * elsewhere but who holds an active membership here may legitimately author a
 * block here, and an account whose membership was deactivated may not,
 * however its home column reads. auth.ts asks the membership table for
 * exactly this reason.
 *
 * pilot.accounts.role is also the wrong question: it is the account's home
 * role, and the same account can hold a different role in a different gym.
 * The role that matters is the one on the membership row for THIS
 * organization, which is what the query below reads.
 *
 * Exported for the objectives module, so one decision is enforced in one
 * place for both tables.
 */
export async function hasBlockWriteMembership(
  accountId: string,
  organizationId: string,
): Promise<boolean> {
  const membership = await queryOne<{ account_id: string }>(
    `select om.account_id
     from pilot.organization_memberships om
     where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true
       and om.role = any($3::text[])`,
    [accountId, organizationId, [...DEVELOPMENT_BLOCK_WRITE_ROLES]],
  );
  return membership !== null;
}

/**
 * Records a coach's block for one athlete.
 *
 * Returns null when the athlete is not in this organization -- a hidden
 * not-found, so a caller cannot use this path to discover that an athlete id
 * exists somewhere else. Throws ForbiddenError when the creator holds no
 * active membership in the block's organization, which is checked FIRST so
 * that a caller with no standing here learns nothing about the roster.
 */
export async function createDevelopmentBlock(input: DevelopmentBlockInput & {
  organizationId: string;
  athleteId: string;
  createdByAccountId: string;
}): Promise<AthleteDevelopmentBlockRow | null> {
  const shapeError = developmentBlockShapeError(input);
  if (shapeError) {
    throw new ValidationError(shapeError, 'DEVELOPMENT_BLOCK_INVALID');
  }

  if (!(await hasBlockWriteMembership(input.createdByAccountId, input.organizationId))) {
    // One message for every denial reason -- no membership, an inactive one,
    // or an active one in a role that may not author. A caller cannot tell
    // which from the response.
    throw new ForbiddenError(
      'This account may not author development blocks in this organization.',
      'DEVELOPMENT_BLOCK_CREATOR_NOT_PERMITTED',
    );
  }

  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  const blockId = randomUUID();
  await queryOne(
    `insert into pilot.athlete_development_blocks
       (organization_id, block_id, athlete_id, title, training_emphasis,
        starts_on, ends_on, status, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9)
     returning block_id`,
    [
      input.organizationId,
      blockId,
      input.athleteId,
      input.title.trim(),
      input.trainingEmphasis.trim(),
      input.startsOn,
      input.endsOn,
      input.status ?? 'draft',
      input.createdByAccountId,
    ],
  );

  return getDevelopmentBlock(input.organizationId, blockId);
}

/** Null for a block in any other organization -- the caller cannot tell that
 * from a block id that does not exist at all. */
export async function getDevelopmentBlock(
  organizationId: string,
  blockId: string,
): Promise<AthleteDevelopmentBlockRow | null> {
  return queryOne<AthleteDevelopmentBlockRow>(
    `select ${FIELDS} from pilot.athlete_development_blocks
     where organization_id = $1 and block_id = $2`,
    [organizationId, blockId],
  );
}

/** One athlete's blocks, newest window first. Empty for an athlete in
 * another organization: the athlete id is not a key into this table on its
 * own, only the pair is. */
export async function listDevelopmentBlocksForAthlete(
  organizationId: string,
  athleteId: string,
): Promise<AthleteDevelopmentBlockRow[]> {
  return query<AthleteDevelopmentBlockRow>(
    `select ${FIELDS} from pilot.athlete_development_blocks
     where organization_id = $1 and athlete_id = $2
     order by starts_on desc, block_id asc`,
    [organizationId, athleteId],
  );
}

/** Every block in one gym: running ones first, then drafts, then the
 * finished and abandoned ones. */
export async function listDevelopmentBlocks(
  organizationId: string,
): Promise<AthleteDevelopmentBlockRow[]> {
  return query<AthleteDevelopmentBlockRow>(
    `select ${FIELDS} from pilot.athlete_development_blocks
     where organization_id = $1
     order by array_position(array['active','draft','completed','cancelled'], status),
              starts_on desc, block_id asc`,
    [organizationId],
  );
}

/**
 * Moves a block through its lifecycle. A human decides; nothing here reads a
 * date and advances a block on its own, because "the window has elapsed" and
 * "the block was completed" are different claims and only a coach can make
 * the second one.
 *
 * Returns null for a block in another organization, so the update cannot be
 * used to probe for one.
 */
export async function setDevelopmentBlockStatus(
  organizationId: string,
  blockId: string,
  status: DevelopmentBlockStatus,
): Promise<AthleteDevelopmentBlockRow | null> {
  if (!(DEVELOPMENT_BLOCK_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`Unknown block status '${status}'.`, 'DEVELOPMENT_BLOCK_INVALID');
  }
  return queryOne<AthleteDevelopmentBlockRow>(
    `update pilot.athlete_development_blocks
     set status = $3, updated_at = now()
     where organization_id = $1 and block_id = $2
     returning ${FIELDS}`,
    [organizationId, blockId, status],
  );
}
