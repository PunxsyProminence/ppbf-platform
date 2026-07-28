import { query, queryOne } from './db';
import type { ShadowConfidenceTier } from './shadowAuthority';
import type { ShadowSourceVerificationState } from './shadow';

export interface ShadowResearchRequirementInput {
  organizationId: string;
  sourceEventName: string;
  sourceEntityType: string;
  sourceEntityId: string;
  researchRequirement: string;
  knowledgeGap: string;
  evidenceLabel: string | null;
  sourceStatus: string;
  sourceConfidenceTier: ShadowConfidenceTier;
  sourceVerificationState: ShadowSourceVerificationState;
  createdByAccountId: string;
  createdByRole: string;
  metadata?: Record<string, unknown>;
}

export interface ShadowResearchRequirementRow {
  research_requirement_id: number;
  organization_id: string;
  source_event_name: string;
  source_entity_type: string;
  source_entity_id: string;
  research_requirement: string;
  knowledge_gap: string;
  evidence_label: string | null;
  source_status: string;
  source_confidence_tier: string;
  source_verification_state: string;
  status: 'open' | 'resolved';
  created_by_account_id: string;
  created_by_role: string;
  metadata: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
}

export interface ShadowResearchRequirementFilter {
  status?: 'open' | 'resolved';
  // When provided, only return rows tied to one of these athlete IDs.
  athleteIds?: string[];
}

export async function createShadowResearchRequirement(input: ShadowResearchRequirementInput): Promise<number> {
  const row = await queryOne<{ research_requirement_id: number }>(
    `insert into pilot.shadow_research_requirements
     (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement, knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state, created_by_account_id, created_by_role, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     on conflict (organization_id, source_event_name, source_entity_type, source_entity_id)
     do update set
       source_entity_id = pilot.shadow_research_requirements.source_entity_id
     returning research_requirement_id`,
    [
      input.organizationId,
      input.sourceEventName,
      input.sourceEntityType,
      input.sourceEntityId,
      input.researchRequirement,
      input.knowledgeGap,
      input.evidenceLabel,
      input.sourceStatus,
      input.sourceConfidenceTier,
      input.sourceVerificationState,
      input.createdByAccountId,
      input.createdByRole,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  if (!row) {
    throw new Error('Unable to create SHADOW research requirement.');
  }

  return row.research_requirement_id;
}

export async function listShadowResearchRequirements(
  organizationId: string,
  filter: ShadowResearchRequirementFilter = {},
): Promise<ShadowResearchRequirementRow[]> {
  const athleteIds = filter.athleteIds ?? [];
  const hasAthleteScope = athleteIds.length > 0;
  return query<ShadowResearchRequirementRow>(
    `select
       research_requirement_id,
       organization_id,
       source_event_name,
       source_entity_type,
       source_entity_id,
       research_requirement,
       knowledge_gap,
       evidence_label,
       source_status,
       source_confidence_tier,
       source_verification_state,
       status,
       created_by_account_id,
       created_by_role,
       metadata,
       created_at,
       resolved_at
     from pilot.shadow_research_requirements
     where organization_id = $1
       and ($2::text is null or status = $2)
       and (
         $3::boolean = false
         or source_entity_id = any($4::text[])
         or evidence_label = any($4::text[])
         or metadata->>'subject_id' = any($4::text[])
       )
     order by created_at desc`,
    [organizationId, filter.status ?? null, hasAthleteScope, athleteIds],
  );
}

export async function resolveShadowResearchRequirement(input: {
  organizationId: string;
  researchRequirementId: number;
  resolvedByAccountId: string;
  resolvedByRole: string;
  metadata?: Record<string, unknown>;
  // When provided (a parent caller), the row must match one of these athlete
  // IDs via the same source_entity_id/evidence_label/metadata.subject_id
  // heuristic listShadowResearchRequirements uses -- otherwise a parent could
  // resolve any other family's requirement in the org by guessing/enumerating
  // an id, even though the list view is already correctly scoped.
  athleteIds?: string[];
}): Promise<boolean> {
  const hasAthleteScope = (input.athleteIds?.length ?? 0) > 0;
  const rows = await query<{
    research_requirement_id: number;
  }>(
    `update pilot.shadow_research_requirements
     set status = 'resolved',
         resolved_at = now(),
         metadata = metadata || $3::jsonb
     where organization_id = $1
       and research_requirement_id = $2
       and status = 'open'
       and (
         $4::boolean = false
         or source_entity_id = any($5::text[])
         or evidence_label = any($5::text[])
         or metadata->>'subject_id' = any($5::text[])
       )
     returning research_requirement_id`,
    [
      input.organizationId,
      input.researchRequirementId,
      JSON.stringify({
        resolved_by_account_id: input.resolvedByAccountId,
        resolved_by_role: input.resolvedByRole,
        ...(input.metadata ?? {}),
      }),
      hasAthleteScope,
      input.athleteIds ?? [],
    ],
  );

  return rows.length > 0;
}
