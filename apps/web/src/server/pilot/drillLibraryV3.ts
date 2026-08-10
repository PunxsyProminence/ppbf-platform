import { query, queryOne } from './db';

// pilot.drill_library, pilot.drill_scale_levels, pilot.drill_stop_rules and
// pilot.drill_cues are owned by
// infra/azure/pilot_slice_postgres_drill_library_v3_migration.sql, applied
// through the apply-migrations workflow like every other table. Nothing here
// issues DDL.
//
// READ-ONLY MODULE. The migration's own header notes that a change-proposal
// review lifecycle for this library (mirroring drillVersioning.ts for
// pilot.drills) is a reasonable future consolidation, not attempted in this
// pass -- so there is no write path here beyond what seed-drill-library.mjs
// does directly. Every field is draft content (see field_provenance and
// content_class below) until a coach validates it on the floor; this module
// exists to surface that content for review, not to mutate it.

export type DrillScaleLevel = 'A' | 'B' | 'C';

export interface DrillLibraryRow {
  organization_id: string;
  drill_id: string;
  lineage_id: string;
  version: number;
  supersedes_drill_id: string | null;
  superseded_at: string | null;
  name: string;
  discipline: string;
  category: string;
  difficulty: string;
  skill_id: string | null;
  target_behavior: string;
  purpose: string;
  standard_setup: string;
  execution: string;
  what_good_looks_like: string;
  what_bad_looks_like: string;
  common_errors: string;
  corrections: string;
  transfer: string;
  contact_level: string;
  equipment_needed: string;
  requires_coach_authorization: boolean;
  content_class: string;
  source_ref: string | null;
  grounding_claim_ids: string[];
  field_provenance: string;
  active: boolean;
  created_by_account_id: string | null;
  created_by_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface DrillScaleLevelRow {
  organization_id: string;
  scale_id: string;
  drill_id: string;
  scale_level: DrillScaleLevel;
  is_starting_point: boolean;
  demand_description: string;
  constraint_applied: string;
  contact_level: string;
  coach_watch_point: string;
  authoring_state: string;
}

export interface DrillStopRuleRow {
  organization_id: string;
  stop_rule_id: string;
  drill_id: string;
  ordinal: number;
  condition_text: string;
  scope: 'universal' | 'drill_specific';
  rule_kind: string;
}

export interface DrillCueRow {
  organization_id: string;
  cue_id: string;
  drill_id: string;
  cue_text: string;
  cue_family: string;
  focus_type: string;
  evidence_note: string;
  source_ref: string | null;
}

export interface DrillWithDetail extends DrillLibraryRow {
  scale_levels: DrillScaleLevelRow[];
  stop_rules: DrillStopRuleRow[];
  cues: DrillCueRow[];
}

const DRILL_FIELDS =
  'organization_id, drill_id, lineage_id, version, supersedes_drill_id, superseded_at, name, '
  + 'discipline, category, difficulty, skill_id, target_behavior, purpose, standard_setup, execution, '
  + 'what_good_looks_like, what_bad_looks_like, common_errors, corrections, transfer, contact_level, '
  + 'equipment_needed, requires_coach_authorization, content_class, source_ref, grounding_claim_ids, '
  + 'field_provenance, active, created_by_account_id, created_by_role, created_at, updated_at';

const SCALE_FIELDS =
  'organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description, '
  + 'constraint_applied, contact_level, coach_watch_point, authoring_state';

const STOP_RULE_FIELDS = 'organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind';

const CUE_FIELDS = 'organization_id, cue_id, drill_id, cue_text, cue_family, focus_type, evidence_note, source_ref';

/**
 * The coach-facing browse list: active drills only, filterable by the axes a
 * coach actually plans around. difficulty here is the authoring-time
 * prerequisite band (see the migration's two-axes note) -- it is NOT a scale
 * filter. Scale level is a per-running choice, not a library-browse filter,
 * so it has no parameter here.
 */
export async function listDrillLibrary(
  organizationId: string,
  filter: { discipline?: string; category?: string; difficulty?: string; skillId?: string } = {},
): Promise<DrillLibraryRow[]> {
  return query<DrillLibraryRow>(
    `select ${DRILL_FIELDS}
     from pilot.drill_library
     where organization_id = $1
       and active
       and ($2::text is null or discipline = $2)
       and ($3::text is null or category = $3)
       and ($4::text is null or difficulty = $4)
       and ($5::text is null or skill_id = $5)
     order by discipline, category, name`,
    [organizationId, filter.discipline ?? null, filter.category ?? null, filter.difficulty ?? null, filter.skillId ?? null],
  );
}

/** One drill plus its A/B/C scale rows, stop rules, and cues -- the full detail a coach needs to run it. */
export async function getDrillWithDetail(organizationId: string, drillId: string): Promise<DrillWithDetail | null> {
  const drill = await queryOne<DrillLibraryRow>(
    `select ${DRILL_FIELDS} from pilot.drill_library where organization_id = $1 and drill_id = $2`,
    [organizationId, drillId],
  );
  if (!drill) {
    return null;
  }

  const [scaleLevels, stopRules, cues] = await Promise.all([
    query<DrillScaleLevelRow>(
      `select ${SCALE_FIELDS} from pilot.drill_scale_levels
       where organization_id = $1 and drill_id = $2
       order by scale_level`,
      [organizationId, drillId],
    ),
    query<DrillStopRuleRow>(
      `select ${STOP_RULE_FIELDS} from pilot.drill_stop_rules
       where organization_id = $1 and drill_id = $2
       order by ordinal`,
      [organizationId, drillId],
    ),
    query<DrillCueRow>(
      `select ${CUE_FIELDS} from pilot.drill_cues where organization_id = $1 and drill_id = $2`,
      [organizationId, drillId],
    ),
  ]);

  return { ...drill, scale_levels: scaleLevels, stop_rules: stopRules, cues };
}

/** Every version of one drill lineage, oldest first -- mirrors drillVersioning.ts's getDrillLineage. */
export async function getDrillLibraryLineage(organizationId: string, lineageId: string): Promise<DrillLibraryRow[]> {
  return query<DrillLibraryRow>(
    `select ${DRILL_FIELDS}
     from pilot.drill_library
     where organization_id = $1 and lineage_id = $2
     order by version asc`,
    [organizationId, lineageId],
  );
}
