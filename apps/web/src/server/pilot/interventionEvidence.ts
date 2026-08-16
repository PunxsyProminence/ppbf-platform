import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { getExecution } from './interventionExecutions';

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

export const EVIDENCE_ROLES = [
  'baseline', 'during_intervention', 'immediate_post', 'retention',
  'transfer', 'counterevidence', 'adverse_response', 'context',
] as const;

export const EVIDENCE_SOURCE_KINDS = [
  'training_attempt', 'readiness', 'assessment', 'film_study', 'activity_log',
] as const;

export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

/** Per-kind existence/scope queries. Every source must belong to the same
 * organization AND the same athlete as the execution it evidences --
 * cross-athlete and cross-org links are refused as not-found, and an
 * activity row without an athlete cannot evidence one. Parameters:
 * $1 organization, $2 source id, $3 athlete. */
export const EVIDENCE_SOURCES: Record<EvidenceSourceKind, string> = {
  training_attempt: `select 1 from pilot.training_attempts
    where organization_id = $1 and attempt_id = $2 and athlete_id = $3`,
  readiness: `select 1 from pilot.readiness
    where organization_id = $1 and readiness_id::text = $2 and athlete_id = $3`,
  assessment: `select 1 from pilot.assessments
    where organization_id = $1 and assessment_id::text = $2 and athlete_id = $3`,
  film_study: `select 1 from pilot.shadow_film_study_proposals
    where organization_id = $1 and proposal_id::text = $2 and athlete_id = $3`,
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
 * must exist in the same org for the same athlete. Every other outcome is
 * a hidden not-found. */
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

/** Removal stamps, never deletes: the link stays on record with why it no
 * longer counts. */
export async function removeEvidence(input: {
  organizationId: string;
  linkId: string;
  removedReason: string;
}): Promise<EvidenceLinkRow | null> {
  const row = await queryOne<{ link_id: string }>(
    `update pilot.intervention_evidence_links
     set status = 'removed', removed_reason = $3, updated_at = now()
     where organization_id = $1 and link_id = $2 and status = 'active'
     returning link_id`,
    [input.organizationId, input.linkId, input.removedReason],
  );
  if (!row) return null;
  return queryOne<EvidenceLinkRow>(
    `select * from pilot.intervention_evidence_links where organization_id = $1 and link_id = $2`,
    [input.organizationId, input.linkId],
  );
}

export async function listEvidence(organizationId: string, executionId: string): Promise<EvidenceLinkRow[]> {
  return query<EvidenceLinkRow>(
    `select * from pilot.intervention_evidence_links
     where organization_id = $1 and execution_id = $2
     order by created_at asc`,
    [organizationId, executionId],
  );
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
