import { query, queryOne } from './db';

// The 14-domain research classification taxonomy from issue #345.
// Shared between this module (server validation) and the research API route
// so the constraint is identical on both sides of the HTTP boundary.
export const RESEARCH_DOMAINS = [
  'boxing_athlete_development',
  'ai_ml_data_science',
  'strength_conditioning_nutrition_recovery',
  'coaching_coach_development',
  'staff_volunteer_development',
  'parent_guardian_engagement',
  'youth_development_safeguarding',
  'nonprofit_management_governance_boards',
  'fundraising_donor_development',
  'finance_sustainability',
  'community_engagement_partnerships',
  'hr_organizational_culture',
  'compliance_risk_insurance',
  'program_evaluation_outcomes',
] as const;

export type ResearchDomain = (typeof RESEARCH_DOMAINS)[number];

export function isResearchDomain(value: unknown): value is ResearchDomain {
  return typeof value === 'string' && (RESEARCH_DOMAINS as readonly string[]).includes(value);
}

export const RESEARCH_DOMAIN_LABELS: Record<ResearchDomain, string> = {
  boxing_athlete_development: 'Boxing and Athlete Development',
  ai_ml_data_science: 'AI / ML / Data Science',
  strength_conditioning_nutrition_recovery: 'Strength, Conditioning, Nutrition, Recovery',
  coaching_coach_development: 'Coaching / Coach Development',
  staff_volunteer_development: 'Staff / Volunteer Development',
  parent_guardian_engagement: 'Parent / Guardian Engagement',
  youth_development_safeguarding: 'Youth Development / Safeguarding',
  nonprofit_management_governance_boards: 'Nonprofit Management / Governance / Boards',
  fundraising_donor_development: 'Fundraising / Donor Development',
  finance_sustainability: 'Finance / Sustainability',
  community_engagement_partnerships: 'Community Engagement / Partnerships',
  hr_organizational_culture: 'HR / Organizational Culture',
  compliance_risk_insurance: 'Compliance / Risk / Insurance',
  program_evaluation_outcomes: 'Program Evaluation / Outcomes',
};

// The five-rung answer-state ladder defined in issue #345.
// This is COMPUTED — never stored. The `resolved` rung reads only the
// requirement's own status field, which is only written by the human
// Mark-Resolved path. Submission alone can structurally never reach
// `resolved`.
export type AnswerState =
  | 'needs_evidence'
  | 'sources_submitted'
  | 'evidence_under_review'
  | 'partially_answered'
  | 'resolved';

export function computeAnswerState(
  requirement: { status: 'open' | 'resolved' },
  submissions: Array<{ review_verdict: string | null }>,
): AnswerState {
  if (requirement.status === 'resolved') return 'resolved';
  if (submissions.length === 0) return 'needs_evidence';
  const hasPositive = submissions.some(
    (s) => s.review_verdict === 'relevant' || s.review_verdict === 'partial',
  );
  if (hasPositive) return 'partially_answered';
  // All submissions still pending review → freshly submitted state.
  const allPending = submissions.every((s) => s.review_verdict === null);
  if (allPending) return 'sources_submitted';
  // Mix of reviewed (non-positive) and still-pending → under review.
  return 'evidence_under_review';
}

export interface ResearchSubmissionRow {
  submission_id: string;
  organization_id: string;
  research_requirement_id: number;
  source_id: string;
  submitted_by_account_id: string;
  submitted_by_role: string;
  doi: string | null;
  pmid: string | null;
  provider_provenance: string | null;
  why_this_source: string | null;
  review_verdict: string | null;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateResearchSubmissionInput {
  organizationId: string;
  researchRequirementId: number;
  sourceId: string;
  submittedByAccountId: string;
  submittedByRole: string;
  doi?: string | null;
  pmid?: string | null;
  providerProvenance?: string | null;
  whyThisSource?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createResearchSubmission(
  input: CreateResearchSubmissionInput,
): Promise<ResearchSubmissionRow> {
  const row = await queryOne<ResearchSubmissionRow>(
    `insert into pilot.shadow_research_submissions
       (organization_id, research_requirement_id, source_id,
        submitted_by_account_id, submitted_by_role,
        doi, pmid, provider_provenance, why_this_source, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     returning *`,
    [
      input.organizationId,
      input.researchRequirementId,
      input.sourceId,
      input.submittedByAccountId,
      input.submittedByRole,
      input.doi ?? null,
      input.pmid ?? null,
      input.providerProvenance ?? null,
      input.whyThisSource ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  if (!row) {
    throw new Error('Unable to create research submission.');
  }

  return row;
}

export async function listResearchSubmissions(
  organizationId: string,
  filter: { researchRequirementId?: number } = {},
): Promise<ResearchSubmissionRow[]> {
  return query<ResearchSubmissionRow>(
    `select *
     from pilot.shadow_research_submissions
     where organization_id = $1
       and ($2::bigint is null or research_requirement_id = $2)
     order by created_at desc`,
    [organizationId, filter.researchRequirementId ?? null],
  );
}
