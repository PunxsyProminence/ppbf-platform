-- PPBF/SHADOW research intake — triage view for the seeded research requirement backlog
-- Generated 2026-08-07 by the PPBF research program. PROPOSED — review before applying.
-- Read-only view. Creates no tables and modifies no data.
--
-- Purpose: 229 seeded requirements is too many to work from raw. This view ranks them so a
-- human reviewer sees what actually blocks a capability first, and can ignore the long tail
-- until the blocking set is closed.
--
-- Priority bands (documented, not tuned):
--   1 BLOCKING_SAFETY      gap sits under a safety-critical capability where a wrong answer can hurt someone
--   2 BLOCKING_CAPABILITY  capability is 'partial' or 'uncovered' and this gap is a reason why
--   3 CONFLICT_VISIBLE     contested evidence a coach could encounter in normal use
--   4 PARAMETER            a TBD value PPBF must derive from its own data
--   5 BACKLOG              everything else

create or replace view pilot.v_shadow_research_triage as
with safety_caps as (
  select unnest(array[
    'safeguarding_boundaries','injury_head_impact_risk','weight_management_safety',
    'emergency_medical_response','staffing_supervision_ratios','hand_wrapping_sop',
    'regulatory_eligibility_reference','hygiene_infection_control'
  ]) as capability_key
)
select
  r.research_requirement_id,
  r.organization_id,
  r.metadata->>'gap_type'        as gap_type,
  r.metadata->>'capability_key'  as capability_key,
  r.metadata->>'track'           as research_track,
  r.metadata->>'topic'           as topic,
  r.evidence_label,
  r.source_confidence_tier,
  r.metadata->>'boxing_specificity' as boxing_specificity,
  cm.coverage_state,
  case
    when sc.capability_key is not null                      then '1_BLOCKING_SAFETY'
    when cm.coverage_state in ('partial','uncovered')       then '2_BLOCKING_CAPABILITY'
    when r.metadata->>'gap_type' = 'evidence_conflicted'    then '3_CONFLICT_VISIBLE'
    when r.metadata->>'gap_type' = 'parameter_undefined'    then '4_PARAMETER'
    else '5_BACKLOG'
  end as triage_band,
  r.research_requirement,
  r.knowledge_gap,
  r.source_entity_id  as claim_id,
  r.status,
  r.created_at
from pilot.shadow_research_requirements r
left join pilot.shadow_library_capability_map cm
  on cm.organization_id = r.organization_id
 and cm.capability_key  = r.metadata->>'capability_key'
left join safety_caps sc
  on sc.capability_key  = r.metadata->>'capability_key'
where r.status = 'open'
order by triage_band asc, cm.coverage_state asc nulls last, r.created_at asc;

comment on view pilot.v_shadow_research_triage is
  'Triage ranking over open SHADOW research requirements seeded from the PPBF research program (2026-08-07). Read-only.';
