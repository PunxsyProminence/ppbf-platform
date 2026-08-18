-- Capability-network audit (Research Intelligence cluster): give
-- pilot.shadow_research_requirements a dedicated subject_id column, mirroring
-- pilot.shadow_library_documents.subject_id exactly -- text, nullable, NO
-- foreign key (unlike pilot.shadow_jobs.subject_id and
-- pilot.shadow_evidence_bundles.subject_id, which both carry
-- `foreign key (organization_id, subject_id) references pilot.athletes(...)`).
-- No FK here for the same reason the library table has none: a research
-- requirement can legitimately be about an athlete who has since left the
-- roster, and the row should stay legible rather than being orphaned or
-- blocked by a cascading delete.
--
-- WHAT THIS REPLACES
--
-- listShadowResearchRequirements and resolveShadowResearchRequirement scoped
-- a row to a parent's linked athlete with a 3-field OR heuristic --
-- source_entity_id = any(...) or evidence_label = any(...) or
-- metadata->>'subject_id' = any(...) -- because no column actually named the
-- subject. That heuristic only ever matched by accident: the SHADOW Library
-- claim-gap flow (shadowLibrary.ts's ensureClaimResearchRequirement) is the
-- one writer that put a real athlete id into evidence_label/metadata.subject_id;
-- every other writer's source_entity_id/evidence_label hold a different kind
-- of value entirely (an intake-case id, a document-classification label, a
-- capability key, a learning-loop message id). Three of those writers --
-- reject/approve/promote in app/api/pilot/intake/review-action/route.ts --
-- already hold the athlete id at write time and stored it as
-- metadata.athlete_id, which the heuristic never read (it reads
-- metadata->>'subject_id'), so those rows were never actually reachable by a
-- parent's athlete-scoped filter. This migration's application-code
-- companion fixes that by having those three call sites populate the new
-- column with the athlete id they already hold.
--
-- Idempotent: add column if not exists, guarded backfill, no drops.

alter table pilot.shadow_research_requirements
  add column if not exists subject_id text null;

-- One-time backfill. A blind coalesce of the three legacy fields would be
-- wrong: source_entity_id and evidence_label hold non-athlete values at every
-- creation site except the SHADOW Library claim-gap flow, so tagging every
-- row with whichever of the three happens to be non-null would carry the same
-- unreliability forward under a new column name. Instead, backfill only when
-- a candidate value is an id that actually exists as an athlete in the row's
-- own organization -- this reproduces exactly what the old heuristic could
-- ever correctly have matched, checked in priority order: metadata.subject_id
-- (explicit, from the claim flow) first, then evidence_label, then
-- source_entity_id. Everything else backfills to NULL, which is correct: an
-- org-wide capability-gap row, an upload-classification row, or a
-- learning-loop row is not about any one athlete.
update pilot.shadow_research_requirements r
set subject_id = candidate.matched_athlete_id
from (
  select
    rr.research_requirement_id,
    coalesce(
      matched_meta.athlete_id,
      matched_label.athlete_id,
      matched_entity.athlete_id
    ) as matched_athlete_id
  from pilot.shadow_research_requirements rr
  left join pilot.athletes matched_meta
    on matched_meta.organization_id = rr.organization_id
   and matched_meta.athlete_id = nullif(rr.metadata->>'subject_id', '')
  left join pilot.athletes matched_label
    on matched_label.organization_id = rr.organization_id
   and matched_label.athlete_id = nullif(rr.evidence_label, '')
  left join pilot.athletes matched_entity
    on matched_entity.organization_id = rr.organization_id
   and matched_entity.athlete_id = rr.source_entity_id
) candidate
where r.research_requirement_id = candidate.research_requirement_id
  and r.subject_id is null
  and candidate.matched_athlete_id is not null;
