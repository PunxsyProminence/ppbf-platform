import { randomUUID } from 'node:crypto';

import {
  type AdultPathwayStageKey,
  ADULT_PATHWAY_STAGES,
  isAdultPathwayStageKey,
} from '../../shared/adultPathwayStages';

import { type ActorIdentity, accessibleAthleteIds, assertActorCanAccessAthlete } from './access';
import { ageOnGymDay, gymToday } from './competenceCohorts';
import { query, queryOne, withTransaction } from './db';
import { ForbiddenError, ValidationError } from './errors';
import { ADULT_AGE_YEARS } from './wallDisplay';

/**
 * The adult pathway for one athlete (map item 17, B1b): where a coach has
 * placed them, which stage goals a coach has confirmed, and the coach-set
 * allowance that lets a minor be placed at all. Storage is
 * infra/azure/pilot_slice_postgres_athlete_pathway_migration.sql; the stage
 * and goal vocabulary is src/shared/adultPathwayStages.ts.
 *
 * Owner decisions this module enforces:
 *   OD-2026-10-04-002  stage is coach-set, never derived or promoted;
 *   OD-2026-10-04-010  a minor may be placed only with a coach flag, which
 *                      needs a reason; no date of birth counts as a minor;
 *   OD-2026-10-04-018  switching a minor's allowance off ends their current
 *                      placement, stamped with who and when;
 *   OD-2026-10-04-019  coaches and organization admins write (same roles as
 *                      development blocks and contact caps).
 *
 * NOTHING HERE COMPUTES A STAGE. A placement is a coach's choice, written as
 * given. No function proposes, advances or derives one, and confirming every
 * goal of a stage moves nobody anywhere.
 *
 * APPEND-ONLY. A placement is replaced by stamping the old row and inserting
 * a new one; a confirmation or an allowance is undone by a withdrawn stamp.
 * There is no DELETE here.
 *
 * WHO. Staff only, both ways: an ACTIVE membership here in coach,
 * organization_admin or admin, and the athlete chokepoint
 * (assertActorCanAccessAthlete) run with that membership role -- the same
 * gate as athleteContactCaps.ts. Athletes, guardians, volunteers, board and
 * platform_owner get nothing: whether a family sees the pathway is not
 * decided, and an allowance reason is free text about a child.
 *
 * AGE. Read from pilot.athletes.dob on the gym-local day, inside the write
 * transaction with the athlete row locked, so a placement and an allowance
 * withdrawal for the same athlete cannot interleave.
 */

export const PATHWAY_WRITE_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export type PathwayWriteRole = (typeof PATHWAY_WRITE_ROLES)[number];

export const PATHWAY_TEXT_MAX = 2000;
const HISTORY_LIMIT = 20;

export interface PathwayPlacementRow {
  organization_id: string;
  placement_id: string;
  athlete_id: string;
  stage_key: AdultPathwayStageKey;
  coach_note: string;
  set_by_account_id: string;
  set_by_role: PathwayWriteRole;
  set_at: string;
  superseded_at: string | null;
  end_reason: 'replaced' | 'allowance_withdrawn' | null;
  ended_by_account_id: string | null;
  ended_by_role: PathwayWriteRole | null;
  superseded_by_placement_id: string | null;
}

export interface PathwayCheckpointRow {
  organization_id: string;
  confirmation_id: string;
  athlete_id: string;
  stage_key: AdultPathwayStageKey;
  goal_key: string;
  confirmed_by_account_id: string;
  confirmed_by_role: PathwayWriteRole;
  confirmed_at: string;
}

export interface MinorAllowanceRow {
  organization_id: string;
  allowance_id: string;
  athlete_id: string;
  reason: string;
  granted_by_account_id: string;
  granted_by_role: PathwayWriteRole;
  granted_at: string;
  withdrawn_at: string | null;
  withdrawn_by_account_id: string | null;
  withdrawn_by_role: PathwayWriteRole | null;
}

export type PathwayEligibility =
  | { readonly eligible: true; readonly basis: 'adult' | 'allowance' }
  | { readonly eligible: false; readonly basis: 'minor' | 'no_date_of_birth' };

export interface AthletePathway {
  readonly eligibility: PathwayEligibility;
  readonly allowance: MinorAllowanceRow | null;
  readonly current: PathwayPlacementRow | null;
  readonly history: readonly PathwayPlacementRow[];
  readonly checkpoints: readonly PathwayCheckpointRow[];
}

const PLACEMENT_FIELDS = `organization_id, placement_id, athlete_id, stage_key, coach_note,
  set_by_account_id, set_by_role, set_at, superseded_at, end_reason, ended_by_account_id,
  ended_by_role, superseded_by_placement_id`;

const CHECKPOINT_FIELDS = `organization_id, confirmation_id, athlete_id, stage_key, goal_key,
  confirmed_by_account_id, confirmed_by_role, confirmed_at`;

const ALLOWANCE_FIELDS = `organization_id, allowance_id, athlete_id, reason, granted_by_account_id,
  granted_by_role, granted_at, withdrawn_at, withdrawn_by_account_id, withdrawn_by_role`;

/** True only for a real (stage, goal) pair in the approved vocabulary. */
export function isPathwayGoal(stageKey: string, goalKey: string): boolean {
  return ADULT_PATHWAY_STAGES.some((s) => s.key === stageKey && s.goals.some((g) => g.key === goalKey));
}

/**
 * Who may be placed, from the stored date of birth and whether a live
 * allowance exists. Pure, so the rule is testable without a database.
 * Unknown or unreadable dob is a minor (OD-2026-10-04-010).
 */
export function pathwayEligibility(
  dob: string | null,
  hasLiveAllowance: boolean,
  now: Date = new Date(),
): PathwayEligibility {
  const age = dob ? ageOnGymDay(dob, gymToday(now)) : null;
  if (age !== null && age >= ADULT_AGE_YEARS) return { eligible: true, basis: 'adult' };
  if (hasLiveAllowance) return { eligible: true, basis: 'allowance' };
  return { eligible: false, basis: age === null ? 'no_date_of_birth' : 'minor' };
}

/**
 * The actor's role HERE, from its active membership row -- not
 * pilot.accounts.role, which is the home role. Null when it may not touch
 * the pathway in this organization.
 */
async function pathwayRoleInOrganization(actor: ActorIdentity): Promise<PathwayWriteRole | null> {
  if (!(PATHWAY_WRITE_ROLES as readonly string[]).includes(actor.role)) return null;
  const membership = await queryOne<{ role: PathwayWriteRole }>(
    `select om.role
       from pilot.organization_memberships om
      where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true
        and om.role = any($3::text[])`,
    [actor.accountId, actor.organizationId, [...PATHWAY_WRITE_ROLES]],
  );
  return membership?.role ?? null;
}

/**
 * Throws ForbiddenError unless the actor is staff here AND reaches this
 * athlete. One message for every refusal, so the response cannot reveal
 * whether an athlete exists. Non-access failures (database down) rethrow.
 */
async function assertPathwayAccess(actor: ActorIdentity, athleteId: string): Promise<PathwayWriteRole> {
  const role = await pathwayRoleInOrganization(actor);
  if (role) {
    try {
      await assertActorCanAccessAthlete({ ...actor, role }, athleteId);
      return role;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Forbidden'))) throw error;
    }
  }
  throw new ForbiddenError('This account may not read or change the pathway for this athlete.', 'PATHWAY_NOT_PERMITTED');
}

/** Of these athletes, the ones this actor may read and change the pathway for. */
export async function pathwayAccessibleAthleteIds(
  actor: ActorIdentity,
  athleteIds: readonly string[],
): Promise<Set<string>> {
  const role = await pathwayRoleInOrganization(actor);
  if (!role) return new Set();
  return accessibleAthleteIds({ ...actor, role }, athleteIds);
}

type Tx = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

/** Locks the live athlete row and returns its dob as text (null when unset). */
async function lockAthlete(tx: Tx, organizationId: string, athleteId: string): Promise<{ dob: string | null }> {
  const result = await tx.query(
    `select dob::text as dob from pilot.athletes
      where organization_id = $1 and athlete_id = $2 and deleted_at is null
      for update`,
    [organizationId, athleteId],
  );
  const row = result.rows[0] as { dob: string | null } | undefined;
  // assertPathwayAccess already proved the athlete is live; losing it here
  // means it was deleted between the two -- the same refusal, not a new one.
  if (!row) throw new ForbiddenError('This account may not read or change the pathway for this athlete.', 'PATHWAY_NOT_PERMITTED');
  return row;
}

async function liveAllowance(tx: Tx, organizationId: string, athleteId: string): Promise<MinorAllowanceRow | null> {
  const result = await tx.query(
    `select ${ALLOWANCE_FIELDS} from pilot.athlete_pathway_minor_allowances
      where organization_id = $1 and athlete_id = $2 and withdrawn_at is null
      for update`,
    [organizationId, athleteId],
  );
  return (result.rows[0] as unknown as MinorAllowanceRow | undefined) ?? null;
}

async function assertEligible(tx: Tx, organizationId: string, athleteId: string, now: Date): Promise<void> {
  const { dob } = await lockAthlete(tx, organizationId, athleteId);
  const allowance = await liveAllowance(tx, organizationId, athleteId);
  const eligibility = pathwayEligibility(dob, allowance !== null, now);
  if (!eligibility.eligible) {
    throw new ForbiddenError(
      eligibility.basis === 'no_date_of_birth'
        ? 'This athlete has no date of birth on file, so counts as a minor. A coach must switch on the adult-pathway allowance, with a reason, first.'
        : 'This athlete is under 18. A coach must switch on the adult-pathway allowance, with a reason, first.',
      'PATHWAY_ALLOWANCE_REQUIRED',
    );
  }
}

function cleanText(value: string | undefined, field: string, required: boolean): string {
  const text = (value ?? '').trim();
  if (required && text.length === 0) throw new ValidationError(`${field} is required.`, 'PATHWAY_INVALID');
  if (text.length > PATHWAY_TEXT_MAX) {
    throw new ValidationError(`${field} must be ${PATHWAY_TEXT_MAX} characters or fewer.`, 'PATHWAY_INVALID');
  }
  return text;
}

/** Staff read: eligibility, the live allowance, current placement, recent history and live checkpoints. */
export async function getAthletePathway(
  actor: ActorIdentity,
  athleteId: string,
  now: Date = new Date(),
): Promise<AthletePathway> {
  await assertPathwayAccess(actor, athleteId);
  const org = actor.organizationId;
  const athlete = await queryOne<{ dob: string | null }>(
    `select dob::text as dob from pilot.athletes
      where organization_id = $1 and athlete_id = $2 and deleted_at is null`,
    [org, athleteId],
  );
  const allowance = await queryOne<MinorAllowanceRow>(
    `select ${ALLOWANCE_FIELDS} from pilot.athlete_pathway_minor_allowances
      where organization_id = $1 and athlete_id = $2 and withdrawn_at is null`,
    [org, athleteId],
  );
  const history = await query<PathwayPlacementRow>(
    `select ${PLACEMENT_FIELDS} from pilot.athlete_pathway_stages
      where organization_id = $1 and athlete_id = $2
      order by set_at desc
      limit ${HISTORY_LIMIT}`,
    [org, athleteId],
  );
  const checkpoints = await query<PathwayCheckpointRow>(
    `select ${CHECKPOINT_FIELDS} from pilot.athlete_pathway_checkpoints
      where organization_id = $1 and athlete_id = $2 and withdrawn_at is null
      order by confirmed_at`,
    [org, athleteId],
  );
  return {
    eligibility: pathwayEligibility(athlete?.dob ?? null, allowance !== null, now),
    allowance,
    current: history.find((row) => row.superseded_at === null) ?? null,
    history,
    checkpoints,
  };
}

/**
 * Places the athlete on a stage. Replaces any current placement (stamped
 * 'replaced', naming the new one). Refused for a minor or an athlete with no
 * dob unless a live allowance exists.
 */
export async function placeAthleteOnStage(input: {
  actor: ActorIdentity;
  athleteId: string;
  stageKey: string;
  note?: string;
  now?: Date;
}): Promise<PathwayPlacementRow> {
  if (!isAdultPathwayStageKey(input.stageKey)) {
    throw new ValidationError(`Unknown pathway stage '${input.stageKey}'.`, 'PATHWAY_INVALID');
  }
  const note = cleanText(input.note, 'Note', false);
  const role = await assertPathwayAccess(input.actor, input.athleteId);
  const org = input.actor.organizationId;

  return withTransaction(async (tx) => {
    await assertEligible(tx, org, input.athleteId, input.now ?? new Date());

    const currentResult = await tx.query(
      `select placement_id, stage_key from pilot.athlete_pathway_stages
        where organization_id = $1 and athlete_id = $2 and superseded_at is null
        for update`,
      [org, input.athleteId],
    );
    const current = currentResult.rows[0] as { placement_id: string; stage_key: string } | undefined;
    if (current?.stage_key === input.stageKey) {
      throw new ValidationError('The athlete is already placed on this stage.', 'PATHWAY_ALREADY_PLACED');
    }

    const placementId = randomUUID();
    // Stamp first: the one-current index is not deferrable; the chain FK is.
    if (current) {
      await tx.query(
        `update pilot.athlete_pathway_stages
            set superseded_at = now(), end_reason = 'replaced', superseded_by_placement_id = $3,
                ended_by_account_id = $4, ended_by_role = $5
          where organization_id = $1 and placement_id = $2`,
        [org, current.placement_id, placementId, input.actor.accountId, role],
      );
    }
    const inserted = await tx.query(
      `insert into pilot.athlete_pathway_stages
         (organization_id, placement_id, athlete_id, stage_key, coach_note, set_by_account_id, set_by_role)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${PLACEMENT_FIELDS}`,
      [org, placementId, input.athleteId, input.stageKey, note, input.actor.accountId, role],
    );
    return inserted.rows[0] as unknown as PathwayPlacementRow;
  });
}

/** A coach confirms one stage goal. Same eligibility gate as placing. */
export async function confirmPathwayCheckpoint(input: {
  actor: ActorIdentity;
  athleteId: string;
  stageKey: string;
  goalKey: string;
  now?: Date;
}): Promise<PathwayCheckpointRow> {
  if (!isPathwayGoal(input.stageKey, input.goalKey)) {
    throw new ValidationError('Unknown pathway goal for that stage.', 'PATHWAY_INVALID');
  }
  const role = await assertPathwayAccess(input.actor, input.athleteId);
  const org = input.actor.organizationId;

  return withTransaction(async (tx) => {
    await assertEligible(tx, org, input.athleteId, input.now ?? new Date());
    const existing = await tx.query(
      `select 1 from pilot.athlete_pathway_checkpoints
        where organization_id = $1 and athlete_id = $2 and goal_key = $3 and withdrawn_at is null`,
      [org, input.athleteId, input.goalKey],
    );
    if (existing.rows.length > 0) {
      throw new ValidationError('That goal is already confirmed.', 'PATHWAY_ALREADY_CONFIRMED');
    }
    const inserted = await tx.query(
      `insert into pilot.athlete_pathway_checkpoints
         (organization_id, confirmation_id, athlete_id, stage_key, goal_key, confirmed_by_account_id, confirmed_by_role)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${CHECKPOINT_FIELDS}`,
      [org, randomUUID(), input.athleteId, input.stageKey, input.goalKey, input.actor.accountId, role],
    );
    return inserted.rows[0] as unknown as PathwayCheckpointRow;
  });
}

/** Undoes a confirmation by stamping it withdrawn. Not age-gated: undoing is always allowed. */
export async function withdrawPathwayCheckpoint(input: {
  actor: ActorIdentity;
  athleteId: string;
  goalKey: string;
}): Promise<void> {
  const role = await assertPathwayAccess(input.actor, input.athleteId);
  const row = await queryOne<{ confirmation_id: string }>(
    `update pilot.athlete_pathway_checkpoints
        set withdrawn_at = now(), withdrawn_by_account_id = $4, withdrawn_by_role = $5
      where organization_id = $1 and athlete_id = $2 and goal_key = $3 and withdrawn_at is null
      returning confirmation_id`,
    [input.actor.organizationId, input.athleteId, input.goalKey, input.actor.accountId, role],
  );
  if (!row) throw new ValidationError('That goal is not currently confirmed.', 'PATHWAY_NOT_CONFIRMED');
}

/** Switches the minor allowance on, with the coach's reason (required). */
export async function grantMinorAllowance(input: {
  actor: ActorIdentity;
  athleteId: string;
  reason: string;
}): Promise<MinorAllowanceRow> {
  const reason = cleanText(input.reason, 'Reason', true);
  const role = await assertPathwayAccess(input.actor, input.athleteId);
  const org = input.actor.organizationId;

  return withTransaction(async (tx) => {
    await lockAthlete(tx, org, input.athleteId);
    if (await liveAllowance(tx, org, input.athleteId)) {
      throw new ValidationError('The allowance is already on for this athlete.', 'PATHWAY_ALLOWANCE_EXISTS');
    }
    const inserted = await tx.query(
      `insert into pilot.athlete_pathway_minor_allowances
         (organization_id, allowance_id, athlete_id, reason, granted_by_account_id, granted_by_role)
       values ($1, $2, $3, $4, $5, $6)
       returning ${ALLOWANCE_FIELDS}`,
      [org, randomUUID(), input.athleteId, reason, input.actor.accountId, role],
    );
    return inserted.rows[0] as unknown as MinorAllowanceRow;
  });
}

/**
 * Switches the allowance off. If the athlete is not an adult (a minor, or no
 * dob), their current placement ends in the same transaction, stamped
 * 'allowance_withdrawn' with who did it (OD-2026-10-04-018). An adult's
 * placement does not depend on an allowance and is left alone.
 */
export async function withdrawMinorAllowance(input: {
  actor: ActorIdentity;
  athleteId: string;
  now?: Date;
}): Promise<{ allowance: MinorAllowanceRow; endedPlacementId: string | null }> {
  const role = await assertPathwayAccess(input.actor, input.athleteId);
  const org = input.actor.organizationId;

  return withTransaction(async (tx) => {
    const { dob } = await lockAthlete(tx, org, input.athleteId);
    const live = await liveAllowance(tx, org, input.athleteId);
    if (!live) throw new ValidationError('The allowance is not on for this athlete.', 'PATHWAY_NO_ALLOWANCE');

    const withdrawn = await tx.query(
      `update pilot.athlete_pathway_minor_allowances
          set withdrawn_at = now(), withdrawn_by_account_id = $3, withdrawn_by_role = $4
        where organization_id = $1 and allowance_id = $2
        returning ${ALLOWANCE_FIELDS}`,
      [org, live.allowance_id, input.actor.accountId, role],
    );

    let endedPlacementId: string | null = null;
    if (!pathwayEligibility(dob, false, input.now ?? new Date()).eligible) {
      const ended = await tx.query(
        `update pilot.athlete_pathway_stages
            set superseded_at = now(), end_reason = 'allowance_withdrawn',
                ended_by_account_id = $3, ended_by_role = $4
          where organization_id = $1 and athlete_id = $2 and superseded_at is null
          returning placement_id`,
        [org, input.athleteId, input.actor.accountId, role],
      );
      endedPlacementId = (ended.rows[0] as { placement_id: string } | undefined)?.placement_id ?? null;
    }
    return { allowance: withdrawn.rows[0] as unknown as MinorAllowanceRow, endedPlacementId };
  });
}
