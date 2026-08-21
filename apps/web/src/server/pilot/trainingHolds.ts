import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { isContactObservation } from './contactClearanceGate';
import { query, queryOne, withTransaction } from './db';
import { fileEscalation } from './escalationLadder';
import { findNearMissByTriggerContext, flagNearMiss } from './shadowNearMisses';

/**
 * Training holds (capability #82: Stop / Hold / Regress).
 *
 * The three words, as decided with the owner (2026-08-06):
 *   STOP    -- an active 'all_training' hold blocks class registration at
 *              request time (schedulerDb.registerForClassTransactionally).
 *   HOLD    -- scope 'all_training': training paused until a person lifts
 *              it. Durable, attributed, expiring, linear (one active hold
 *              per athlete).
 *   REGRESS -- scope 'contact_only' / 'conditioning_only': training
 *              CONTINUES at reduced scope. What regresses is the permitted
 *              intensity, never the athlete's standing -- the platform has
 *              no athlete ranks, by recorded doctrine, and this module
 *              refuses to introduce one. Skill-content regression belongs
 *              to capabilities #23/#62.
 *
 * AUTHORITY (owner decision): coaches place and lift holds for their own
 * athletes; organization admins place and lift any. Role checks live at the
 * route layer (requirePrincipal + assertCoachAssignedToAthlete); this
 * module records who acted and files the escalation.
 *
 * Every placement files a 'training_hold' escalation IN THE SAME
 * TRANSACTION -- a hold that could commit without its alarm, or vice
 * versa, would let a child's training be paused with no admin surface ever
 * knowing. Resolving that escalation does NOT lift the hold: an escalation
 * resolves when a human has looked; a hold lifts here, attributed, or
 * expires on its own clock.
 *
 * The lift transition copies the escalation ladder's guarded-UPDATE
 * pattern: `status = 'active'` is a predicate ON the UPDATE, so a stale
 * page or a raced request cannot re-lift (and re-attribute) an already
 * lifted hold, and an expired hold cannot be dressed up as a deliberate
 * lift after the fact.
 */

export type TrainingHoldScope = 'all_training' | 'contact_only' | 'conditioning_only';
export type TrainingHoldReasonCategory = 'medical' | 'fatigue' | 'behavioral' | 'administrative' | 'other';
export type TrainingHoldStatus = 'active' | 'lifted' | 'expired';

export const TRAINING_HOLD_SCOPES: readonly TrainingHoldScope[] = [
  'all_training',
  'contact_only',
  'conditioning_only',
];

/**
 * The subset of the vocabulary a NEW hold may be placed with.
 *
 * 'conditioning_only' stays in TRAINING_HOLD_SCOPES and in the type because
 * historical rows carry it and every read/display path must keep rendering
 * them -- but it is deliberately absent here, so it can no longer be OFFERED.
 * Every enforcement probe in this module and in competitionSafetyGates.ts
 * reads `scope in ('all_training', 'contact_only')`; a conditioning_only hold
 * was recorded, shown to the guardian and athlete as "Conditioning is paused
 * right now", and then stopped nothing. A safety promise the platform cannot
 * keep is worse than not making it. If enforcement for a conditioning bar is
 * ever built, adding the scope back here is the deliberate act that re-offers
 * it.
 */
export const OPERATIONAL_TRAINING_HOLD_SCOPES: readonly TrainingHoldScope[] = [
  'all_training',
  'contact_only',
];

export const TRAINING_HOLD_REASON_CATEGORIES: readonly TrainingHoldReasonCategory[] = [
  'medical',
  'fatigue',
  'behavioral',
  'administrative',
  'other',
];

export interface TrainingHoldRow {
  hold_id: string;
  athlete_id: string;
  scope: TrainingHoldScope;
  reason_category: TrainingHoldReasonCategory;
  reason_text: string;
  athlete_explanation: string;
  lift_condition_text: string;
  placed_by_account_id: string;
  placed_by_role: string;
  placed_at: string;
  expires_at: string | null;
  lifted_by_account_id: string | null;
  lifted_at: string | null;
  lift_note: string;
  status: TrainingHoldStatus;
  created_at: string;
  updated_at: string;
}

const HOLD_COLUMNS = `hold_id, athlete_id, scope, reason_category, reason_text, athlete_explanation,
       lift_condition_text, placed_by_account_id, placed_by_role, placed_at::text,
       expires_at::text, lifted_by_account_id, lifted_at::text, lift_note, status,
       created_at::text, updated_at::text`;

function isMissingTableError(error: unknown): boolean {
  return (error as { code?: unknown }).code === '42P01';
}

/**
 * There is no cron in this codebase (see shadowRecommendations.ts's
 * listRecommendations for the same idiom on provisional recommendations),
 * so a hold whose clock ran out is swept to 'expired' the moment anything
 * next touches that athlete's holds. Without this, status stays 'active'
 * forever on a lapsed row: the staff list would show a child as protected
 * when they are not, a new hold could not be placed without first "lifting"
 * the lapsed one (mis-attributing an expiry as a deliberate action) -- the
 * partial unique index is keyed on status='active' alone, so a merely
 * read-time expiry predicate is not enough to free the slot for a new
 * hold, and the module's own claim that "an expired hold cannot be dressed
 * up as a deliberate lift" would be false.
 *
 * Deliberately does NOT swallow a missing-table error itself: called
 * inside a write transaction (placeTrainingHold), a missing table should
 * fail that write outright, same as today. Callers on a read path wrap
 * this together with their own query in one try/catch so the whole
 * operation degrades to "no holds" rather than 25P02-poisoning whatever
 * runs next in an unrelated caller's transaction.
 */
async function sweepExpiredHolds(
  organizationId: string,
  athleteId: string | undefined,
  client: PoolClient | undefined,
): Promise<void> {
  const sql = `update pilot.training_holds
     set status = 'expired', updated_at = now()
     where organization_id = $1
       and ($2::text is null or athlete_id = $2)
       and status = 'active' and expires_at is not null and expires_at <= now()`;
  const params = [organizationId, athleteId ?? null];
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}

export interface PlaceHoldInput {
  organizationId: string;
  athleteId: string;
  scope: TrainingHoldScope;
  reasonCategory: TrainingHoldReasonCategory;
  /** Staff-facing detail. Never rendered to the athlete. */
  reasonText: string;
  /** The sentence the athlete reads. Required, non-punitive, age-appropriate. */
  athleteExplanation: string;
  /** What earns the lift -- the teaching moment. */
  liftConditionText: string;
  placedByAccountId: string;
  placedByRole: 'coach' | 'organization_admin' | 'admin';
  /** Optional hard end. Null means until explicitly lifted. */
  expiresAt?: string | null;
}

/**
 * Places a hold and files its escalation in one transaction. Refuses when
 * an active hold already exists (linear history -- lift the first one; the
 * partial unique index backs this at the database level).
 *
 * Severity mapping: an 'all_training' stop is a louder event than a scoped
 * regression, so it files 'high' and scoped holds file 'moderate'. The
 * escalation exists so admins SEE the pause; the hold itself is the state.
 */
export async function placeTrainingHold(input: PlaceHoldInput): Promise<TrainingHoldRow> {
  return withTransaction(async (client) => {
    // Free a lapsed slot before the duplicate check: the partial unique
    // index is keyed on status='active' alone, so a stale-but-active row
    // would otherwise both fail the duplicate check with a misattributing
    // "lift it first" AND collide at the index on insert. A missing table
    // here fails this write outright -- correct: there is nothing sensible
    // to place a hold into.
    await sweepExpiredHolds(input.organizationId, input.athleteId, client);

    const existing = await client.query<{ hold_id: string }>(
      `select hold_id from pilot.training_holds
       where organization_id = $1 and athlete_id = $2 and status = 'active'
       limit 1`,
      [input.organizationId, input.athleteId],
    );
    if (existing.rows.length > 0) {
      throw new Error(`Hold already exists: ${existing.rows[0].hold_id} is active for this athlete -- lift it first`);
    }

    const holdId = randomUUID();
    let inserted;
    try {
      inserted = await client.query<TrainingHoldRow>(
        `insert into pilot.training_holds (
           organization_id, hold_id, athlete_id, scope, reason_category, reason_text,
           athlete_explanation, lift_condition_text,
           placed_by_account_id, placed_by_role, expires_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning ${HOLD_COLUMNS}`,
        [
          input.organizationId,
          holdId,
          input.athleteId,
          input.scope,
          input.reasonCategory,
          input.reasonText,
          input.athleteExplanation,
          input.liftConditionText,
          input.placedByAccountId,
          input.placedByRole,
          input.expiresAt ?? null,
        ],
      );
    } catch (error) {
      // The sweep-then-check above closes the ordinary race, but two
      // simultaneous placements can both pass the check before either
      // commits; the loser hits the partial unique index directly. Surface
      // the same caller-facing conflict the check produces, not a raw 500.
      if ((error as { code?: unknown }).code === '23505') {
        throw new Error('Hold already exists: an active hold was placed concurrently for this athlete -- lift it first');
      }
      throw error;
    }

    await fileEscalation(
      {
        organizationId: input.organizationId,
        sourceType: 'training_hold',
        sourceId: holdId,
        athleteId: input.athleteId,
        severity: input.scope === 'all_training' ? 'high' : 'moderate',
        reason:
          `Training ${input.scope === 'all_training' ? 'paused' : 'restricted'} (${input.reasonCategory}). `
          + 'The hold record carries the explanation and the lift condition; resolving this escalation does not lift the hold.',
        escalatedToRole: 'organization_admin',
        triggeredBy: 'human',
        triggeredByAccountId: input.placedByAccountId,
        triggeredByRole: input.placedByRole,
        metadata: { hold_id: holdId, scope: input.scope, reason_category: input.reasonCategory },
      },
      client,
    );

    return inserted.rows[0];
  });
}

/**
 * Lifts an active hold. Guarded to 'active' rows on the UPDATE itself; when
 * nothing matches, re-reads to distinguish "no such hold" (null -- routes
 * surface Missing) from "not liftable from its current state" (throws
 * 'Unsupported transition', a caller mistake, not a server fault).
 */
export async function liftTrainingHold(
  organizationId: string,
  holdId: string,
  liftedByAccountId: string,
  liftNote: string,
): Promise<TrainingHoldRow | null> {
  // The expiry predicate on the UPDATE itself is what makes the module's
  // claim true: without it, a hold whose clock ran out is still
  // status='active' in storage (nothing sweeps a single hold-id lookup),
  // so this guarded UPDATE would happily "lift" it -- stamping
  // lifted_by_account_id/lifted_at on an action nobody took.
  const lifted = await queryOne<TrainingHoldRow>(
    `update pilot.training_holds
     set status = 'lifted', lifted_by_account_id = $3, lifted_at = now(),
         lift_note = coalesce(nullif($4, ''), lift_note), updated_at = now()
     where organization_id = $1 and hold_id = $2 and status = 'active'
       and (expires_at is null or expires_at > now())
     returning ${HOLD_COLUMNS}`,
    [organizationId, holdId, liftedByAccountId, liftNote],
  );
  if (lifted) return lifted;

  const existing = await queryOne<{ status: TrainingHoldStatus; expires_at: string | null }>(
    'select status, expires_at::text from pilot.training_holds where organization_id = $1 and hold_id = $2',
    [organizationId, holdId],
  );
  if (!existing) return null;

  // A row still reads status='active' in storage until something sweeps
  // it (see sweepExpiredHolds) -- so re-derive the true status here rather
  // than trust the stale column, or a lapsed hold would report "hold is
  // 'active' and cannot be lifted", which is both false and a worse error
  // than naming the real, unfixable state.
  const effectiveStatus = existing.status === 'active' && existing.expires_at && new Date(existing.expires_at) <= new Date()
    ? 'expired'
    : existing.status;
  throw new Error(`Unsupported transition: hold is '${effectiveStatus}' and cannot be lifted`);
}

/**
 * The athlete's current active hold, or null. Expiry is enforced in the
 * predicate at read time (like coverage grants: a lapsed hold needs no
 * cron to stop mattering); rows whose clock ran out simply stop matching.
 */
/**
 * The athlete's current active hold, or null. Missing-table (42P01,
 * pre-migration window) reads as "no hold": every reader of this
 * function -- including the athlete workspace banner, fired on every
 * page load -- must degrade gracefully, not 500.
 */
export async function getActiveTrainingHold(
  organizationId: string,
  athleteId: string,
): Promise<TrainingHoldRow | null> {
  try {
    await sweepExpiredHolds(organizationId, athleteId, undefined);
    return await queryOne<TrainingHoldRow>(
      `select ${HOLD_COLUMNS}
       from pilot.training_holds
       where organization_id = $1 and athlete_id = $2 and status = 'active'
         and (expires_at is null or expires_at > now())
       limit 1`,
      [organizationId, athleteId],
    );
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
    return null;
  }
}

export async function getTrainingHoldById(
  organizationId: string,
  holdId: string,
): Promise<TrainingHoldRow | null> {
  try {
    return await queryOne<TrainingHoldRow>(
      `select ${HOLD_COLUMNS}
       from pilot.training_holds
       where organization_id = $1 and hold_id = $2`,
      [organizationId, holdId],
    );
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
    return null;
  }
}

/**
 * Org-wide (or per-athlete) list for staff. Sweeps lapsed holds to
 * 'expired' first -- this is the surface a coach or admin reads to answer
 * "is this child protected right now", so it is the one read that cannot
 * settle for a read-time-only predicate: without the sweep it would show
 * an expired hold as 'active' while the athlete can in fact register.
 */
export async function listTrainingHolds(
  organizationId: string,
  filters: { athleteId?: string; status?: TrainingHoldStatus } = {},
): Promise<TrainingHoldRow[]> {
  try {
    await sweepExpiredHolds(organizationId, filters.athleteId, undefined);
    return await query<TrainingHoldRow>(
      `select ${HOLD_COLUMNS}
       from pilot.training_holds
       where organization_id = $1
         and ($2::text is null or athlete_id = $2)
         and ($3::text is null or status = $3)
       order by placed_at desc`,
      [organizationId, filters.athleteId ?? null, filters.status ?? null],
    );
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
    return [];
  }
}

/**
 * The enforcement read: does an active hold stop this activity?
 *
 * 'registration' is stopped only by an 'all_training' hold -- classes are
 * untyped in the scheduler, so a scoped hold cannot know whether a class
 * involves contact; the scoped rungs enforce at the contact surface
 * (contactClearanceGate) and inform on the athlete banner instead.
 *
 * Missing-table (42P01, pre-migration window) reads as "no hold": the
 * registration path must degrade to its pre-#82 behavior, not 500.
 */
export async function findRegistrationBlockingHold(
  organizationId: string,
  athleteId: string,
  client?: PoolClient,
): Promise<Pick<TrainingHoldRow, 'hold_id' | 'athlete_explanation' | 'lift_condition_text'> | null> {
  const sql = `select hold_id, athlete_explanation, lift_condition_text
     from pilot.training_holds
     where organization_id = $1 and athlete_id = $2
       and status = 'active' and scope = 'all_training'
       and (expires_at is null or expires_at > now())
     limit 1`;
  const params = [organizationId, athleteId];

  if (client) {
    // Called from inside registerForClassTransactionally's own
    // transaction -- a bare 42P01 here would leave that transaction
    // ABORTED (Postgres 25P02) for every statement after it, so the
    // caller's very next query (the already-registered check) would fail
    // too, turning "table not migrated yet" into "every class
    // registration 500s, held athlete or not". A SAVEPOINT scopes the
    // failure to just this probe: on 42P01 we roll back to it and the
    // enclosing transaction carries on as if the probe had returned no
    // hold, which is exactly the degraded behavior this guard promises.
    await client.query('SAVEPOINT training_hold_probe');
    try {
      const result = await client.query(sql, params);
      await client.query('RELEASE SAVEPOINT training_hold_probe');
      return (result.rows[0] as Pick<TrainingHoldRow, 'hold_id' | 'athlete_explanation' | 'lift_condition_text'>) ?? null;
    } catch (error) {
      if ((error as { code?: unknown }).code !== '42P01') {
        throw error;
      }
      await client.query('ROLLBACK TO SAVEPOINT training_hold_probe');
      return null;
    }
  }

  try {
    return await queryOne(sql, params);
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42P01') {
      throw error;
    }
    return null;
  }
}

/**
 * The other enforcement read: does an active hold stop this CONTACT EVENT?
 *
 * findRegistrationBlockingHold above deliberately narrows to 'all_training',
 * and its own comment says why: scheduler classes are untyped, so a scoped
 * hold cannot know whether a given class involves contact, and the scoped
 * rungs enforce at the contact surface instead. A wrestling match and an
 * external competition carry no such ambiguity -- they are contact and
 * maximal exertion by definition -- so the REGRESS rung ('contact_only',
 * training continues at reduced intensity) has to stop them too, or "no
 * contact for now" would mean no sparring on the gym floor and a match on
 * Saturday.
 *
 * The scope set here is exactly the one flagContactDuringHold below already
 * treats as "a hold covering contact". The two must not drift; if a fourth
 * scope is ever added, both belong in the same edit.
 *
 * Returns the athlete's own words alongside the hold, so the caller's refusal
 * is the sentence written FOR the athlete plus the lift condition -- the same
 * shape the registration STOP already surfaces, rather than a bare "no".
 *
 * Expiry is enforced in the predicate at read time, like
 * findRegistrationBlockingHold: a lapsed hold stops matching without needing
 * a sweep, and this is an enforcement probe, not the staff list that has to
 * reconcile the stored status column.
 *
 * Missing-table (42P01, pre-migration window) reads as "no hold", the same
 * degradation every other read in this module promises. That is a fail-OPEN on
 * one narrow condition, and it is deliberate: it keeps one contract for what a
 * pre-migration database means rather than inventing a second, stricter one
 * for competitions, and a gym whose training_holds relation does not exist yet
 * has no holds to honour. The competition gate that calls this
 * (`competitionSafetyGates.ts`) states the same limit so nobody has to infer
 * it.
 */
export async function findContactEventBlockingHold(
  organizationId: string,
  athleteId: string,
): Promise<Pick<TrainingHoldRow, 'hold_id' | 'scope' | 'athlete_explanation' | 'lift_condition_text'> | null> {
  try {
    return await queryOne<Pick<TrainingHoldRow, 'hold_id' | 'scope' | 'athlete_explanation' | 'lift_condition_text'>>(
      `select hold_id, scope, athlete_explanation, lift_condition_text
       from pilot.training_holds
       where organization_id = $1 and athlete_id = $2
         and status = 'active'
         and scope in ('all_training', 'contact_only')
         and (expires_at is null or expires_at > now())
       limit 1`,
      [organizationId, athleteId],
    );
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
    return null;
  }
}

const HOLD_CONTACT_TRIGGER = 'contact_observation_during_training_hold';

export interface HoldContactOutcome {
  flagged: boolean;
  holdId?: string;
  scope?: TrainingHoldScope;
}

/**
 * The REGRESS rung's contact-surface enforcement: contact logged while a
 * hold covering contact is active raises a near miss (which auto-escalates
 * at 'high'). A FLAG, never a block -- refusing the write would destroy the
 * only record the contact occurred and teach whoever is logging to leave
 * the fields blank (contactClearanceGate's under-reporting doctrine applies
 * verbatim). One near miss per session via the same trigger+context dedup.
 *
 * 42P01 (pre-migration window) reads as "no hold": post-action flagging
 * degrades to pre-#82 behavior, never a 500 on the observation path.
 */
export async function flagContactDuringHold(input: {
  organizationId: string;
  athleteId: string;
  kind: string;
  value: number | null;
  actorAccountId: string;
  actorRole: string;
  contextId: string;
  observedAt: string;
}): Promise<HoldContactOutcome> {
  if (!isContactObservation(input.kind, input.value)) {
    return { flagged: false };
  }

  let hold: Pick<TrainingHoldRow, 'hold_id' | 'scope'> | null = null;
  try {
    hold = await queryOne<Pick<TrainingHoldRow, 'hold_id' | 'scope'>>(
      `select hold_id, scope
       from pilot.training_holds
       where organization_id = $1 and athlete_id = $2
         and status = 'active'
         and scope in ('all_training', 'contact_only')
         and (expires_at is null or expires_at > now())
       limit 1`,
      [input.organizationId, input.athleteId],
    );
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42P01') {
      throw error;
    }
    return { flagged: false };
  }

  if (!hold) {
    return { flagged: false };
  }

  const alreadyFlagged = await findNearMissByTriggerContext(
    input.organizationId,
    input.athleteId,
    HOLD_CONTACT_TRIGGER,
    input.contextId,
  );

  if (!alreadyFlagged) {
    await flagNearMiss({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
      description:
        `Contact (${input.kind}) was logged for athlete ${input.athleteId} while a training hold covering `
        + `contact is active (scope: ${hold.scope}). The record is kept -- refusing it would only hide the `
        + 'contact -- but a person must look at why a held athlete took contact.',
      severity: 'high',
      detectedBy: 'system',
      detectedByAccountId: input.actorAccountId,
      detectedByRole: input.actorRole,
      metadata: {
        trigger: HOLD_CONTACT_TRIGGER,
        observation_kind: input.kind,
        observation_value: input.value,
        hold_id: hold.hold_id,
        hold_scope: hold.scope,
        context_id: input.contextId,
        observed_at: input.observedAt,
      },
    });
  }

  return { flagged: true, holdId: hold.hold_id, scope: hold.scope };
}
