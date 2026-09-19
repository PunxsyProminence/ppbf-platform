// One conceptual drill structure for every audience (OD-2026-09-19-001).
//
// The athlete and coach detail responses are different shapes on purpose --
// the athlete one is a constructive projection with provenance removed -- and
// both are normalised into this one view so a single component renders them.
// Type-only imports: nothing server-side reaches the client bundle.

import type { AthleteDrillDetail, DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';

export interface DrillScaleView {
  level: string;
  isStartingPoint: boolean;
  demand: string;
  constraint: string;
  contactLevel: string;
  /** Coach-voiced ("Is the athlete repeating..."), so rendered for coaches only. */
  watchPoint: string;
  /** Coach-only: 'authored' vs a draft state. Empty on an athlete view. */
  authoringState: string;
}

export interface DrillStopRuleView {
  ordinal: number;
  text: string;
  scope: 'universal' | 'drill_specific';
  kind: string;
}

/** Coach-only decision context. Absent entirely on an athlete view. */
export interface DrillCoachContext {
  discipline: string;
  category: string;
  difficulty: string;
  skillId: string | null;
  secondarySkills: string[];
  targetBehavior: string;
  transfer: string;
  version: number;
  lineageId: string;
  supersedesDrillId: string | null;
  supersededAt: string | null;
  active: boolean;
  fieldProvenance: string;
  contentClass: string;
  sourceRef: string | null;
  groundingClaimIds: string[];
}

export interface DrillDetailView {
  id: string;
  name: string;
  purpose: string;
  setup: string;
  equipment: string;
  execution: string;
  good: string;
  bad: string;
  commonErrors: string;
  corrections: string;
  contactLevel: string;
  requiresCoachAuthorization: boolean;
  cues: string[];
  scaleLevels: DrillScaleView[];
  stopRules: DrillStopRuleView[];
  coach: DrillCoachContext | null;
}

export function fromAthleteDrillDetail(drill: AthleteDrillDetail): DrillDetailView {
  return {
    id: drill.drill_id,
    name: drill.name,
    purpose: drill.purpose ?? '',
    setup: drill.setup ?? '',
    equipment: drill.equipment_needed ?? '',
    execution: drill.execution ?? '',
    good: drill.what_good_looks_like ?? '',
    bad: drill.what_bad_looks_like ?? '',
    commonErrors: drill.common_errors ?? '',
    corrections: drill.corrections ?? '',
    contactLevel: drill.contact_level,
    requiresCoachAuthorization: Boolean(drill.requires_coach_authorization),
    cues: drill.cues ?? [],
    scaleLevels: (drill.scale_levels ?? []).map((level) => ({
      level: level.scale_level,
      isStartingPoint: level.is_starting_point,
      demand: level.demand_description ?? '',
      constraint: level.constraint_applied ?? '',
      contactLevel: level.contact_level ?? '',
      watchPoint: level.coach_watch_point ?? '',
      authoringState: '',
    })),
    stopRules: (drill.stop_rules ?? []).map((rule) => ({
      ordinal: rule.ordinal,
      text: rule.condition_text,
      scope: rule.scope,
      kind: rule.rule_kind,
    })),
    coach: null,
  };
}

export function fromCoachDrillDetail(drill: DrillWithDetail): DrillDetailView {
  // The coach cue read has no ORDER BY, so its order is whatever Postgres
  // returns. Sorted the way the athlete read is, so the two audiences see one
  // order and it does not change between loads.
  const cues = [...(drill.cues ?? [])]
    .sort((a, b) => a.cue_family.localeCompare(b.cue_family) || a.cue_text.localeCompare(b.cue_text))
    .map((cue) => cue.cue_text);

  return {
    id: drill.drill_id,
    name: drill.name,
    purpose: drill.purpose ?? '',
    setup: drill.standard_setup ?? '',
    equipment: drill.equipment_needed ?? '',
    execution: drill.execution ?? '',
    good: drill.what_good_looks_like ?? '',
    bad: drill.what_bad_looks_like ?? '',
    commonErrors: drill.common_errors ?? '',
    corrections: drill.corrections ?? '',
    contactLevel: drill.contact_level,
    requiresCoachAuthorization: Boolean(drill.requires_coach_authorization),
    cues,
    scaleLevels: (drill.scale_levels ?? []).map((level) => ({
      level: level.scale_level,
      isStartingPoint: level.is_starting_point,
      demand: level.demand_description ?? '',
      constraint: level.constraint_applied ?? '',
      contactLevel: level.contact_level ?? '',
      watchPoint: level.coach_watch_point ?? '',
      authoringState: level.authoring_state ?? '',
    })),
    stopRules: (drill.stop_rules ?? []).map((rule) => ({
      ordinal: rule.ordinal,
      text: rule.condition_text,
      scope: rule.scope,
      kind: rule.rule_kind,
    })),
    coach: {
      discipline: drill.discipline,
      category: drill.category,
      difficulty: drill.difficulty,
      skillId: drill.skill_id,
      secondarySkills: (drill.secondary_skills ?? []).map((row) => row.skill_id),
      targetBehavior: drill.target_behavior ?? '',
      transfer: drill.transfer ?? '',
      version: drill.version,
      lineageId: drill.lineage_id,
      supersedesDrillId: drill.supersedes_drill_id,
      supersededAt: drill.superseded_at,
      active: drill.active,
      fieldProvenance: drill.field_provenance,
      contentClass: drill.content_class,
      sourceRef: drill.source_ref,
      groundingClaimIds: drill.grounding_claim_ids ?? [],
    },
  };
}
