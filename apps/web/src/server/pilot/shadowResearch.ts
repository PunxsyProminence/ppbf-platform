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

let ensured = false;

async function ensureShadowResearchTable(): Promise<void> {
  if (ensured) return;

  await query(
    `create table if not exists pilot.shadow_research_requirements (
      research_requirement_id bigserial primary key,
      organization_id text not null,
      source_event_name text not null,
      source_entity_type text not null,
      source_entity_id text not null,
      research_requirement text not null,
      knowledge_gap text not null,
      evidence_label text null,
      source_status text not null,
      source_confidence_tier text not null,
      source_verification_state text not null,
      status text not null default 'open',
      created_by_account_id text not null,
      created_by_role text not null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      resolved_at timestamptz null
    )`,
  );

  await query(
    `create index if not exists idx_shadow_research_requirements_org_created
     on pilot.shadow_research_requirements(organization_id, created_at desc)`,
  );

  ensured = true;
}

export async function createShadowResearchRequirement(input: ShadowResearchRequirementInput): Promise<number> {
  await ensureShadowResearchTable();

  const row = await queryOne<{ research_requirement_id: number }>(
    `insert into pilot.shadow_research_requirements
     (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement, knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state, created_by_account_id, created_by_role, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
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

export async function listShadowResearchRequirements(organizationId: string, status?: 'open' | 'resolved'): Promise<ShadowResearchRequirementRow[]> {
  await ensureShadowResearchTable();

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
     order by created_at desc`,
    [organizationId, status ?? null],
  );
}

export async function resolveShadowResearchRequirement(input: {
  organizationId: string;
  researchRequirementId: number;
  resolvedByAccountId: string;
  resolvedByRole: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  await ensureShadowResearchTable();

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
     returning research_requirement_id`,
    [input.organizationId, input.researchRequirementId, JSON.stringify({
      resolved_by_account_id: input.resolvedByAccountId,
      resolved_by_role: input.resolvedByRole,
      ...(input.metadata ?? {}),
    })],
  );

  return rows.length > 0;
}