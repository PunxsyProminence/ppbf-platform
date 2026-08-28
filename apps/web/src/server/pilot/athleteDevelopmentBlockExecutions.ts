import { randomUUID } from 'node:crypto';

import type { ActorIdentity } from './access';
import {
  getDevelopmentBlock,
  hasBlockWriteMembership,
  type AthleteDevelopmentBlockRow,
} from './athleteDevelopmentBlocks';
import {
  resolveDevelopmentBlockTarget,
  type ResolvedDevelopmentBlockTarget,
} from './athleteDevelopmentBlockTargets';
import { queryOne } from './db';
import { ForbiddenError, ValidationError } from './errors';

// Plan versus actual (module 036, slice 3): what a coach concluded about how
// a development block actually went, and the real rows that sit under that
// conclusion.
//
// THE ONE RULE THIS MODULE EXISTS TO HOLD. The judgment is STORED because it
// is a fact about what a person decided. Every count is COMPUTED AT READ TIME
// and never stored, because counts are derived from rows that keep changing:
// a session logged three days late, a corrected attempt, a retracted
// assessment. A stored count stops matching its own sources the moment one of
// them moves, and a count that disagrees with the rows beneath it -- on a
// record about a child -- is worse than no count at all.
//
// So `recordBlockExecution` writes words and a verdict, and nothing else.
// `getBlockPlanVsActual` runs the arithmetic fresh every time and returns it
// beside the judgment WITHOUT combining the two. Owner decision D5,
// 2026-08-28, restated here because this is the module that would break it:
// no count may be combined into a single figure, percentage, grade or index,
// and no cross-athlete comparison, cohort average or "on plan" leaderboard
// may exist at any tier. There is no function here that returns one.
//
// NOTHING HERE INFERS A VERDICT FROM THE COUNTS. That inference is the entire
// thing this capability refuses. A block whose window closed with zero logged
// activity is 'unknown' until a human says otherwise -- it is NOT
// 'not_delivered', because the schema cannot tell "the athlete did not attend"
// from "attendance was not logged". Neither writes a row.
//
// PARTICIPATION IS READ FROM pilot.attendance_reconciled, NOT FROM A RAW
// TABLE. That view is the CT-13 system of record: exactly one row per
// athlete-day, three sources resolved by precedence and never summed. This
// module first read pilot.activity_log directly and summed its minutes;
// attendancePrecedence.test.ts refused that, correctly, because an athlete in
// two classes on one day has several raw rows and counting them turns one
// training day into three. A doubled participation figure about a child is
// the defect that view exists to prevent, and this surface is not going to be
// the place it comes back.
//
// ACCESS AND TENANCY ARRIVE THROUGH THE BLOCK, for the third time in this
// capability. An execution carries no athlete_id; it reaches its athlete via
// its parent by composite FK. Every read here resolves that parent through
// getDevelopmentBlock, so an execution is reachable by exactly the people who
// can reach its block -- and every write additionally stands on the same
// hasBlockWriteMembership gate the block itself uses (owner decision D2(a):
// coach, organization_admin, admin). No new role taxonomy is invented.

/**
 * pilot.intervention_executions' vocabulary, copied verbatim rather than
 * paraphrased.
 *
 * Two tables describing "how far did the plan survive contact with reality"
 * in two different languages would be two things for a reader to reconcile,
 * and the reconciliation would be guesswork. Module 036 says to reuse this
 * rather than invent a parallel vocabulary, and it is right.
 */
export const BLOCK_ADHERENCE_STATES = [
  'delivered_as_planned',
  'delivered_with_deviations',
  'under_delivered',
  'not_delivered',
  'unknown',
] as const;

export type BlockAdherence = (typeof BLOCK_ADHERENCE_STATES)[number];

export interface BlockExecutionRow {
  organization_id: string;
  execution_id: string;
  block_id: string;
  adherence: BlockAdherence;
  deviations: string;
  deviation_reason: string;
  recorded_by_account_id: string;
  recorded_at: string;
  created_at: string;
  updated_at: string;
}

const FIELDS = `organization_id, execution_id, block_id, adherence, deviations,
  deviation_reason, recorded_by_account_id, recorded_at::text as recorded_at,
  created_at::text as created_at, updated_at::text as updated_at`;

export interface BlockExecutionInput {
  adherence: BlockAdherence;
  deviations?: string;
  deviationReason?: string;
}

export function blockExecutionShapeError(input: BlockExecutionInput): string | null {
  if (!(BLOCK_ADHERENCE_STATES as readonly string[]).includes(input.adherence)) {
    return `Unknown adherence state '${input.adherence}'.`;
  }
  /* Claimed deviations must be named. Checked here AND by
     pilot_adb_executions_deviations_check, both deliberately: the constraint
     is the thing that cannot be bypassed, and this is the thing that gives a
     coach a sentence instead of SQLSTATE 23514. Same division of labour as
     createRecognition and the parent block's own validator. */
  if (input.adherence === 'delivered_with_deviations' && !input.deviations?.trim()) {
    return 'Saying a block was delivered with deviations means saying what they were.';
  }
  return null;
}

/**
 * Records -- or corrects -- the one judgment a block carries.
 *
 * ONE ROW PER BLOCK (owner decision D1(a), 2026-08-28), enforced by a unique
 * constraint and expressed here as an upsert rather than a second insert. A
 * coach who changes their mind CORRECTS the verdict; two live verdicts on one
 * block is a discrepancy someone would want resolved by arithmetic, which is
 * the thing this capability refuses.
 *
 * The cost of D1(a) is real and was named when the decision was made: a block
 * that went well technically and badly on conditioning gets one word for both,
 * and the objectives carry no outcome of their own. The alternative -- one
 * judgment per objective -- is the kind of friction that gets skipped, and a
 * skipped judgment defaults to 'unknown', which would turn an honest default
 * into an empty screen.
 *
 * Returns null for a block this actor cannot open, which answers the same way
 * as a block id that does not exist. Throws ForbiddenError when the actor
 * holds no active membership in a writing role -- checked FIRST, so a caller
 * with no standing here learns nothing about the roster.
 */
export async function recordBlockExecution(input: BlockExecutionInput & {
  actor: ActorIdentity;
  blockId: string;
}): Promise<BlockExecutionRow | null> {
  const shapeError = blockExecutionShapeError(input);
  if (shapeError) {
    throw new ValidationError(shapeError, 'BLOCK_EXECUTION_INVALID');
  }

  // The SAME check the parent block uses, imported rather than restated.
  // Recording how a block went is a coach's judgment about an athlete, and it
  // is now readable by that athlete and their guardian; it stays a coach's
  // write for exactly that reason.
  if (!(await hasBlockWriteMembership(input.actor.accountId, input.actor.organizationId))) {
    throw new ForbiddenError(
      'This account may not record development block outcomes in this organization.',
      'BLOCK_EXECUTION_WRITER_NOT_PERMITTED',
    );
  }

  // One definition of "is this block mine", reused rather than re-queried.
  const block = await getDevelopmentBlock(input.actor, input.blockId);
  if (!block) return null;

  /* A VERDICT ON A BLOCK THAT IS STILL RUNNING IS A PREDICTION, NOT A RECORD.
     This module said so in its header and then let one be written anyway --
     and because getBlockExecution returns the row without the window state
     beside it, a later reader could not tell the two apart. Codex caught it
     on #829.
     
     TERMINAL STATUS IS THE ESCAPE HATCH, and it is not a loophole. A block a
     coach has marked 'completed' or 'cancelled' is over whatever its dates
     say -- a cancelled block's ends_on is routinely still in the future, and
     refusing to record "not_delivered" on it would be refusing the truest
     verdict this table can hold.
     
     Compared in the database's clock, not the node process's, so a block does
     not close an hour early for a server in another timezone.
     
     NOTE FOR THE #804 RECONCILIATION: this refusal is a consequence of D1(a),
     where the single row IS the historical verdict. #804's many-row model
     deliberately allows a mid-block entry, because there an entry is an
     interim review rather than the record. If that model wins, this gate goes
     with the table -- it is not a rule about coaching, it is a rule about
     what one mutable row can honestly mean. */
  const TERMINAL_STATUSES: readonly string[] = ['completed', 'cancelled'];
  if (!TERMINAL_STATUSES.includes(block.status)) {
    const window = await queryOne<{ closed: boolean }>(
      `select ($1::date < current_date) as closed`,
      [block.ends_on],
    );
    if (window?.closed !== true) {
      throw new ValidationError(
        'This block has not finished yet. Record how it went once its window '
        + 'closes, or mark the block completed or cancelled first.',
        'BLOCK_EXECUTION_WINDOW_OPEN',
      );
    }
  }

  /* recorded_by_account_id and recorded_at are re-stamped on a correction:
     the row records WHO CONCLUDED THIS, and after a correction that is the
     person who corrected it. A row naming the original author beside somebody
     else's words would attribute a judgment to someone who did not make it. */
  return queryOne<BlockExecutionRow>(
    `insert into pilot.athlete_development_block_executions
       (organization_id, execution_id, block_id, adherence, deviations,
        deviation_reason, recorded_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, block_id) do update
       set adherence = excluded.adherence,
           deviations = excluded.deviations,
           deviation_reason = excluded.deviation_reason,
           recorded_by_account_id = excluded.recorded_by_account_id,
           recorded_at = now(),
           updated_at = now()
     returning ${FIELDS}`,
    [
      input.actor.organizationId,
      randomUUID(),
      input.blockId,
      input.adherence,
      input.deviations?.trim() ?? '',
      input.deviationReason?.trim() ?? '',
      input.actor.accountId,
    ],
  );
}

/**
 * The judgment a block carries, or null when no human has recorded one.
 *
 * NULL IS NOT 'not_delivered' AND IT IS NOT A FAILURE. It is the second of the
 * six UNKNOWN states: the block exists and nobody has judged it yet. Callers
 * must keep it distinct from a stored 'unknown', which is a human having
 * looked and said so.
 *
 * Null also for a block in another organization and for one this actor cannot
 * open -- all three answer identically, which is the point.
 */
export async function getBlockExecution(
  actor: ActorIdentity,
  blockId: string,
): Promise<BlockExecutionRow | null> {
  if (!(await getDevelopmentBlock(actor, blockId))) return null;
  return queryOne<BlockExecutionRow>(
    `select ${FIELDS} from pilot.athlete_development_block_executions
     where organization_id = $1 and block_id = $2`,
    [actor.organizationId, blockId],
  );
}

/**
 * The counts that sit under a judgment, computed now and stored nowhere.
 *
 * Every field is a plain tally of rows in the block's own date window. None of
 * them is combined with another, weighted, or turned into a proportion, and
 * there is deliberately no `total` -- a single figure is what D5 refuses.
 */
export interface BlockWindowCounts {
  /** pilot.training_attempts with attempted_at inside the window. */
  training_attempts: number;
  /**
   * Athlete-DAYS marked present in the window, read from
   * pilot.attendance_reconciled -- the CT-13 system of record.
   *
   * NOT a count of pilot.activity_log rows, and the difference is the whole
   * reason CT-13 exists. An athlete in two classes on one day has two
   * scheduler rows and can have several activity_log rows; counting those
   * raw turns one training day into two or three, and a participation figure
   * about a child that is quietly doubled is exactly the defect that view was
   * built to prevent. The view resolves the three sources by precedence and
   * yields exactly one row per athlete-day, so this counts days.
   *
   * The first version of this module read pilot.activity_log directly and
   * summed duration_minutes. attendancePrecedence.test.ts refused it, and it
   * was right to: minutes are a second grain that only the raw table can
   * express, so reporting them beside a day count would reintroduce the
   * two-sources problem in a new place. Days are the platform's one answer
   * to "did they turn up", and this surface asks nothing else.
   */
  training_days_present: number;
  /** pilot.assessments with administered_on inside the window. */
  assessments_administered: number;
  /**
   * DRIFT 1, kept as its own number rather than folded into either neighbour.
   *
   * assessments.administered_on is NULLABLE -- the assessment-protocols
   * migration indexes rows where it is null as the not-yet-administered case.
   * So an assessment can exist, belong to this athlete, and have no date to
   * place it in a window with. That is neither "none in this window" nor
   * evidence the window contains, and collapsing it into either would make
   * this surface lie in a small, plausible way.
   *
   * SCOPED BY due_on, WHICH THE FIRST VERSION DID NOT DO. It carried no date
   * predicate at all, so every block for this athlete reported the same
   * number, an assessment due next month counted against a block that closed
   * last year, and the figure moved whenever unrelated work was scheduled. A
   * per-athlete total wearing a per-block label. Codex caught it on #829.
   *
   * A row with BOTH dates null is excluded rather than counted here: it
   * cannot be placed in any window, so attributing it to this one would be
   * the same defect in a smaller costume.
   */
  assessments_without_administered_date: number;
}

export interface BlockPlanVsActual {
  block: AthleteDevelopmentBlockRow;
  /** Null when no human has recorded a judgment. Not the same as 'unknown'. */
  execution: BlockExecutionRow | null;
  /**
   * UNKNOWN state six. Module 036's own prerequisite says a block has nothing
   * honest to show until its window has closed: an adherence judgment on a
   * block that is still running is a prediction, not a record. The surface
   * says so rather than showing partial counts that read as a
   * verdict-in-progress.
   */
  window_has_closed: boolean;
  counts: BlockWindowCounts;
  /**
   * UNKNOWN state three. False when the window closed with no source row of
   * any kind. Distinct from 'not_delivered', because the schema cannot tell
   * "the athlete did not attend" from "attendance was not logged" -- neither
   * writes a row.
   */
  has_recorded_activity: boolean;
  /**
   * UNKNOWN state four: the target the block was preparing for, with its
   * status, so a cancelled competition can never read as still live. Null
   * when the block names no target.
   */
  target: ResolvedDevelopmentBlockTarget | null;
}

/**
 * A block, its judgment, and the real rows in its window -- side by side and
 * never merged.
 *
 * Returns null for a block this actor cannot open (UNKNOWN state one is the
 * caller's: "no block recorded for this period" is a different sentence from
 * "not yours", and only the caller knows which question was asked).
 *
 * READ-ONLY AND athlete-SCOPED by the same chokepoint as everything else in
 * this capability. The counts are scoped to the block's own athlete and
 * organization and to its own [starts_on, ends_on] window, inclusive at both
 * ends because a coach who wrote those dates meant the days they name.
 */
export async function getBlockPlanVsActual(
  actor: ActorIdentity,
  blockId: string,
): Promise<BlockPlanVsActual | null> {
  const block = await getDevelopmentBlock(actor, blockId);
  if (!block) return null;

  /* One round trip for four independent tallies. Each subquery is scoped to
     the block's athlete AND organization -- the composite key everywhere else
     in this capability uses -- so a block cannot count another gym's rows even
     if an athlete id were somehow shared. */
  const counts = await queryOne<{
    training_attempts: string;
    training_days_present: string;
    assessments_administered: string;
    assessments_without_administered_date: string;
  }>(
    `select
       (select count(*) from pilot.training_attempts ta
         where ta.organization_id = $1 and ta.athlete_id = $2
           and ta.attempted_at::date between $3::date and $4::date)
         as training_attempts,
       (select count(*) from pilot.attendance_reconciled ar
         where ar.organization_id = $1 and ar.athlete_id = $2
           and ar.attendance_date between $3::date and $4::date
           and ar.status = 'present')
         as training_days_present,
       (select count(*) from pilot.assessments a
         where a.organization_id = $1 and a.athlete_id = $2
           and a.administered_on between $3::date and $4::date)
         as assessments_administered,
       (select count(*) from pilot.assessments a
         where a.organization_id = $1 and a.athlete_id = $2
           and a.administered_on is null
           and a.due_on between $3::date and $4::date)
         as assessments_without_administered_date`,
    [block.organization_id, block.athlete_id, block.starts_on, block.ends_on],
  );

  const tally: BlockWindowCounts = {
    training_attempts: Number(counts?.training_attempts ?? 0),
    training_days_present: Number(counts?.training_days_present ?? 0),
    assessments_administered: Number(counts?.assessments_administered ?? 0),
    assessments_without_administered_date:
      Number(counts?.assessments_without_administered_date ?? 0),
  };

  /* Compared as dates, in the database's own clock rather than the node
     process's, so a block does not close an hour early for a server in
     another timezone. */
  const closed = await queryOne<{ closed: boolean }>(
    `select ($1::date < current_date) as closed`,
    [block.ends_on],
  );

  return {
    block,
    execution: await getBlockExecution(actor, blockId),
    window_has_closed: closed?.closed === true,
    counts: tally,
    /* Deliberately NOT a sum. It answers "is there anything at all under this
       window", which is a different question from "how much", and the
       assessments with no date are excluded because they are not evidence the
       window contains. */
    has_recorded_activity:
      tally.training_attempts > 0
      || tally.training_days_present > 0
      || tally.assessments_administered > 0,
    target: await resolveDevelopmentBlockTarget(actor.organizationId, block),
  };
}
