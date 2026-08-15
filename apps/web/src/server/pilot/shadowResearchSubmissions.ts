import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// The research-lifecycle link record (issue #345, slice 1): one row per
// source submitted against one requirement, plus the COMPUTED answer-state
// ladder the workspace shows.
//
// The rule this module exists to hold: A SUBMISSION NEVER RESOLVES A
// REQUIREMENT. Nothing here writes shadow_research_requirements. The ladder's
// 'resolved' rung is read FROM the requirement's own status -- the existing
// human act -- never derived from submissions. "PDF uploaded" is not
// "question answered", and duplicate links are refused by the table itself.

export type ApplicabilityState = 'unreviewed' | 'responsive' | 'partially_responsive' | 'not_responsive' | 'duplicate';

export const APPLICABILITY_STATES: readonly ApplicabilityState[] = [
  'unreviewed', 'responsive', 'partially_responsive', 'not_responsive', 'duplicate',
];

export function isApplicabilityState(value: unknown): value is ApplicabilityState {
  return typeof value === 'string' && (APPLICABILITY_STATES as readonly string[]).includes(value);
}

// The ladder, in the issue's own vocabulary.
export type AnswerState =
  | 'needs_evidence'
  | 'sources_submitted'
  | 'evidence_under_review'
  | 'partially_answered'
  | 'resolved';

export interface ResearchSubmissionRow {
  organization_id: string;
  submission_id: string;
  research_requirement_id: number;
  source_id: string;
  document_id: string | null;
  provenance: Record<string, unknown>;
  submission_note: string;
  applicability_state: ApplicabilityState;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  review_note: string;
  submitted_by_account_id: string;
  created_at: string;
  updated_at: string;
}

const FIELDS = `organization_id, submission_id, research_requirement_id, source_id, document_id,
  provenance, submission_note, applicability_state, reviewed_by_account_id, reviewed_at,
  review_note, submitted_by_account_id, created_at, updated_at`;

/**
 * Org-scoped existence reads for the route's isolation checks. The table's
 * FKs prove a source/requirement EXISTS; they cannot prove it belongs to the
 * caller's organization, and a cross-org link would be an isolation breach.
 * The route collapses "doesn't exist" and "exists elsewhere" into one hidden
 * not-found so neither can be used to enumerate another gym's records.
 */
export async function getRequirementStatusInOrg(
  organizationId: string,
  researchRequirementId: number,
): Promise<'open' | 'resolved' | null> {
  const row = await queryOne<{ status: 'open' | 'resolved' }>(
    `select status from pilot.shadow_research_requirements
     where organization_id = $1 and research_requirement_id = $2`,
    [organizationId, researchRequirementId],
  );
  return row?.status ?? null;
}

/** Org-scoped statuses for a batch of requirement ids; ids outside the
 * organization are simply absent from the result, indistinguishable from
 * ids that do not exist. */
export async function getRequirementStatusesInOrg(
  organizationId: string,
  requirementIds: readonly number[],
): Promise<Array<{ research_requirement_id: number; status: 'open' | 'resolved' }>> {
  if (requirementIds.length === 0) return [];
  const rows = await query<{ research_requirement_id: string | number; status: 'open' | 'resolved' }>(
    `select research_requirement_id, status
     from pilot.shadow_research_requirements
     where organization_id = $1 and research_requirement_id = any($2::bigint[])`,
    [organizationId, [...requirementIds]],
  );
  return rows.map((row) => ({
    research_requirement_id: Number(row.research_requirement_id),
    status: row.status,
  }));
}

export async function sourceExistsInOrg(organizationId: string, sourceId: string): Promise<boolean> {
  const row = await queryOne<{ source_id: string }>(
    'select source_id from pilot.shadow_library_sources where organization_id = $1 and source_id = $2',
    [organizationId, sourceId],
  );
  return row !== null;
}

export async function documentExistsInOrg(organizationId: string, documentId: string): Promise<boolean> {
  const row = await queryOne<{ document_id: string }>(
    'select document_id from pilot.shadow_library_documents where organization_id = $1 and document_id = $2',
    [organizationId, documentId],
  );
  return row !== null;
}

export async function createResearchSubmission(input: {
  organizationId: string;
  researchRequirementId: number;
  sourceId: string;
  documentId?: string | null;
  provenance?: Record<string, unknown>;
  submissionNote?: string;
  submittedByAccountId: string;
}): Promise<ResearchSubmissionRow> {
  try {
    const row = await queryOne<ResearchSubmissionRow>(
      `insert into pilot.shadow_research_submissions
         (organization_id, submission_id, research_requirement_id, source_id, document_id,
          provenance, submission_note, submitted_by_account_id)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       returning ${FIELDS}`,
      [
        input.organizationId,
        randomUUID(),
        input.researchRequirementId,
        input.sourceId,
        input.documentId ?? null,
        JSON.stringify(input.provenance ?? {}),
        input.submissionNote ?? '',
        input.submittedByAccountId,
      ],
    );
    if (!row) throw new Error('Unable to record the research submission.');
    return row;
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === 'pilot_shadow_research_submissions_unique_link') {
      // Duplicate source != corroboration (issue #345). Named error so the
      // route can say it plainly instead of surfacing a constraint name.
      throw new Error('RESEARCH_SUBMISSION_DUPLICATE_LINK: this source is already submitted against this requirement.');
    }
    throw error;
  }
}

export async function listSubmissionsForRequirement(
  organizationId: string,
  researchRequirementId: number,
): Promise<ResearchSubmissionRow[]> {
  return query<ResearchSubmissionRow>(
    `select ${FIELDS}
     from pilot.shadow_research_submissions
     where organization_id = $1 and research_requirement_id = $2
     order by created_at desc`,
    [organizationId, researchRequirementId],
  );
}

export async function reviewResearchSubmission(input: {
  organizationId: string;
  submissionId: string;
  applicabilityState: Exclude<ApplicabilityState, 'unreviewed'>;
  reviewNote?: string;
  reviewedByAccountId: string;
}): Promise<ResearchSubmissionRow | null> {
  return queryOne<ResearchSubmissionRow>(
    `update pilot.shadow_research_submissions
     set applicability_state = $3,
         reviewed_by_account_id = $4,
         reviewed_at = now(),
         review_note = coalesce($5, review_note),
         updated_at = now()
     where organization_id = $1 and submission_id = $2
     returning ${FIELDS}`,
    [input.organizationId, input.submissionId, input.applicabilityState, input.reviewedByAccountId, input.reviewNote ?? null],
  );
}

/**
 * The computed ladder for one requirement. Pure, deterministic, and unable to
 * say 'resolved' on its own authority: that rung comes only from the
 * requirement's own status, which only the existing human act changes.
 */
export function deriveAnswerState(
  requirementStatus: 'open' | 'resolved',
  submissions: readonly Pick<ResearchSubmissionRow, 'applicability_state'>[],
): AnswerState {
  if (requirementStatus === 'resolved') return 'resolved';
  if (submissions.length === 0) return 'needs_evidence';

  const reviewed = submissions.filter((s) => s.applicability_state !== 'unreviewed');
  if (reviewed.length === 0) return 'sources_submitted';

  const responsive = reviewed.filter(
    (s) => s.applicability_state === 'responsive' || s.applicability_state === 'partially_responsive',
  );
  if (responsive.length > 0) return 'partially_answered';

  // Everything reviewed so far was non-responsive or duplicate; anything
  // unreviewed is still in the queue. Either way the question is not closer
  // to answered than when review started.
  return submissions.some((s) => s.applicability_state === 'unreviewed')
    ? 'evidence_under_review'
    : 'needs_evidence';
}

/** Batch ladder for the workspace list: requirement id -> answer state. */
export async function getAnswerStates(
  organizationId: string,
  requirements: readonly { research_requirement_id: number; status: 'open' | 'resolved' }[],
): Promise<Map<number, AnswerState>> {
  const result = new Map<number, AnswerState>();
  if (requirements.length === 0) return result;

  const rows = await query<Pick<ResearchSubmissionRow, 'research_requirement_id' | 'applicability_state'>>(
    `select research_requirement_id, applicability_state
     from pilot.shadow_research_submissions
     where organization_id = $1 and research_requirement_id = any($2::bigint[])`,
    [organizationId, requirements.map((r) => r.research_requirement_id)],
  );

  const byRequirement = new Map<number, { applicability_state: ApplicabilityState }[]>();
  for (const row of rows) {
    if (!byRequirement.has(row.research_requirement_id)) byRequirement.set(row.research_requirement_id, []);
    byRequirement.get(row.research_requirement_id)!.push({ applicability_state: row.applicability_state });
  }

  for (const requirement of requirements) {
    result.set(
      requirement.research_requirement_id,
      deriveAnswerState(requirement.status, byRequirement.get(requirement.research_requirement_id) ?? []),
    );
  }
  return result;
}
