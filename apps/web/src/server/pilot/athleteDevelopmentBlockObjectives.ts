import { randomUUID } from 'node:crypto';

import { getDevelopmentBlock, type DevelopmentBlockStatus } from './athleteDevelopmentBlocks';
import { query, queryOne } from './db';
import { ForbiddenError, ValidationError } from './errors';

// Full Spectrum block objectives (module 036, slice 2): what one development
// block is trying to move, one row per domain per objective, in the coach's
// own words.
//
// THIS MODULE RECORDS INTENT AND COMPUTES NOTHING. No progress percentage,
// no attainment score, no weighting between domains, and -- deliberately --
// no roll-up of objective statuses into a block-level figure. "Three of five
// objectives completed" is a count this module refuses to present as a
// judgment about an athlete, because whether a block went well is a coach's
// call and the count is not it. Reads return the rows; anything that wants
// to summarize them has to say so itself, in a later slice, authored by a
// human the way intervention_outcome_reviews already requires.
//
// TENANCY ARRIVES THROUGH THE BLOCK. Objectives carry no athlete_id: an
// objective reaches its athlete via its parent, by composite FK, so there is
// exactly one place the answer lives. Every function here is organization-
// scoped by its first argument, in the WHERE clause of every statement.

// All ten Full Spectrum domains. 'nutrition_body_composition' shipped
// withheld and was admitted by owner decision 2026-08-28, once module 200
// (the Privacy-Tier System) was in place to answer what tier the field sits
// at -- see the migration header for the full record.
//
// Two things that decision did NOT change, because a later reader will be
// tempted to assume it did: pilot.goals.category still withholds
// 'Weight Loss' / 'Weight Gain' (a different, athlete-filed surface), and
// shadowAuthority.ts still refuses 'weight_cut' in conversation. What is
// admitted here is a DOMAIN LABEL on a sentence a coach wrote -- there is
// no weight field, no target, and no platform-issued instruction to a minor.
// FIELD_TIERS['athlete_development_block_objectives.objective'] records the
// field's tier and the narrowing still owed before any read surface ships.
export const FULL_SPECTRUM_DOMAINS = [
  'technical',
  'physical',
  'conditioning',
  'mental',
  'recovery_load',
  'sparring_live_progression',
  'competition_preparation',
  'tactical_film_study',
  'lifestyle_athlete_identity',
  'nutrition_body_composition',
] as const;

export type FullSpectrumDomain = (typeof FULL_SPECTRUM_DOMAINS)[number];

/** The parent block's vocabulary, reused rather than redeclared. An
 * objective can be dropped while its block runs on, which is why it carries
 * its own state at all. */
export type ObjectiveStatus = DevelopmentBlockStatus;

export const OBJECTIVE_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;

export interface BlockObjectiveRow {
  organization_id: string;
  objective_id: string;
  block_id: string;
  domain: FullSpectrumDomain;
  objective: string;
  status: ObjectiveStatus;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

const FIELDS = `organization_id, objective_id, block_id, domain, objective, status,
  created_by_account_id, created_at, updated_at`;

export interface BlockObjectiveInput {
  domain: FullSpectrumDomain;
  objective: string;
  status?: ObjectiveStatus;
}

/**
 * The reason an input is refused, or null when it is sound. Pure, and the
 * same rules the table's CHECK constraints hold -- restated where a caller
 * can be told which one it broke. The database stays the authority.
 */
export function blockObjectiveShapeError(input: BlockObjectiveInput): string | null {
  if (!(FULL_SPECTRUM_DOMAINS as readonly string[]).includes(input.domain)) {
    return `Unknown development domain '${input.domain}'.`;
  }
  if (!input.objective?.trim()) {
    return 'An objective needs to say what it is, in the coach\'s own words.';
  }
  if (input.status && !(OBJECTIVE_STATUSES as readonly string[]).includes(input.status)) {
    return `Unknown objective status '${input.status}'.`;
  }
  return null;
}

async function hasActiveMembership(accountId: string, organizationId: string): Promise<boolean> {
  const membership = await queryOne<{ account_id: string }>(
    `select om.account_id
     from pilot.organization_memberships om
     where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true`,
    [accountId, organizationId],
  );
  return membership !== null;
}

/**
 * Adds one objective to a block.
 *
 * Returns null when the block is not in this organization -- a hidden
 * not-found, so this path cannot be used to discover that a block id is real
 * somewhere else. Throws ForbiddenError when the creator holds no active
 * membership here, checked FIRST so a caller with no standing learns nothing
 * about which blocks exist.
 */
export async function addBlockObjective(input: BlockObjectiveInput & {
  organizationId: string;
  blockId: string;
  createdByAccountId: string;
}): Promise<BlockObjectiveRow | null> {
  const shapeError = blockObjectiveShapeError(input);
  if (shapeError) {
    throw new ValidationError(shapeError, 'BLOCK_OBJECTIVE_INVALID');
  }

  if (!(await hasActiveMembership(input.createdByAccountId, input.organizationId))) {
    throw new ForbiddenError(
      'This account holds no active membership in this organization.',
      'BLOCK_OBJECTIVE_CREATOR_NOT_A_MEMBER',
    );
  }

  // Reuses the parent module's own org-scoped read rather than querying the
  // blocks table again here: one definition of "is this block mine".
  const block = await getDevelopmentBlock(input.organizationId, input.blockId);
  if (!block) return null;

  const objectiveId = randomUUID();
  await queryOne(
    `insert into pilot.athlete_development_block_objectives
       (organization_id, objective_id, block_id, domain, objective, status, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning objective_id`,
    [
      input.organizationId,
      objectiveId,
      input.blockId,
      input.domain,
      input.objective.trim(),
      input.status ?? 'draft',
      input.createdByAccountId,
    ],
  );

  return getBlockObjective(input.organizationId, objectiveId);
}

/** Null for an objective in any other organization. */
export async function getBlockObjective(
  organizationId: string,
  objectiveId: string,
): Promise<BlockObjectiveRow | null> {
  return queryOne<BlockObjectiveRow>(
    `select ${FIELDS} from pilot.athlete_development_block_objectives
     where organization_id = $1 and objective_id = $2`,
    [organizationId, objectiveId],
  );
}

/**
 * One block's objectives, grouped by domain in the order the Full Spectrum
 * list declares them, then oldest first inside a domain.
 *
 * Empty for a block in another organization: a block id is not a key into
 * this table on its own, only the pair is.
 */
export async function listObjectivesForBlock(
  organizationId: string,
  blockId: string,
): Promise<BlockObjectiveRow[]> {
  return query<BlockObjectiveRow>(
    `select ${FIELDS} from pilot.athlete_development_block_objectives
     where organization_id = $1 and block_id = $2
     order by array_position($3::text[], domain), created_at asc, objective_id asc`,
    [organizationId, blockId, [...FULL_SPECTRUM_DOMAINS]],
  );
}

/**
 * Moves one objective through its lifecycle. A human decides. Nothing here
 * completes an objective because its block's window closed, and nothing
 * cascades a block's status onto its objectives -- a completed block may
 * honestly contain an objective that was cancelled halfway through, and
 * flattening that would erase the more useful half of the record.
 *
 * Returns null for an objective in another organization.
 */
export async function setBlockObjectiveStatus(
  organizationId: string,
  objectiveId: string,
  status: ObjectiveStatus,
): Promise<BlockObjectiveRow | null> {
  if (!(OBJECTIVE_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`Unknown objective status '${status}'.`, 'BLOCK_OBJECTIVE_INVALID');
  }
  return queryOne<BlockObjectiveRow>(
    `update pilot.athlete_development_block_objectives
     set status = $3, updated_at = now()
     where organization_id = $1 and objective_id = $2
     returning ${FIELDS}`,
    [organizationId, objectiveId, status],
  );
}
