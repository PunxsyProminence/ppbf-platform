import { randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';

// pilot.local_findings, pilot.local_finding_tier_history and
// pilot.v_evidence_combined are owned by
// infra/azure/pilot_slice_postgres_local_findings_migration.sql, applied
// through the apply-migrations workflow like every other table. Nothing
// here issues DDL.
//
// NO COUNT IN THIS MODULE TRIGGERS A TIER CHANGE. advanceLocalFindingTier
// is the only function that moves a finding between tiers, and every call
// requires a human-authored rationale (>=15 characters, matching
// pilot_lfth_rationale) -- advancement is a judgement this module records,
// never a promotion it computes.
//
// LOCAL TIERS ARE NOT COMPARABLE TO PUBLISHED EVIDENCE CLASSES. Any
// caller reading getEvidenceCombined must render `origin` and
// `tier_context` alongside `tier` -- see the migration's own comment on
// pilot.v_evidence_combined.

export type LocalFindingDomain = 'technical' | 'physical' | 'psychological' | 'operational' | 'safety';
export type LocalFindingOriginatingSource =
  | 'coach_observation'
  | 'drill_outcome'
  | 'assessment_data'
  | 'athlete_feedback'
  | 'flag_calibration'
  | 'session_pattern'
  | 'other';
export type LocalFindingTier =
  | 'observation'
  | 'repeated_observation'
  | 'local_pattern'
  | 'local_tested'
  | 'local_established'
  | 'retired';
export type LocalFindingPredictionOutcome = 'held' | 'partially_held' | 'did_not_hold' | 'not_yet_checked';
export type LocalFindingLiteratureAgreement = 'agrees' | 'extends' | 'contradicts' | 'no_published_equivalent';
export type LocalFindingStatus = 'active' | 'superseded' | 'retired';

const MIN_CONTRADICTION_NOTE_LENGTH = 20;
const MIN_TIER_CHANGE_RATIONALE_LENGTH = 15;

// Tiers pilot_local_findings_tested/pilot_local_findings_reviewed require a
// stated, already-checked prediction and a second reviewer on. Kept as one
// exported set so app-layer checks and the constraints they mirror can
// never silently drift apart.
export const WEIGHT_BEARING_TIERS: ReadonlySet<LocalFindingTier> = new Set(['local_tested', 'local_established']);

export interface LocalFindingRow {
  organization_id: string;
  finding_id: string;
  lineage_id: string;
  version: number;
  title: string;
  statement: string;
  domain: LocalFindingDomain;
  applies_to: string;
  originating_source: LocalFindingOriginatingSource;
  local_tier: LocalFindingTier;
  athletes_observed: number;
  observation_span_days: number;
  independent_observers: number;
  supporting_activity_ids: string[];
  supporting_assessment_ids: string[];
  prediction_statement: string | null;
  prediction_made_at: string | null;
  prediction_outcome: LocalFindingPredictionOutcome | null;
  prediction_checked_at: string | null;
  prediction_note: string | null;
  related_claim_ids: string[];
  agrees_with_literature: LocalFindingLiteratureAgreement | null;
  contradiction_note: string | null;
  competing_explanations: string;
  known_limitations: string;
  raised_by_account_id: string;
  raised_by_role: string;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  status: LocalFindingStatus;
  created_at: string;
  updated_at: string;
}

export interface LocalFindingTierHistoryRow {
  organization_id: string;
  history_id: string;
  finding_id: string;
  from_tier: LocalFindingTier | null;
  to_tier: LocalFindingTier;
  rationale: string;
  evidence_snapshot: Record<string, unknown>;
  changed_by_account_id: string;
  changed_by_role: string;
  changed_at: string;
}

const FINDING_FIELDS =
  'organization_id, finding_id, lineage_id, version, title, statement, domain, applies_to, originating_source, '
  + 'local_tier, athletes_observed, observation_span_days, independent_observers, supporting_activity_ids, '
  + 'supporting_assessment_ids, prediction_statement, prediction_made_at, prediction_outcome, '
  + 'prediction_checked_at, prediction_note, related_claim_ids, agrees_with_literature, contradiction_note, '
  + 'competing_explanations, known_limitations, raised_by_account_id, raised_by_role, reviewed_by_account_id, '
  + 'reviewed_at, review_note, status, created_at, updated_at';

export interface RaiseLocalFindingInput {
  organizationId: string;
  title: string;
  statement: string;
  domain: LocalFindingDomain;
  appliesTo?: string;
  originatingSource: LocalFindingOriginatingSource;
  supportingActivityIds?: string[];
  supportingAssessmentIds?: string[];
  relatedClaimIds?: string[];
  competingExplanations?: string;
  knownLimitations?: string;
  raisedByAccountId: string;
  raisedByRole: string;
}

/**
 * A finding always starts at 'observation' -- the whole point of the
 * ladder is that nothing enters at a weight-bearing tier. Advancing it is
 * advanceLocalFindingTier's job, never this function's.
 */
export async function raiseLocalFinding(input: RaiseLocalFindingInput): Promise<LocalFindingRow> {
  const findingId = randomUUID();
  const row = await queryOne<LocalFindingRow>(
    `insert into pilot.local_findings
       (organization_id, finding_id, lineage_id, title, statement, domain, applies_to, originating_source,
        supporting_activity_ids, supporting_assessment_ids, related_claim_ids, competing_explanations,
        known_limitations, raised_by_account_id, raised_by_role)
     values ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning ${FINDING_FIELDS}`,
    [
      input.organizationId,
      findingId,
      input.title,
      input.statement,
      input.domain,
      input.appliesTo ?? '',
      input.originatingSource,
      input.supportingActivityIds ?? [],
      input.supportingAssessmentIds ?? [],
      input.relatedClaimIds ?? [],
      input.competingExplanations ?? '',
      input.knownLimitations ?? '',
      input.raisedByAccountId,
      input.raisedByRole,
    ],
  );
  if (!row) {
    throw new Error('Unable to raise local finding.');
  }
  return row;
}

export async function listLocalFindings(
  organizationId: string,
  filter: { domain?: LocalFindingDomain; localTier?: LocalFindingTier; status?: LocalFindingStatus } = {},
): Promise<LocalFindingRow[]> {
  return query<LocalFindingRow>(
    `select ${FINDING_FIELDS}
     from pilot.local_findings
     where organization_id = $1
       and ($2::text is null or domain = $2)
       and ($3::text is null or local_tier = $3)
       and ($4::text is null or status = $4)
     order by created_at desc`,
    [organizationId, filter.domain ?? null, filter.localTier ?? null, filter.status ?? null],
  );
}

export interface AdvanceLocalFindingTierInput {
  organizationId: string;
  findingId: string;
  toTier: LocalFindingTier;
  rationale: string;
  changedByAccountId: string;
  changedByRole: string;
  // Required to reach local_tested/local_established -- see
  // pilot_local_findings_tested and pilot_local_findings_reviewed.
  predictionStatement?: string;
  predictionMadeAt?: string;
  predictionOutcome?: LocalFindingPredictionOutcome;
  predictionCheckedAt?: string;
  predictionNote?: string;
  reviewedByAccountId?: string;
  reviewNote?: string;
}

/**
 * Moves a finding to a new tier and appends a tier-history row in one
 * transaction. Refuses up front, ahead of the raw constraint violations,
 * for the same reasons the migration enforces:
 * - a rationale under 15 characters (pilot_lfth_rationale)
 * - reaching local_tested/local_established without a prediction stated
 *   BEFORE it was checked (pilot_local_findings_tested)
 * - reaching local_tested/local_established without a second reviewer
 *   (pilot_local_findings_reviewed)
 */
export async function advanceLocalFindingTier(
  input: AdvanceLocalFindingTierInput,
): Promise<{ finding: LocalFindingRow; historyEntry: LocalFindingTierHistoryRow }> {
  if (input.rationale.trim().length < MIN_TIER_CHANGE_RATIONALE_LENGTH) {
    throw new Error(
      `LOCAL_FINDING_RATIONALE_TOO_SHORT: rationale must be at least ${MIN_TIER_CHANGE_RATIONALE_LENGTH} characters`,
    );
  }
  if (WEIGHT_BEARING_TIERS.has(input.toTier)) {
    const predictionCheckedBeforeMade = input.predictionMadeAt && input.predictionCheckedAt
      && new Date(input.predictionCheckedAt).getTime() <= new Date(input.predictionMadeAt).getTime();
    if (
      !input.predictionStatement || !input.predictionMadeAt
      || !input.predictionOutcome || input.predictionOutcome === 'not_yet_checked'
      || !input.predictionCheckedAt || predictionCheckedBeforeMade
    ) {
      throw new Error(
        'LOCAL_FINDING_PREDICTION_REQUIRED: local_tested/local_established requires a prediction stated '
        + 'before it was checked, with a recorded outcome',
      );
    }
    if (!input.reviewedByAccountId) {
      throw new Error('LOCAL_FINDING_SECOND_REVIEWER_REQUIRED: local_tested/local_established requires a second reviewer');
    }
  }

  return withTransaction(async (client) => {
    const existingResult = await client.query<Pick<LocalFindingRow, 'local_tier'>>(
      `select local_tier from pilot.local_findings where organization_id = $1 and finding_id = $2 for update`,
      [input.organizationId, input.findingId],
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw new Error('LOCAL_FINDING_NOT_FOUND');
    }

    const findingResult = await client.query<LocalFindingRow>(
      `update pilot.local_findings
         set local_tier = $3,
             prediction_statement = coalesce($4, prediction_statement),
             prediction_made_at = coalesce($5::timestamptz, prediction_made_at),
             prediction_outcome = coalesce($6, prediction_outcome),
             prediction_checked_at = coalesce($7::timestamptz, prediction_checked_at),
             prediction_note = coalesce($8, prediction_note),
             reviewed_by_account_id = coalesce($9, reviewed_by_account_id),
             reviewed_at = case when $9::text is null then reviewed_at else now() end,
             review_note = coalesce($10, review_note),
             updated_at = now()
       where organization_id = $1 and finding_id = $2
       returning ${FINDING_FIELDS}`,
      [
        input.organizationId,
        input.findingId,
        input.toTier,
        input.predictionStatement ?? null,
        input.predictionMadeAt ?? null,
        input.predictionOutcome ?? null,
        input.predictionCheckedAt ?? null,
        input.predictionNote ?? null,
        input.reviewedByAccountId ?? null,
        input.reviewNote ?? null,
      ],
    );
    const finding = findingResult.rows[0];

    const historyId = randomUUID();
    const historyResult = await client.query<LocalFindingTierHistoryRow>(
      `insert into pilot.local_finding_tier_history
         (organization_id, history_id, finding_id, from_tier, to_tier, rationale, evidence_snapshot,
          changed_by_account_id, changed_by_role)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       returning organization_id, history_id, finding_id, from_tier, to_tier, rationale, evidence_snapshot,
                 changed_by_account_id, changed_by_role, changed_at`,
      [
        input.organizationId,
        historyId,
        input.findingId,
        existing.local_tier,
        input.toTier,
        input.rationale.trim(),
        JSON.stringify({
          athletes_observed: finding.athletes_observed,
          observation_span_days: finding.observation_span_days,
          independent_observers: finding.independent_observers,
        }),
        input.changedByAccountId,
        input.changedByRole,
      ],
    );

    return { finding, historyEntry: historyResult.rows[0] };
  });
}

export async function listLocalFindingTierHistory(
  organizationId: string,
  findingId: string,
): Promise<LocalFindingTierHistoryRow[]> {
  return query<LocalFindingTierHistoryRow>(
    `select organization_id, history_id, finding_id, from_tier, to_tier, rationale, evidence_snapshot,
            changed_by_account_id, changed_by_role, changed_at
     from pilot.local_finding_tier_history
     where organization_id = $1 and finding_id = $2
     order by changed_at asc`,
    [organizationId, findingId],
  );
}

export interface RecordLiteratureRelationshipInput {
  organizationId: string;
  findingId: string;
  agreesWithLiterature: LocalFindingLiteratureAgreement;
  contradictionNote?: string;
}

/**
 * Records how a finding relates to the published registry. Refuses up
 * front when agreesWithLiterature='contradicts' and the note is under 20
 * characters, matching pilot_local_findings_contradiction -- "a finding
 * that contradicts published evidence must say how."
 */
export async function recordLiteratureRelationship(
  input: RecordLiteratureRelationshipInput,
): Promise<LocalFindingRow> {
  if (
    input.agreesWithLiterature === 'contradicts'
    && (!input.contradictionNote || input.contradictionNote.trim().length < MIN_CONTRADICTION_NOTE_LENGTH)
  ) {
    throw new Error(
      `LOCAL_FINDING_CONTRADICTION_NOTE_TOO_SHORT: must be at least ${MIN_CONTRADICTION_NOTE_LENGTH} characters`,
    );
  }

  const row = await queryOne<LocalFindingRow>(
    `update pilot.local_findings
       set agrees_with_literature = $3, contradiction_note = $4, updated_at = now()
     where organization_id = $1 and finding_id = $2
     returning ${FINDING_FIELDS}`,
    [input.organizationId, input.findingId, input.agreesWithLiterature, input.contradictionNote?.trim() ?? null],
  );
  if (!row) {
    throw new Error('LOCAL_FINDING_NOT_FOUND');
  }
  return row;
}

export interface EvidenceCombinedRow {
  organization_id: string;
  origin: 'local';
  id: string;
  title: string;
  statement: string;
  domain: LocalFindingDomain;
  tier: LocalFindingTier;
  tier_context: string;
  n_observed: number;
  agrees_with_literature: LocalFindingLiteratureAgreement | null;
  related_claim_ids: string[];
  created_at: string;
}

/**
 * Reads pilot.v_evidence_combined. Every row carries `origin` and
 * `tier_context` -- a caller MUST render both, never `tier` alone, or a
 * local finding reads as if it were published evidence.
 */
export async function getEvidenceCombined(organizationId: string): Promise<EvidenceCombinedRow[]> {
  return query<EvidenceCombinedRow>(
    `select organization_id, origin, id, title, statement, domain, tier, tier_context, n_observed,
            agrees_with_literature, related_claim_ids, created_at
     from pilot.v_evidence_combined
     where organization_id = $1
     order by created_at desc`,
    [organizationId],
  );
}
