import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { getExecution } from './interventionExecutions';
import type { FilmStudyProposalReviewState } from './shadowFilmStudyProposals';
import {
  isReadinessUsableAsMeasurement,
  type ReadinessProvenance,
} from './readinessProvenance';

// Intervention evidence + outcome review (register module 026 slice 3) --
// the loop-closing layer: typed evidence links with semantic roles, and
// the human review that answers three SEPARATE questions: what happened
// (performance), what happened to the belief (hypothesis), and what the
// episode revealed (learning). Never one reward score.
//
// Evidence sources are heterogeneous by design -- attempts, readiness
// entries, assessments, film-study observations, activity rows -- each
// validated against its own table for existence, organization, and
// athlete scope. Nothing is flattened into a universal observations
// table, and no causal claim is made anywhere in this module: the ledger
// preserves provenance for later inference, it does not infer.
//
// Film study is the one source whose row can be inadmissible for a reason
// that has nothing to do with scope. Every other kind here is a record of
// something that actually happened to the athlete; a film-study row is a
// MODEL'S CLAIM about a child that a human may not have accepted, or may
// have explicitly refused. So that kind carries a second condition --
// review state -- described at ADMISSIBLE_FILM_STUDY_REVIEW_STATES below.
//
// Admissibility is checked at link time AND annotated at read time.
// linkEvidence refuses an inadmissible film-study source outright; but a
// link can also become inadmissible after the fact (a pre-gate link, or a
// proposal whose review state changed), and doctrine says removal stamps,
// never deletes -- so listEvidence never filters. It returns every row with
// a computed `source_admissible`, so a consumer can present a link citing a
// rejected or unreviewed proposal as exactly what it is.

export const EVIDENCE_ROLES = [
  'baseline', 'during_intervention', 'immediate_post', 'retention',
  'transfer', 'counterevidence', 'adverse_response', 'context',
] as const;

export const EVIDENCE_SOURCE_KINDS = [
  'training_attempt', 'readiness', 'assessment', 'film_study', 'activity_log',
] as const;

export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

/**
 * Which Film Study review states may be cited as formal evidence about a
 * child. An ALLOW-LIST, not a deny-list, and that direction is the point.
 *
 * A Film Study proposal is a vision model's observation about an identifiable
 * minor. shadowFilmStudyProposals.ts exists precisely so that observation
 * never touches an athlete record until a human coach attests to it (#103,
 * owner-approved 2026-07-31), and it guarantees BOTH terminal verdicts stay
 * reachable -- 'rejected' is how a coach says "the model is wrong about this
 * child". Until this list existed, the film_study query below read only
 * organization and athlete, so a rejected observation -- and an unreviewed
 * one -- was exactly as citable as an accepted one: a coach could reject a
 * claim on Monday and it could still stand on Friday as formal evidence that
 * an intervention on that child worked. The rejection was recorded and then
 * ignored by the one query that most needed to read it.
 *
 * Naming what IS admissible, rather than what is not, is what keeps this
 * correct as the vocabulary grows. PR #419 is extending Film Study proposals
 * with further verdict kinds and a revision chain. Every state it adds is
 * inadmissible here the moment it appears, and stays inadmissible until
 * somebody deliberately writes it into this list. That is the only safe
 * default, because a deny-list fails silently: the symptom is not a crash or a
 * test going red, it is a new kind of unattested claim about a child quietly
 * becoming citable, with nothing anywhere to say it happened.
 *
 * `as const satisfies` follows credentialPolicy.ts's MICROSOFT_ROLES: it
 * binds this list to the proposals module's own union, so a state renamed or
 * removed there breaks the typecheck here instead of decaying into a clause
 * that silently matches nothing.
 */
export const ADMISSIBLE_FILM_STUDY_REVIEW_STATES = [
  // A coach read the observation and put their name on it. Nothing else
  // qualifies: 'pending_review' has no human behind it yet, and 'rejected'
  // has a human explicitly saying no.
  'accepted',
] as const satisfies readonly FilmStudyProposalReviewState[];

/**
 * The same rule as a plain predicate, so admissibility can be read, reasoned
 * about and tested without a database. The SQL clause below is generated from
 * the same constant, so the two cannot drift apart -- a state added to the
 * list changes both, and nothing changes only one.
 */
export function isAdmissibleFilmStudyReviewState(state: unknown): boolean {
  return typeof state === 'string'
    && (ADMISSIBLE_FILM_STUDY_REVIEW_STATES as readonly string[]).includes(state);
}

/**
 * Rendered as SQL literals rather than a bound parameter on purpose: every
 * EVIDENCE_SOURCES query takes the same three parameters, and callers --
 * including the pg contract test, which executes these strings directly --
 * pass exactly those three. The interpolated values are this module's own
 * closed constants and never touch caller input. Shape borrowed from
 * drillVersioning.ts's decline guard, which inlines its own fixed state list
 * the same way (`review_state in ('proposed', 'under_review')`).
 */
const ADMISSIBLE_FILM_STUDY_REVIEW_STATES_SQL = ADMISSIBLE_FILM_STUDY_REVIEW_STATES
  .map((state) => `'${state}'`)
  .join(', ');

/** Per-kind existence/scope queries. Every source must belong to the same
 * organization AND the same athlete as the execution it evidences --
 * cross-athlete and cross-org links are refused as not-found, and an
 * activity row without an athlete cannot evidence one. Film study carries
 * the extra admissibility condition above: a proposal no coach has accepted
 * is treated exactly like a proposal that does not exist. Parameters:
 * $1 organization, $2 source id, $3 athlete. */
export const EVIDENCE_SOURCES: Record<EvidenceSourceKind, string> = {
  training_attempt: `select 1 from pilot.training_attempts
    where organization_id = $1 and attempt_id = $2 and athlete_id = $3`,
  readiness: `select 1 from pilot.readiness
    where organization_id = $1 and readiness_id::text = $2 and athlete_id = $3`,
  assessment: `select 1 from pilot.assessments
    where organization_id = $1 and assessment_id::text = $2 and athlete_id = $3`,
  film_study: `select 1 from pilot.shadow_film_study_proposals
    where organization_id = $1 and proposal_id::text = $2 and athlete_id = $3
      and review_state in (${ADMISSIBLE_FILM_STUDY_REVIEW_STATES_SQL})`,
  activity_log: `select 1 from pilot.activity_log
    where organization_id = $1 and activity_id = $2 and athlete_id = $3`,
};

export const PERFORMANCE_RESULTS = ['improved', 'unchanged', 'declined', 'mixed', 'unknown'] as const;

export const HYPOTHESIS_RESULTS = [
  'supported', 'partially_supported', 'contradicted',
  'unresolved', 'confounded', 'insufficient_evidence',
] as const;

export const LEARNING_SIGNALS = [
  'prior_belief_strengthened', 'prior_belief_weakened', 'boundary_condition_discovered',
  'intervention_non_response', 'transfer_failure', 'retention_failure',
  'implementation_failure', 'attribution_changed', 'redundant_evidence', 'unresolved',
] as const;

export type PerformanceResult = (typeof PERFORMANCE_RESULTS)[number];
export type HypothesisResult = (typeof HYPOTHESIS_RESULTS)[number];
export type LearningSignal = (typeof LEARNING_SIGNALS)[number];

function vocabError(name: string, vocabulary: readonly string[], value: unknown): string | null {
  if (typeof value !== 'string' || !vocabulary.includes(value)) {
    return `${name} must be one of: ${vocabulary.join(', ')}.`;
  }
  return null;
}

export const evidenceRoleError = (value: unknown) => vocabError('evidence_role', EVIDENCE_ROLES, value);
export const sourceKindError = (value: unknown) => vocabError('source_kind', EVIDENCE_SOURCE_KINDS, value);
export const performanceResultError = (value: unknown) => vocabError('performance_result', PERFORMANCE_RESULTS, value);
export const hypothesisResultError = (value: unknown) => vocabError('hypothesis_result', HYPOTHESIS_RESULTS, value);
export const learningSignalError = (value: unknown) => vocabError('learning_signal', LEARNING_SIGNALS, value);

export interface EvidenceLinkRow {
  organization_id: string;
  link_id: string;
  execution_id: string;
  evidence_role: EvidenceRole;
  source_kind: EvidenceSourceKind;
  source_id: string;
  note: string;
  status: 'active' | 'removed';
  removed_reason: string;
  linked_by_account_id: string;
  created_at: string;
}

export interface OutcomeReviewRow {
  organization_id: string;
  review_id: string;
  execution_id: string;
  supersedes_review_id: string | null;
  performance_result: PerformanceResult;
  performance_notes: string;
  hypothesis_result: HypothesisResult;
  learning_signal: LearningSignal;
  learning_notes: string;
  status: 'active' | 'superseded';
  reviewed_by_account_id: string;
  reviewed_at: string;
}

/** Links one piece of typed evidence to an execution. The execution must
 * be a current (non-superseded) record in the caller's org; the source
 * must exist in the same org for the same athlete, and -- for film study --
 * must be in an admissible review state. Every other outcome is a hidden
 * not-found.
 *
 * The admissibility check is the source query itself rather than a second
 * lookup, deliberately. One round trip means there is no window in which a
 * proposal passes a check and is then linked, and a caller that reaches
 * EVIDENCE_SOURCES directly (the pg contract test does) inherits the rule
 * instead of having to remember it. It also keeps the refusal
 * indistinguishable from "no such proposal", which errors.ts records as the
 * deliberate choice for these per-record lookups: a caller must not be able
 * to probe this route to learn that a proposal about a child exists. */
export async function linkEvidence(input: {
  organizationId: string;
  executionId: string;
  evidenceRole: EvidenceRole;
  sourceKind: EvidenceSourceKind;
  sourceId: string;
  note?: string;
  linkedByAccountId: string;
}): Promise<EvidenceLinkRow | null> {
  const execution = await getExecution(input.organizationId, input.executionId);
  if (!execution || execution.status === 'superseded') return null;

  const source = await queryOne<{ ok: number }>(
    EVIDENCE_SOURCES[input.sourceKind],
    [input.organizationId, input.sourceId, execution.athlete_id],
  );
  if (!source) return null;

  const linkId = randomUUID();
  await queryOne(
    `insert into pilot.intervention_evidence_links
       (organization_id, link_id, execution_id, evidence_role, source_kind, source_id, note, linked_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning link_id`,
    [
      input.organizationId,
      linkId,
      input.executionId,
      input.evidenceRole,
      input.sourceKind,
      input.sourceId,
      input.note ?? '',
      input.linkedByAccountId,
    ],
  );

  return queryOne<EvidenceLinkRow>(
    `select * from pilot.intervention_evidence_links where organization_id = $1 and link_id = $2`,
    [input.organizationId, linkId],
  );
}

export interface EvidenceLinkOwner {
  link_id: string;
  execution_id: string;
  athlete_id: string;
}

/**
 * The athlete an evidence link actually belongs to -- resolved through the
 * link's STORED execution, not through anything the caller supplied.
 *
 * A link_id is the only handle the removal path takes, and by itself it says
 * nothing about whose record it is. This is the lookup that turns it into a
 * subject the central athlete gate can be asked about, so removal can be
 * authorized on the same footing as every read of the same row. Scoped to the
 * organization, so a link_id from another tenant resolves to nothing at all.
 */
export async function getEvidenceLinkOwner(
  organizationId: string,
  linkId: string,
): Promise<EvidenceLinkOwner | null> {
  return queryOne<EvidenceLinkOwner>(
    `select l.link_id, l.execution_id, e.athlete_id
     from pilot.intervention_evidence_links l
     join pilot.intervention_executions e
       on e.organization_id = l.organization_id
      and e.execution_id = l.execution_id
     where l.organization_id = $1 and l.link_id = $2`,
    [organizationId, linkId],
  );
}

/** Removal stamps, never deletes: the link stays on record with why it no
 * longer counts.
 *
 * expectedExecutionId is REQUIRED, and it is the execution whose athlete the
 * caller authorized. It rides into the UPDATE's own WHERE clause so that
 * authorizing and writing are one statement: the row can only be stamped if
 * it still hangs off the execution that was checked. Required rather than
 * optional on purpose -- an optional guard is one a future caller can omit
 * without anything going red, and this is the guard that decides whether a
 * stranger may strike evidence from a child's intervention record.
 */
export async function removeEvidence(input: {
  organizationId: string;
  linkId: string;
  removedReason: string;
  expectedExecutionId: string;
}): Promise<EvidenceLinkRow | null> {
  const row = await queryOne<{ link_id: string }>(
    `update pilot.intervention_evidence_links
     set status = 'removed', removed_reason = $3, updated_at = now()
     where organization_id = $1 and link_id = $2 and status = 'active'
       and execution_id = $4
     returning link_id`,
    [input.organizationId, input.linkId, input.removedReason, input.expectedExecutionId],
  );
  if (!row) return null;
  return queryOne<EvidenceLinkRow>(
    `select * from pilot.intervention_evidence_links where organization_id = $1 and link_id = $2`,
    [input.organizationId, input.linkId],
  );
}

export interface EvidenceLinkListRow extends EvidenceLinkRow {
  /** Whether the link's source may stand as formal evidence about the child
   * RIGHT NOW. See computeSourceAdmissible: film study re-reads the proposal's
   * review state, readiness re-reads its provenance and value contract, and
   * every other kind records something that actually happened and is always
   * admissible. A link is never refused or deleted on this basis -- it is
   * annotated, so a reviewer sees a citation for exactly what it is. */
  source_admissible: boolean;
}

/** Every link for the execution, stamped rows included, oldest first --
 * removal stamps, never deletes, and this read never filters either. The
 * LEFT JOIN reaches the film-study proposal only for film_study rows; a
 * film_study link whose proposal row is gone reads as inadmissible (the
 * helper refuses null), which is the fail-closed direction. */
export async function listEvidence(organizationId: string, executionId: string): Promise<EvidenceLinkListRow[]> {
  const rows = await query<EvidenceLinkRow & {
    film_study_review_state: string | null;
    readiness_method: string | null;
    readiness_reliability_status: string | null;
    readiness_validity_status: string | null;
    readiness_score: number | null;
  }>(
    `select l.*,
            p.review_state as film_study_review_state,
            r.method as readiness_method,
            r.reliability_status as readiness_reliability_status,
            r.validity_status as readiness_validity_status,
            r.score::float8 as readiness_score
     from pilot.intervention_evidence_links l
     left join pilot.shadow_film_study_proposals p
       on l.source_kind = 'film_study'
      and p.organization_id = l.organization_id
      and p.proposal_id::text = l.source_id
     left join pilot.readiness r
       on l.source_kind = 'readiness'
      and r.organization_id = l.organization_id
      and r.readiness_id::text = l.source_id
     where l.organization_id = $1 and l.execution_id = $2
     order by l.created_at asc`,
    [organizationId, executionId],
  );
  return rows.map(({
    film_study_review_state,
    readiness_method,
    readiness_reliability_status,
    readiness_validity_status,
    readiness_score,
    ...link
  }) => ({
    ...link,
    source_admissible: computeSourceAdmissible(link.source_kind, {
      filmStudyReviewState: film_study_review_state,
      readiness: {
        method: readiness_method ?? '',
        reliability_status: readiness_reliability_status ?? '',
        validity_status: readiness_validity_status ?? '',
        score: readiness_score,
      },
    }),
  }));
}

/**
 * Whether a link's source may stand as formal evidence about a child right now.
 *
 * TWO KINDS CARRY A CONDITION, not one. Film study was the only kind checked:
 * a model's claim a human may not have accepted. Readiness is the second and
 * was admitted unconditionally, so a score a staff member typed at intake --
 * method 'UNKNOWN' or 'staff_entered_intake', reliability
 * 'UNVALIDATED - PPBF MUST ESTABLISH' -- was exactly as citable as anything
 * else, in any role including baseline, retention and transfer. Those roles are
 * measurement claims: "this is where the child was before, and this is where
 * they were after". An unvalidated judgement cannot carry them.
 *
 * THE LINK IS NOT REFUSED AND NOT DELETED. Doctrine here is that removal
 * stamps, never deletes, and listEvidence never filters -- so an existing
 * readiness link keeps its row, its role and its place in the record, and
 * simply presents as what it is. A reviewer can still see that a coach cited
 * it, and why.
 *
 * A missing readiness row reads as inadmissible: the left join yields nulls,
 * the empty strings fail the predicate, and that is the fail-closed direction
 * the film-study branch already takes for a deleted proposal.
 */
export function computeSourceAdmissible(
  sourceKind: EvidenceSourceKind,
  sources: {
    filmStudyReviewState?: string | null;
    readiness?: ReadinessProvenance & { score?: number | null };
  },
): boolean {
  if (sourceKind === 'film_study') {
    return isAdmissibleFilmStudyReviewState(sources.filmStudyReviewState);
  }
  if (sourceKind === 'readiness') {
    return sources.readiness !== undefined
      && isReadinessUsableAsMeasurement(sources.readiness);
  }
  return true;
}

/** Records the human review of a CLOSED execution. Reviewing work still in
 * progress is premature and refused; the three answers are separate
 * columns, and the database's own constraints refuse a miss dressed up as
 * success or a confounded episode strengthening a belief. */
export async function reviewOutcome(input: {
  organizationId: string;
  executionId: string;
  performanceResult: PerformanceResult;
  performanceNotes: string;
  hypothesisResult: HypothesisResult;
  learningSignal: LearningSignal;
  learningNotes?: string;
  reviewedByAccountId: string;
}): Promise<OutcomeReviewRow | null> {
  const execution = await getExecution(input.organizationId, input.executionId);
  if (!execution || (execution.status !== 'completed' && execution.status !== 'stopped')) return null;

  const existing = await queryOne<{ review_id: string }>(
    `select review_id from pilot.intervention_outcome_reviews
     where organization_id = $1 and execution_id = $2 and status = 'active'`,
    [input.organizationId, input.executionId],
  );

  const reviewId = randomUUID();
  // Re-review supersedes: the new verdict is born superseded, the old one
  // is stamped, then the new one becomes active -- under the one-active
  // index a crash never leaves two verdicts standing.
  await queryOne(
    `insert into pilot.intervention_outcome_reviews
       (organization_id, review_id, execution_id, supersedes_review_id, performance_result,
        performance_notes, hypothesis_result, learning_signal, learning_notes, status, reviewed_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'superseded', $10)
     returning review_id`,
    [
      input.organizationId,
      reviewId,
      input.executionId,
      existing?.review_id ?? null,
      input.performanceResult,
      input.performanceNotes,
      input.hypothesisResult,
      input.learningSignal,
      input.learningNotes ?? '',
      input.reviewedByAccountId,
    ],
  );
  if (existing) {
    await queryOne(
      `update pilot.intervention_outcome_reviews set status = 'superseded', updated_at = now()
       where organization_id = $1 and review_id = $2 returning review_id`,
      [input.organizationId, existing.review_id],
    );
  }
  await queryOne(
    `update pilot.intervention_outcome_reviews set status = 'active', updated_at = now()
     where organization_id = $1 and review_id = $2 returning review_id`,
    [input.organizationId, reviewId],
  );

  return queryOne<OutcomeReviewRow>(
    `select * from pilot.intervention_outcome_reviews where organization_id = $1 and review_id = $2`,
    [input.organizationId, reviewId],
  );
}

export async function getActiveReview(organizationId: string, executionId: string): Promise<OutcomeReviewRow | null> {
  return queryOne<OutcomeReviewRow>(
    `select * from pilot.intervention_outcome_reviews
     where organization_id = $1 and execution_id = $2 and status = 'active'`,
    [organizationId, executionId],
  );
}

export interface DecisionChainRow {
  execution_id: string;
  decision_text: string | null;
}

/** Decision text for the chain view -- read-only join; this module never
 * writes to the decision loop. */
export async function getDecisionTexts(organizationId: string, executionIds: string[]): Promise<DecisionChainRow[]> {
  if (executionIds.length === 0) return [];
  return query<DecisionChainRow>(
    `select e.execution_id, d.decision_text
     from pilot.intervention_executions e
     left join pilot.shadow_decisions d on d.decision_id = e.decision_id
     where e.organization_id = $1 and e.execution_id = any($2::text[])`,
    [organizationId, executionIds],
  );
}
