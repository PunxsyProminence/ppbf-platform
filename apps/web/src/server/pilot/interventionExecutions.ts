import { randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';
import { getProtocol } from './interventionProtocols';
import { recordChanged } from './interventionRecordChanged';

export { RECORD_CHANGED_CODE, RECORD_CHANGED_MESSAGE, recordChanged } from './interventionRecordChanged';

// Intervention executions (register module 026 slice 2) -- what ACTUALLY
// happened when a protocol was run. A human decision is not evidence an
// intervention was executed; a decision can exist with zero executions,
// and one protocol/decision can span many. The planned_* columns are a
// snapshot taken at start time and no function here ever writes them
// again -- deviations are recorded beside the plan, never painted over it.
//
// Adherence is an explicit state (never a fake percentage) because
// "intervention looked ineffective" and "intervention was never really
// delivered" must stay distinguishable forever. Corrections are
// supersession with a stated reason -- history is never rewritten.

export const ADHERENCE_STATES = [
  'delivered_as_planned', 'delivered_with_deviations',
  'under_delivered', 'not_delivered', 'unknown',
] as const;

export const TRAINED_CONTEXTS = ['unknown', 'controlled', 'constrained_live', 'live'] as const;

export type AdherenceState = (typeof ADHERENCE_STATES)[number];
export type TrainedContext = (typeof TRAINED_CONTEXTS)[number];
export type ExecutionStatus = 'in_progress' | 'completed' | 'stopped' | 'superseded';

/** Returns the reason an adherence value is refused, or null. Absence is
 * legal -- it stays 'unknown', which is the honest default. */
export function adherenceError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(ADHERENCE_STATES as readonly string[]).includes(value)) {
    return `adherence must be one of: ${ADHERENCE_STATES.join(', ')}.`;
  }
  return null;
}

/** Returns the reason a trained-context value is refused, or null. Context
 * is a small factual vocabulary -- there is no difficulty score. */
export function trainedContextError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(TRAINED_CONTEXTS as readonly string[]).includes(value)) {
    return `trained_context must be one of: ${TRAINED_CONTEXTS.join(', ')}.`;
  }
  return null;
}

export interface InterventionExecutionRow {
  organization_id: string;
  execution_id: string;
  lineage_id: string;
  version: number;
  supersedes_execution_id: string | null;
  athlete_id: string;
  athlete_name: string | null;
  decision_id: string | null;
  protocol_id: string;
  protocol_version: number;
  protocol_title: string | null;
  session_run_id: string | null;
  recorded_by_account_id: string;
  planned_start: string | null;
  actual_start: string | null;
  actual_end: string | null;
  status: ExecutionStatus;
  planned_exposure: Record<string, number>;
  planned_task_context: string;
  actual_exposure: Record<string, number>;
  trained_context: TrainedContext;
  task_constraint: string;
  partner_context: string;
  adherence: AdherenceState;
  deviations: string;
  deviation_reason: string;
  stop_change_reason: string;
  notes: string;
  correction_reason: string;
  created_at: string;
  /** The row's version, opaque to the caller: a screen hands back the one it
   * loaded with its save (expectedRowVersion below), and a save against any
   * other version is refused. It is Postgres's xmin -- see ROW_VERSION_SQL. */
  row_version: string;
}

const FIELDS = `e.organization_id, e.execution_id, e.lineage_id, e.version,
  e.supersedes_execution_id, e.athlete_id, a.full_name as athlete_name,
  e.decision_id, e.protocol_id, e.protocol_version, p.title as protocol_title,
  e.session_run_id, e.recorded_by_account_id,
  e.planned_start, e.actual_start, e.actual_end, e.status,
  e.planned_exposure, e.planned_task_context, e.actual_exposure,
  e.trained_context, e.task_constraint, e.partner_context, e.adherence,
  e.deviations, e.deviation_reason, e.stop_change_reason, e.notes,
  e.correction_reason, e.created_at, e.xmin::text as row_version`;

const FROM = `from pilot.intervention_executions e
  left join pilot.athletes a
    on a.organization_id = e.organization_id and a.athlete_id = e.athlete_id
  left join pilot.intervention_protocols p
    on p.organization_id = e.organization_id and p.protocol_id = e.protocol_id`;

/** The version of the record the caller's screen was showing when its form
 * was opened. Given, the write goes through only against that version; left
 * out (a caller with no screen), the write is judged on the record's state
 * alone, as before. */
export interface ExpectedVersion {
  expectedRowVersion?: string;
}

export interface ExecutionFactsInput {
  actualExposure?: Record<string, number>;
  trainedContext?: TrainedContext;
  taskConstraint?: string;
  partnerContext?: string;
  adherence?: AdherenceState;
  deviations?: string;
  deviationReason?: string;
  notes?: string;
  actualStart?: string;
}

/** Starts an execution against an ACTIVE protocol head, snapshotting the
 * protocol's intended exposure and task context as the plan. The decision
 * link, when given, must belong to the same org AND athlete -- anything
 * else is a hidden not-found, indistinguishable from nonexistence. */
export async function startExecution(input: {
  organizationId: string;
  athleteId: string;
  protocolId: string;
  decisionId?: string | null;
  sessionRunId?: string | null;
  plannedStart?: string | null;
  actualStart?: string | null;
  recordedByAccountId: string;
}): Promise<InterventionExecutionRow | null> {
  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  const protocol = await getProtocol(input.organizationId, input.protocolId);
  if (!protocol || protocol.status !== 'active') return null;
  // A protocol designed for one athlete never silently applies to another.
  if (protocol.athlete_id && protocol.athlete_id !== input.athleteId) return null;

  if (input.decisionId) {
    const decision = await queryOne<{ decision_id: string }>(
      `select decision_id from pilot.shadow_decisions
       where decision_id = $1 and organization_id = $2 and athlete_id = $3`,
      [input.decisionId, input.organizationId, input.athleteId],
    );
    if (!decision) return null;
  }

  const executionId = randomUUID();
  await queryOne(
    `insert into pilot.intervention_executions
       (organization_id, execution_id, lineage_id, version, athlete_id, decision_id,
        protocol_id, protocol_version, session_run_id, recorded_by_account_id,
        planned_start, actual_start, planned_exposure, planned_task_context)
     values ($1, $2, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     returning execution_id`,
    [
      input.organizationId,
      executionId,
      input.athleteId,
      input.decisionId ?? null,
      input.protocolId,
      protocol.version,
      input.sessionRunId ?? null,
      input.recordedByAccountId,
      input.plannedStart ?? null,
      input.actualStart ?? null,
      JSON.stringify(protocol.intended_exposure ?? {}),
      protocol.intended_task_context ?? '',
    ],
  );

  return getExecution(input.organizationId, executionId);
}

export async function getExecution(organizationId: string, executionId: string): Promise<InterventionExecutionRow | null> {
  return queryOne<InterventionExecutionRow>(
    `select ${FIELDS} ${FROM}
     where e.organization_id = $1 and e.execution_id = $2`,
    [organizationId, executionId],
  );
}

/** Current records only (superseded corrections are history), newest
 * first; optionally narrowed to one athlete. */
export async function listExecutions(organizationId: string, athleteId?: string): Promise<InterventionExecutionRow[]> {
  if (athleteId) {
    return query<InterventionExecutionRow>(
      `select ${FIELDS} ${FROM}
       where e.organization_id = $1 and e.athlete_id = $2 and e.status <> 'superseded'
       order by e.created_at desc`,
      [organizationId, athleteId],
    );
  }
  return query<InterventionExecutionRow>(
    `select ${FIELDS} ${FROM}
     where e.organization_id = $1 and e.status <> 'superseded'
     order by e.created_at desc`,
    [organizationId],
  );
}

// The ACTUAL facts a record or a close-out may state. The planned_* columns
// are deliberately absent -- the plan is a snapshot, and deviating from it
// never edits it. Parameters $3..$11, in factsParams order.
const FACTS_SET = `actual_exposure = coalesce($3::jsonb, actual_exposure),
       trained_context = coalesce($4, trained_context),
       task_constraint = coalesce($5, task_constraint),
       partner_context = coalesce($6, partner_context),
       adherence = coalesce($7, adherence),
       deviations = coalesce($8, deviations),
       deviation_reason = coalesce($9, deviation_reason),
       notes = coalesce($10, notes),
       actual_start = coalesce($11, actual_start),
       updated_at = now()`;

function factsParams(input: ExecutionFactsInput & { organizationId: string; executionId: string }): unknown[] {
  return [
    input.organizationId,
    input.executionId,
    input.actualExposure === undefined ? null : JSON.stringify(input.actualExposure),
    input.trainedContext ?? null,
    input.taskConstraint ?? null,
    input.partnerContext ?? null,
    input.adherence ?? null,
    input.deviations ?? null,
    input.deviationReason ?? null,
    input.notes ?? null,
    input.actualStart ?? null,
  ];
}

/** Why a write to work in progress matched no row. No such record is the null
 * the routes hide as not-found. A record that IS there was closed or corrected
 * first, or is not the version the caller's screen was showing, and the coach
 * is told so instead of "Not found". Read after the refused write only to
 * choose between those two answers. */
async function notInProgress(organizationId: string, executionId: string): Promise<null> {
  const standing = await queryOne<{ status: ExecutionStatus }>(
    `select status from pilot.intervention_executions
     where organization_id = $1 and execution_id = $2`,
    [organizationId, executionId],
  );
  if (!standing) return null;
  throw recordChanged();
}

/** Updates ACTUAL facts on an in-progress execution. */
export async function recordExecutionFacts(input: ExecutionFactsInput & ExpectedVersion & {
  organizationId: string;
  executionId: string;
}): Promise<InterventionExecutionRow | null> {
  const row = await queryOne<{ execution_id: string }>(
    `update pilot.intervention_executions set
       ${FACTS_SET}
     where organization_id = $1 and execution_id = $2 and status = 'in_progress'
       and ($12::text is null or xmin::text = $12)
     returning execution_id`,
    [...factsParams(input), input.expectedRowVersion ?? null],
  );
  if (!row) return notInProgress(input.organizationId, input.executionId);
  return getExecution(input.organizationId, input.executionId);
}

/** Closes an in-progress execution as completed or stopped. A stop
 * requires its reason (also a database constraint). Final facts may be
 * recorded in the same act.
 *
 * ONE STATEMENT. The facts and the status used to be two UPDATEs, each
 * guarded on 'in_progress', so a correction landing between them kept the
 * close-out's facts and refused its status: half a write. One UPDATE either
 * closes the record with its facts or changes nothing. */
export async function closeExecution(input: ExecutionFactsInput & ExpectedVersion & {
  organizationId: string;
  executionId: string;
  outcome: 'completed' | 'stopped';
  stopChangeReason?: string;
  actualEnd?: string | null;
}): Promise<InterventionExecutionRow | null> {
  const row = await queryOne<{ execution_id: string }>(
    `update pilot.intervention_executions set
       ${FACTS_SET},
       status = $12,
       stop_change_reason = coalesce($13, stop_change_reason),
       actual_end = coalesce($14, actual_end, now())
     where organization_id = $1 and execution_id = $2 and status = 'in_progress'
       and ($15::text is null or xmin::text = $15)
     returning execution_id`,
    [
      ...factsParams(input),
      input.outcome,
      input.stopChangeReason ?? null,
      input.actualEnd ?? null,
      input.expectedRowVersion ?? null,
    ],
  );
  if (!row) return notInProgress(input.organizationId, input.executionId);
  return getExecution(input.organizationId, input.executionId);
}

/** The record's status and its Postgres row version. xmin names the
 * transaction that wrote the row as it stands, so it differs after ANY
 * committed write to the row, whichever columns that write touched and
 * whatever the clock said -- which a timestamp comparison cannot promise. */
const ROW_VERSION_SQL = `select status, xmin::text as row_version
  from pilot.intervention_executions
  where organization_id = $1 and execution_id = $2`;

interface ExecutionRowVersion {
  status: ExecutionStatus;
  row_version: string;
}

/** Correction is supersession: a NEW version row with a stated reason; the
 * original keeps its values forever and is stamped superseded. Actual
 * facts are re-stated; identity, links, and the planned snapshot are
 * carried from the original untouched, and the evidence links and outcome
 * reviews attached to the original move to the new version with it. */
export async function correctExecution(input: ExecutionFactsInput & ExpectedVersion & {
  organizationId: string;
  executionId: string;
  correctionReason: string;
  outcome?: 'in_progress' | 'completed' | 'stopped';
  stopChangeReason?: string;
  actualEnd?: string | null;
  correctedByAccountId: string;
}): Promise<InterventionExecutionRow | null> {
  const seen = await queryOne<ExecutionRowVersion>(ROW_VERSION_SQL, [input.organizationId, input.executionId]);
  if (!seen) return null;
  if (seen.status === 'superseded') throw recordChanged();

  const newId = randomUUID();

  // ONE TRANSACTION, AND THE FLIP CARRIES THE STATE IT READ.
  //
  // Three statements build a correction -- insert the successor born
  // 'superseded' (so the one-current-record unique index is never contended),
  // stamp the original, then give the successor the lineage's final status.
  // On autocommit the old comment's claim ("a crash between steps never
  // leaves two current records") was true and beside the point: what a
  // failure after the second statement leaves is ZERO current records. Both
  // rows read 'superseded', listExecutions filters exactly that out, and the
  // execution -- the record of what a child was actually put through --
  // disappears from every current view while its rows sit in the table.
  //
  // The same gap opens without any crash: two corrections of one execution
  // both read `current` as non-superseded, both insert, and both then flipped
  // the original because that UPDATE named no state. One raise wins the
  // unique index and the other 500s on a 23505, leaving its successor
  // stranded as a version nothing can raise or remove.
  //
  // The transaction makes the three all-or-nothing, and `and status <>
  // 'superseded'` on the stamp is the compare-and-set that settles the race
  // in the database: the loser matches zero rows and rolls its own insert
  // back.
  //
  // THE RECORD IS HELD BEFORE IT IS COPIED (lane L2; N3-02 finding R1-6).
  //
  // The stamp settled correction against correction and nothing else. A
  // close-out is a plain UPDATE of the same row: one that committed after
  // this function read the record, or between the copy below and the stamp,
  // was answered 200 and then lost -- the successor was built from the record
  // as it stood before the close and raised to the stale status, and the
  // closed original was stamped superseded, out of every current view.
  //
  // So the first statement takes the row lock, and the transaction goes on
  // only if the row is still the version this request read. From there every
  // other writer of this record waits: a close-out or a recorded fact
  // re-reads its `status = 'in_progress'` when the lock is released and
  // matches nothing; an evidence link and an outcome review take their own
  // lock on this row (interventionEvidence.ts) and find it superseded. Each
  // is told the record changed. If the row moved first, this correction is
  // the one told, and nothing of it is written.
  //
  // Lock order, for whoever adds a writer: this row first, then the athlete
  // row (the successor's foreign key). The retention purge
  // (scripts/pilot-cleanup-deleted-data.mjs) takes the athlete first and
  // cascades here; it only runs on athletes the routes no longer admit.
  const corrected = await withTransaction(async (client) => {
    const held = await client.query<ExecutionRowVersion>(
      `${ROW_VERSION_SQL} for update`,
      [input.organizationId, input.executionId],
    );
    const current = held.rows[0];
    // The version the coach's screen was showing, when it said; otherwise the
    // version this request read a moment ago.
    const expected = input.expectedRowVersion ?? seen.row_version;
    if (!current || current.row_version !== expected) throw recordChanged();
    const finalStatus = input.outcome ?? current.status;

    await client.query(
      `insert into pilot.intervention_executions
         (organization_id, execution_id, lineage_id, version, supersedes_execution_id,
          athlete_id, decision_id, protocol_id, protocol_version, session_run_id,
          recorded_by_account_id, planned_start, actual_start, actual_end, status,
          planned_exposure, planned_task_context, actual_exposure, trained_context,
          task_constraint, partner_context, adherence, deviations, deviation_reason,
          stop_change_reason, notes, correction_reason)
       select organization_id, $3, lineage_id, version + 1, execution_id,
              athlete_id, decision_id, protocol_id, protocol_version, session_run_id,
              $4, planned_start, coalesce($5, actual_start), coalesce($6, actual_end), 'superseded',
              planned_exposure, planned_task_context,
              coalesce($7::jsonb, actual_exposure), coalesce($8, trained_context),
              coalesce($9, task_constraint), coalesce($10, partner_context),
              coalesce($11, adherence), coalesce($12, deviations), coalesce($13, deviation_reason),
              coalesce($14, stop_change_reason), coalesce($15, notes), $16
       from pilot.intervention_executions
       where organization_id = $1 and execution_id = $2
       returning execution_id`,
      [
        input.organizationId,
        input.executionId,
        newId,
        input.correctedByAccountId,
        input.actualStart ?? null,
        input.actualEnd ?? null,
        input.actualExposure === undefined ? null : JSON.stringify(input.actualExposure),
        input.trainedContext ?? null,
        input.taskConstraint ?? null,
        input.partnerContext ?? null,
        input.adherence ?? null,
        input.deviations ?? null,
        input.deviationReason ?? null,
        input.stopChangeReason ?? null,
        input.notes ?? null,
        input.correctionReason,
      ],
    );

    // A backstop now: under the lock and the version check above, this stamp
    // cannot miss.
    const stamped = await client.query<{ execution_id: string }>(
      `update pilot.intervention_executions set status = 'superseded', updated_at = now()
       where organization_id = $1 and execution_id = $2 and status <> 'superseded'
       returning execution_id`,
      [input.organizationId, input.executionId],
    );
    if (stamped.rows.length === 0) throw recordChanged();

    // THE EVIDENCE AND THE REVIEW FOLLOW THE RECORD.
    //
    // Evidence links and outcome reviews are keyed on execution_id, and a
    // correction mints a new one. Left where they were, they hang off a
    // superseded row that no current read lists: the review screen shows the
    // corrected execution with no evidence and no verdict, and linkEvidence
    // refuses a superseded execution, so nothing can be re-attached either.
    // Fixing a typo would cost the coach the record of what the work showed.
    //
    // So they are re-pointed at the new version here, inside the same
    // transaction as the supersession: every row, removed links and
    // superseded verdicts included, because the history of the evidence is
    // part of the record too. The new version has no rows of its own yet, so
    // neither one-per-execution index can be contended. Nothing is rewritten
    // but the pointer -- who linked it, when it was last touched, and why it
    // was removed all stay, which is why updated_at is not in these SETs.
    //
    // Both tables come from the intervention-evidence migration, which lands
    // after this module's own. A database with executions but without it
    // cannot correct one; every pg schema that runs this function applies it.
    await client.query(
      `update pilot.intervention_evidence_links set execution_id = $3
       where organization_id = $1 and execution_id = $2`,
      [input.organizationId, input.executionId, newId],
    );
    await client.query(
      `update pilot.intervention_outcome_reviews set execution_id = $3
       where organization_id = $1 and execution_id = $2`,
      [input.organizationId, input.executionId, newId],
    );

    // A VERDICT STANDS ON FINISHED WORK, so reopening retires it (Jason,
    // 2026-10-12: "6B"; issue #1481, replacing the refusal PR #1472 added). A
    // correction from closed back to in progress stamps the verdict just
    // carried across `superseded` -- the same stamp reviewOutcome gives a
    // verdict a re-review replaces: kept, dated by updated_at, still
    // attributed to its reviewer, never deleted. It is told apart from a
    // replaced verdict because no later review names it in supersedes_review_id
    // (listRetiredReviews). Evidence links stay on the record (moved above).
    // When the work is closed again the coach reviews it afresh and that
    // review is the one active verdict. Asked here, after the move and inside
    // the transaction, so it retires exactly the reviews this correction owns.
    if (finalStatus === 'in_progress' && current.status !== 'in_progress') {
      await client.query(
        `update pilot.intervention_outcome_reviews set status = 'superseded', updated_at = now()
         where organization_id = $1 and execution_id = $2 and status = 'active'`,
        [input.organizationId, newId],
      );
      // Unfinished work has no end time. The successor copied the closed
      // record's actual_end, and closeExecution keeps an existing one, so left
      // here it would stand as the end of the work when it is closed again
      // (Codex P2 on #1507). Cleared unless this correction names one itself.
      if (input.actualEnd === undefined || input.actualEnd === null) {
        await client.query(
          `update pilot.intervention_executions set actual_end = null
           where organization_id = $1 and execution_id = $2`,
          [input.organizationId, newId],
        );
      }
    }

    await client.query(
      `update pilot.intervention_executions set status = $3, updated_at = now()
       where organization_id = $1 and execution_id = $2 returning execution_id`,
      [input.organizationId, newId, finalStatus],
    );

    return newId;
  });

  return getExecution(input.organizationId, corrected);
}
