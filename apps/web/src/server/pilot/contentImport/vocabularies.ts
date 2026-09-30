// Every allowed-value list and numeric bound the content-import specs check,
// copied from the database CHECK constraints that will enforce them at load.
//
// WHY A COPY AND NOT A QUERY. The validator runs with no database at all
// (npm run content:validate on a hand-off folder), so it cannot ask Postgres.
// Checking here means an unknown value is refused while Jason's files are still
// on the table, not as a 23514 half way through a seed run (the old loaders
// passed values straight through: the retired seed-drill-library.mjs).
//
// A COPY DRIFTS, SO EACH ENTRY NAMES WHAT IT MIRRORS. contentImportVocabularies
// .pg.test.ts builds the full migrated schema and compares every list below
// with pg_get_constraintdef of the named constraint, in both directions. A
// widened CHECK that is not copied here, or a value added here that the
// database would refuse, fails that suite.

export interface ConstraintRef {
  table: string;
  constraint: string;
}

export interface Vocabulary {
  values: readonly string[];
  /** The database constraints whose literal lists must equal `values`. */
  mirrors: readonly ConstraintRef[];
  /** Set when the list lives in a view rather than a CHECK. */
  viewMirror?: { view: string };
}

function vocab(values: readonly string[], mirrors: ConstraintRef[], viewMirror?: { view: string }): Vocabulary {
  return { values, mirrors, viewMirror };
}

export const VOCABULARIES = {
  // drill_library_v3 :244-248 (named); workout_templates_v2 :111-114 (named).
  // drill_scale_levels.contact_level and session_script_blocks.contact_level
  // carry NO check (v3 :156, session_scripts :89), but they hold the same
  // concept, so the specs apply this list there too rather than let a typo
  // such as 'light-technical' load silently.
  contact_level: vocab(
    ['none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring'],
    [
      { table: 'drill_library', constraint: 'pilot_drill_library_contact_check' },
      { table: 'workout_template_items', constraint: 'pilot_wti_contact_level_check' },
    ],
  ),
  // competence_cohorts :123-124. Narrower than contact_level on purpose: a
  // cohort never permits 'conditioned' contact.
  cohort_contact_permitted: vocab(
    ['none', 'light_technical', 'controlled_sparring', 'open_sparring'],
    [{ table: 'cohort_definitions', constraint: 'cohort_definitions_contact_permitted_check' }],
  ),
  difficulty: vocab(
    ['beginner', 'intermediate', 'advanced', 'elite'],
    [
      { table: 'drill_library', constraint: 'pilot_drill_library_difficulty_check' },
      { table: 'workout_templates', constraint: 'pilot_workout_templates_difficulty_check' },
    ],
  ),
  scale_level: vocab(
    ['A', 'B', 'C'],
    [
      { table: 'drill_scale_levels', constraint: 'drill_scale_levels_scale_level_check' },
      { table: 'workout_template_items', constraint: 'workout_template_items_scale_level_check' },
      { table: 'session_script_blocks', constraint: 'session_script_blocks_scale_level_check' },
      { table: 'competence_levels', constraint: 'competence_levels_typical_scale_check' },
    ],
  ),
  // Widened by drill_vocabulary_widening (:59-61) after v3 created it with two values.
  scale_authoring_state: vocab(
    ['authored', 'scaffold_needs_coach_review', 'literature_grounded_draft'],
    [{ table: 'drill_scale_levels', constraint: 'pilot_drill_scale_authoring_state_check' }],
  ),
  stop_rule_scope: vocab(
    ['universal', 'drill_specific'],
    [{ table: 'drill_stop_rules', constraint: 'drill_stop_rules_scope_check' }],
  ),
  // warmup_decay arrived with drill_vocabulary_widening (:89-92).
  stop_rule_kind: vocab(
    ['technique_degradation', 'fatigue', 'safety', 'intent_drift', 'coach_judgment', 'warmup_decay'],
    [{ table: 'drill_stop_rules', constraint: 'pilot_drill_stop_rule_kind_check' }],
  ),
  cue_focus_type: vocab(
    ['external', 'internal', 'analogy', 'constraint', 'unspecified'],
    [{ table: 'drill_cues', constraint: 'drill_cues_focus_type_check' }],
  ),
  // drill_library_v3 :266-273. Matched as exact strings (em dashes included):
  // the check compares text, so a paraphrase is a refusal.
  field_provenance: vocab(
    [
      'PPBF source manual v3',
      'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION',
      'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION',
    ],
    [{ table: 'drill_library', constraint: 'pilot_drill_library_field_provenance_check' }],
  ),
  discipline_lane: vocab(
    ['striking', 'grappling', 'mixed', 'non_contact'],
    [{ table: 'disciplines', constraint: 'disciplines_lane_check' }],
  ),
  exposure_model: vocab(
    ['head_impact', 'positional_grappling', 'mixed_contact', 'none'],
    [{ table: 'disciplines', constraint: 'disciplines_exposure_model_check' }],
  ),
  // cohort_definitions.required_domains is free text in the database (a
  // ','-separated list, competence_cohorts :115), so the list it is read
  // against is athlete_competence.domain's CHECK -- competenceCohorts.ts:266
  // compares the two. COMPETENCE_DOMAINS in competenceCohorts.ts is a third
  // copy; contentImportValidate.test.ts holds it equal to this one.
  competence_domain: vocab(
    [
      'stance_base', 'footwork', 'offense', 'defense', 'distance_timing',
      'decision_making', 'composure', 'conditioning', 'ring_craft', 'partner_control',
    ],
    [{ table: 'athlete_competence', constraint: 'athlete_competence_domain_check' }],
  ),
  // tenure_bands (competenceCohorts.ts:300) are compared with the band
  // pilot.v_athlete_tenure DERIVES (competence_cohorts :88-94). There is no
  // CHECK to mirror; the pg suite reads the view definition instead.
  tenure_band: vocab(
    ['insufficient_history', 'introduction', 'fundamentals', 'development', 'established'],
    [],
    { view: 'v_athlete_tenure' },
  ),
  script_contact_structure: vocab(
    ['non_contact', 'contact', 'split_non_contact_then_contact', 'observation_only'],
    [{ table: 'session_scripts', constraint: 'session_scripts_contact_structure_check' }],
  ),
  script_authoring_state: vocab(
    ['draft', 'coach_reviewed', 'in_use', 'retired'],
    [{ table: 'session_scripts', constraint: 'session_scripts_authoring_state_check' }],
  ),
  block_kind: vocab(
    [
      'arrival', 'instruction', 'demonstration', 'drill_round', 'reset_minute',
      'teaching_minute', 'transition', 'conditioning', 'reflection', 'close',
    ],
    [{ table: 'session_script_blocks', constraint: 'session_script_blocks_block_kind_check' }],
  ),
  rendering_format: vocab(
    ['cheat_sheet', 'class_plan', 'instructor_script', 'class_flow', 'athlete_handout', 'parent_summary'],
    [{ table: 'session_script_renderings', constraint: 'session_script_renderings_format_check' }],
  ),
  claim_kind: vocab(
    ['neuro_mechanism', 'life_skill_transfer', 'cognitive_demand', 'emotional_regulation'],
    [{ table: 'transfer_claims', constraint: 'transfer_claims_claim_kind_check' }],
  ),
  transfer_evidence_class: vocab(
    ['EVIDENCE-SUPPORTED', 'MECHANISM-THEORISED', 'COACHING INTENT', 'CONTESTED', 'INSUFFICIENT EVIDENCE'],
    [{ table: 'transfer_claims', constraint: 'transfer_claims_evidence_class_check' }],
  ),
  assessment_measure_kind: vocab(
    ['physical_test', 'skill_rubric', 'wellness', 'questionnaire', 'other'],
    [{ table: 'assessment_protocols', constraint: 'assessment_protocols_measure_kind_check' }],
  ),
} as const satisfies Record<string, Vocabulary>;

export type VocabularyName = keyof typeof VOCABULARIES;

/**
 * A numeric CHECK, in the database's own terms (`> 0` stays `gt: 0` rather
 * than becoming `min: 1`) so the pg suite can compare it with
 * pg_get_constraintdef without a translation step that could itself be wrong.
 */
export interface NumericBound {
  gt?: number;
  gte?: number;
  lte?: number;
  mirrors: readonly (ConstraintRef & { column: string })[];
}

export const BOUNDS = {
  positive: {
    gt: 0,
    mirrors: [
      { table: 'drill_stop_rules', constraint: 'drill_stop_rules_ordinal_check', column: 'ordinal' },
      { table: 'workout_template_items', constraint: 'workout_template_items_ordinal_check', column: 'ordinal' },
      { table: 'workout_template_items', constraint: 'workout_template_items_rep_count_check', column: 'rep_count' },
      { table: 'session_script_blocks', constraint: 'session_script_blocks_block_order_check', column: 'block_order' },
      { table: 'assessment_protocols', constraint: 'assessment_protocols_retest_interval_days_check', column: 'retest_interval_days' },
      {
        table: 'assessment_protocols',
        constraint: 'assessment_protocols_retest_after_training_hours_check',
        column: 'retest_after_training_hours',
      },
    ],
  },
  template_duration_minutes: {
    gte: 15,
    lte: 180,
    mirrors: [{ table: 'workout_templates', constraint: 'workout_templates_duration_minutes_check', column: 'duration_minutes' }],
  },
  template_item_duration_minutes: {
    gte: 1,
    lte: 90,
    mirrors: [
      { table: 'workout_template_items', constraint: 'workout_template_items_duration_minutes_check', column: 'duration_minutes' },
    ],
  },
  script_total_minutes: {
    gte: 10,
    lte: 300,
    mirrors: [{ table: 'session_scripts', constraint: 'session_scripts_total_minutes_check', column: 'total_minutes' }],
  },
  block_start_offset: {
    gte: 0,
    mirrors: [
      { table: 'session_script_blocks', constraint: 'session_script_blocks_start_offset_min_check', column: 'start_offset_min' },
    ],
  },
} as const satisfies Record<string, NumericBound>;

export type BoundName = keyof typeof BOUNDS;

export function vocabularyValues(name: VocabularyName): readonly string[] {
  return VOCABULARIES[name].values;
}
