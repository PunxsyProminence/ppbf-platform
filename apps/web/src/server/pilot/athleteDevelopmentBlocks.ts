import { randomUUID } from 'node:crypto';

import { type ActorIdentity, accessibleAthleteIds, assertActorCanAccessAthlete } from './access';
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
// READS ARE ATHLETE-SCOPED, NOT MERELY ORGANIZATION-SCOPED (owner decision,
// 2026-08-28: reads are for "Admin, Coach, Athlete, Guardian"). Every read
// takes an ActorIdentity and goes through assertActorCanAccessAthlete --
// access.ts's chokepoint, which already implements exactly those four and
// refuses platform_owner and board. Reusing it rather than writing a role
// list here means a block is reachable by precisely the people who can
// already reach the athlete it is about: an org admin anywhere in their gym,
// the athlete's coach of record or an active coverage holder, the athlete
// themselves, and their linked guardian.
//
// That matters more since the objectives table admitted its
// nutrition_body_composition domain: an objective can now hold a
// body-composition target naming a minor, and org-wide staff reads were
// broader than that athlete's own date of birth.
//
// Organization scoping stays underneath all of it -- actor.organizationId is
// in the WHERE clause of every statement, and the composite FK into
// pilot.athletes means a block cannot name an athlete in another
// organization even if a caller asks it to.
//
// Routes and screens now exist -- staff at /api/pilot/coach/development-blocks
// and /api/pilot/coach/development-block-objectives, a family at GET
// /api/pilot/athlete/development-blocks -- and none of them holds a database
// handle, so this module is the only way to these rows rather than one way of
// several. privacyTiers.test.ts is what keeps that true.
//
// Who may author a block IS decided -- owner decision 2026-08-28, "Admin and
// coaches" -- and it is enforced here rather than left to the routes, because
// the floor this module shipped with was too low: an ACTIVE membership of ANY
// role satisfied it, and pilot.organization_memberships.role admits 'athlete',
// 'parent' and 'volunteer'. That mattered before anything could reach it and
// matters more now that a family route can: the family route carries no write
// verb, but a data layer that would let an athlete file their own development
// block is not a floor worth shipping in either world.

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
  /* What this block is preparing for, or null -- which is the ordinary case.
     At most one of the two is ever set; the database holds that, not this
     type. A target is a DATE AND A NAME: nothing in this module or anything
     reading it derives a taper, a peak, a volume curve or a weight plan from
     it, and neither competition surface carries anything one could. */
  target_competition_id: string | null;
  target_wrestling_event_id: string | null;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

// Dates come back as text, not as a driver Date: a block window is a
// calendar range the coach typed, and routing it through a JS Date would
// re-interpret it in the server's timezone.
const FIELDS = `organization_id, block_id, athlete_id, title, training_emphasis,
  starts_on::text as starts_on, ends_on::text as ends_on, status,
  target_competition_id, target_wrestling_event_id,
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
 * Read access, as a boolean rather than a throw.
 *
 * assertActorCanAccessAthlete throws a plain Error, which is right for a
 * route guard and wrong here: these reads answer "not found" rather than
 * "forbidden" so a caller cannot use them to discover that a block exists
 * for someone else's athlete. Same reason the org-scoped reads already
 * returned null rather than raising.
 */
async function canActorReachAthlete(actor: ActorIdentity, athleteId: string): Promise<boolean> {
  try {
    await assertActorCanAccessAthlete(actor, athleteId);
    return true;
  } catch {
    return false;
  }
}

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
  actor: ActorIdentity;
  athleteId: string;
}): Promise<AthleteDevelopmentBlockRow | null> {
  const shapeError = developmentBlockShapeError(input);
  if (shapeError) {
    throw new ValidationError(shapeError, 'DEVELOPMENT_BLOCK_INVALID');
  }

  if (!(await hasBlockWriteMembership(input.actor.accountId, input.actor.organizationId))) {
    // One message for every denial reason -- no membership, an inactive one,
    // or an active one in a role that may not author. A caller cannot tell
    // which from the response.
    throw new ForbiddenError(
      'This account may not author development blocks in this organization.',
      'DEVELOPMENT_BLOCK_CREATOR_NOT_PERMITTED',
    );
  }

  // The athlete must exist in this organization AND be one this actor can
  // reach. The second half follows from the read decision rather than
  // extending it: a coach who could author a block they then could not open
  // would be an incoherent model, and every other athlete-scoped write in
  // this codebase goes through the same chokepoint. For an org admin this is
  // "anyone in my gym"; for a coach it is their own athletes and anyone they
  // are currently covering.
  //
  // Null for both cases, so a caller cannot separate "no such athlete" from
  // "not yours".
  if (!(await canActorReachAthlete(input.actor, input.athleteId))) return null;

  const blockId = randomUUID();
  await queryOne(
    `insert into pilot.athlete_development_blocks
       (organization_id, block_id, athlete_id, title, training_emphasis,
        starts_on, ends_on, status, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9)
     returning block_id`,
    [
      input.actor.organizationId,
      blockId,
      input.athleteId,
      input.title.trim(),
      input.trainingEmphasis.trim(),
      input.startsOn,
      input.endsOn,
      input.status ?? 'draft',
      input.actor.accountId,
    ],
  );

  return getDevelopmentBlock(input.actor, blockId);
}

/**
 * Null for a block in another organization, AND null for a block about an
 * athlete this actor cannot reach. The caller cannot tell either from a
 * block id that does not exist at all -- one answer for three different
 * reasons is the point.
 */
export async function getDevelopmentBlock(
  actor: ActorIdentity,
  blockId: string,
): Promise<AthleteDevelopmentBlockRow | null> {
  const block = await queryOne<AthleteDevelopmentBlockRow>(
    `select ${FIELDS} from pilot.athlete_development_blocks
     where organization_id = $1 and block_id = $2`,
    [actor.organizationId, blockId],
  );
  if (!block) return null;
  return (await canActorReachAthlete(actor, block.athlete_id)) ? block : null;
}

/**
 * One athlete's blocks, newest window first.
 *
 * Empty for an athlete in another organization -- the athlete id is not a key
 * into this table on its own, only the pair is -- and empty for an athlete
 * this actor cannot reach. An athlete asking for their own history gets it;
 * an athlete asking for someone else's gets nothing, not an error.
 */
export async function listDevelopmentBlocksForAthlete(
  actor: ActorIdentity,
  athleteId: string,
): Promise<AthleteDevelopmentBlockRow[]> {
  if (!(await canActorReachAthlete(actor, athleteId))) return [];
  return query<AthleteDevelopmentBlockRow>(
    `select ${FIELDS} from pilot.athlete_development_blocks
     where organization_id = $1 and athlete_id = $2
     order by starts_on desc, block_id asc`,
    [actor.organizationId, athleteId],
  );
}

/**
 * The blocks in one gym that THIS actor may see: running ones first, then
 * drafts, then the finished and abandoned ones.
 *
 * Filtered through accessibleAthleteIds -- assertActorCanAccessAthlete's
 * batched counterpart -- rather than by asking per row, so an org admin gets
 * the whole gym, a coach gets their own athletes and anyone they are
 * currently covering, an athlete gets their own, and a guardian gets their
 * linked children's. The list is the union of what the caller could have
 * asked for one at a time; it is never a gym-wide read wearing a filter.
 */
export async function listDevelopmentBlocks(
  actor: ActorIdentity,
): Promise<AthleteDevelopmentBlockRow[]> {
  const rows = await query<AthleteDevelopmentBlockRow>(
    `select ${FIELDS} from pilot.athlete_development_blocks
     where organization_id = $1
     order by array_position(array['active','draft','completed','cancelled'], status),
              starts_on desc, block_id asc`,
    [actor.organizationId],
  );
  if (rows.length === 0) return rows;
  const reachable = await accessibleAthleteIds(actor, rows.map((row) => row.athlete_id));
  return rows.filter((row) => reachable.has(row.athlete_id));
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
  actor: ActorIdentity,
  blockId: string,
  status: DevelopmentBlockStatus,
): Promise<AthleteDevelopmentBlockRow | null> {
  if (!(DEVELOPMENT_BLOCK_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`Unknown block status '${status}'.`, 'DEVELOPMENT_BLOCK_INVALID');
  }

  // MOVING A BLOCK IS AUTHORING IT. This check did not exist before reads
  // opened up, and its absence was survivable only because nothing could
  // call it: the function was organization-scoped and nothing else. Now that
  // an athlete and a guardian can READ their own blocks, an ungated status
  // mutator is a real hole -- an athlete marking their own block 'completed'
  // is precisely the coach judgment this table refuses to compute.
  // "Admin and coaches" (owner decision 2026-08-28) governs every write, not
  // only the first one.
  if (!(await hasBlockWriteMembership(actor.accountId, actor.organizationId))) {
    throw new ForbiddenError(
      'This account may not modify development blocks in this organization.',
      'DEVELOPMENT_BLOCK_WRITER_NOT_PERMITTED',
    );
  }

  const block = await getDevelopmentBlock(actor, blockId);
  if (!block) return null;

  return queryOne<AthleteDevelopmentBlockRow>(
    `update pilot.athlete_development_blocks
     set status = $3, updated_at = now()
     where organization_id = $1 and block_id = $2
     returning ${FIELDS}`,
    [actor.organizationId, blockId, status],
  );
}

/**
 * Corrects the plan a coach wrote: title, emphasis, window, status.
 *
 * WHAT THIS CANNOT MOVE, and why each one is left out rather than guarded:
 *
 *   organization_id  a block does not change gyms. The pair (organization,
 *                    block) is the key, so accepting one here would turn a
 *                    correction into a cross-tenant write.
 *   athlete_id       a block is a plan FOR somebody. Re-pointing it at a
 *                    different athlete silently reassigns a coach's authored
 *                    intent to a child it was never about, and every
 *                    authorization decision already made about the old row
 *                    would have been made about the wrong person. Cancel one
 *                    and write another.
 *   created_by       who authored this is a fact about the past. The order
 *                    this slice serves asks for creator attribution to be
 *                    preserved; the way to preserve it is to have no path
 *                    that writes it twice.
 *
 * It DOES move the competition/event target, because that lives on this row
 * and a separate statement for it was a second chance to half-succeed.
 *
 * Every field is optional and an omitted one is left alone, so a caller
 * correcting an end date cannot blank an emphasis by not mentioning it --
 * the failure a whole-row PUT has by construction.
 *
 * The window is validated as a WHOLE, against the merged row rather than the
 * patch: moving only starts_on past an untouched ends_on is exactly the edit
 * that produces a block ending before it begins, and a patch-only check
 * cannot see it.
 *
 * Returns null for a block in another organization, one about an athlete this
 * actor cannot reach, or one that does not exist -- so this cannot be used to
 * probe for any of the three.
 *
 * CORRECTING A PLAN IS AUTHORING IT, so this carries the same
 * DEVELOPMENT_BLOCK_WRITE_ROLES gate the create path and the status setter
 * carry. This function arrived from #767 while reads were still
 * organization-scoped, when the route above it was the only thing standing
 * between an athlete and their own block's title; now that an athlete and a
 * guardian can READ a block, the gate belongs here, next to the other two,
 * rather than in the one route that happens to exist today.
 */
export type DevelopmentBlockTargetKind = 'competition' | 'wrestling_event';

/**
 * What a block is preparing for, as a caller states it.
 *
 * Declared here rather than beside the resolver so that this module -- which
 * owns the row and therefore the write -- can accept it without importing
 * from a module that already imports from this one. `{ kind: 'none' }` is an
 * explicit clear, which is why it is a value rather than a null: on a patch,
 * null and absent cannot both be distinguishable.
 */
export type DevelopmentBlockTargetInput =
  | { kind: 'none' }
  | { kind: DevelopmentBlockTargetKind; id: string };

export interface DevelopmentBlockPatch {
  title?: string;
  trainingEmphasis?: string;
  startsOn?: string;
  endsOn?: string;
  status?: DevelopmentBlockStatus;
  /**
   * Omitted leaves the block's target alone; `{ kind: 'none' }` clears it.
   *
   * Carried on the patch, and therefore written by the SAME single UPDATE as
   * the fields, because two statements are two chances to half-succeed. A
   * caller told "that failed" while the title, dates and updated_at already
   * moved will retry, and the retry is not idempotent against a plan a coach
   * wrote. Found by review on #771, where this was two calls.
   */
  target?: DevelopmentBlockTargetInput;
}

export async function updateDevelopmentBlock(
  actor: ActorIdentity,
  blockId: string,
  patch: DevelopmentBlockPatch,
): Promise<AthleteDevelopmentBlockRow | null> {
  if (!(await hasBlockWriteMembership(actor.accountId, actor.organizationId))) {
    throw new ForbiddenError(
      'This account may not modify development blocks in this organization.',
      'DEVELOPMENT_BLOCK_WRITER_NOT_PERMITTED',
    );
  }

  const existing = await getDevelopmentBlock(actor, blockId);
  if (!existing) return null;

  const merged: DevelopmentBlockInput = {
    title: patch.title ?? existing.title,
    trainingEmphasis: patch.trainingEmphasis ?? existing.training_emphasis,
    startsOn: patch.startsOn ?? existing.starts_on,
    endsOn: patch.endsOn ?? existing.ends_on,
    status: patch.status ?? existing.status,
  };

  // The same rules the create path runs, applied to what the row will BE.
  // Every refusal happens BEFORE the statement below, so a rejected patch
  // leaves the stored row untouched rather than half-applied.
  const shapeError = developmentBlockShapeError(merged);
  if (shapeError) {
    throw new ValidationError(shapeError, 'DEVELOPMENT_BLOCK_INVALID');
  }

  if (patch.target && patch.target.kind !== 'none' && !patch.target.id?.trim()) {
    throw new ValidationError(
      'A development block target needs the id of the competition or event it names.',
      'DEVELOPMENT_BLOCK_TARGET_INVALID',
    );
  }

  /* An omitted target keeps whatever the row already names; a stated one
     replaces it. Computed here rather than in the SQL so the two columns are
     always written as a pair -- the database's single-target check is the
     backstop, not the mechanism. */
  const competitionId = patch.target
    ? (patch.target.kind === 'competition' ? patch.target.id.trim() : null)
    : existing.target_competition_id;
  const wrestlingEventId = patch.target
    ? (patch.target.kind === 'wrestling_event' ? patch.target.id.trim() : null)
    : existing.target_wrestling_event_id;

  /* ONE statement for the fields and the target together. They used to be two
     calls in the route, and a target that failed its foreign key left the
     title, dates, status and updated_at already committed -- a caller told the
     request failed, looking at a row that had moved. */
  return queryOne<AthleteDevelopmentBlockRow>(
    `update pilot.athlete_development_blocks
     set title = $3,
         training_emphasis = $4,
         starts_on = $5::date,
         ends_on = $6::date,
         status = $7,
         target_competition_id = $8,
         target_wrestling_event_id = $9,
         updated_at = now()
     where organization_id = $1 and block_id = $2
     returning ${FIELDS}`,
    [
      actor.organizationId,
      blockId,
      merged.title.trim(),
      merged.trainingEmphasis.trim(),
      merged.startsOn,
      merged.endsOn,
      merged.status ?? existing.status,
      competitionId,
      wrestlingEventId,
    ],
  );
}
