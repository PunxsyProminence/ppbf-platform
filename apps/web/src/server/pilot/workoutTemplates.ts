import { query, queryOne } from './db';

// pilot.workout_templates and pilot.workout_template_items are owned by
// infra/azure/pilot_slice_postgres_workout_templates_v2_migration.sql,
// applied through the apply-migrations workflow like every other table.
// Nothing here issues DDL. Read-only, matching drillLibraryV3.ts's own
// design -- a change-proposal review lifecycle for templates is a
// reasonable future consolidation with drillVersioning.ts, not attempted
// here.
//
// SCALE LEVEL IS NEVER FORCED. getWorkoutTemplateWithItems returns each
// item's drill_id and its own scale_level PREFERENCE (nullable) as-is --
// it does not resolve or default a level. A caller wanting the full A/B/C
// detail for a specific drill calls drillLibraryV3.ts's
// getDrillWithDetail, which already returns all three levels together;
// this module does not duplicate that read.

export type WorkoutTemplateDifficulty = 'beginner' | 'intermediate' | 'advanced' | 'elite';
export type WorkoutTemplateItemScaleLevel = 'A' | 'B' | 'C';
export type WorkoutTemplateItemContactLevel =
  | 'none'
  | 'light_technical'
  | 'conditioned'
  | 'controlled_sparring'
  | 'open_sparring';

export interface WorkoutTemplateRow {
  organization_id: string;
  template_id: string;
  lineage_id: string;
  version: number;
  supersedes_template_id: string | null;
  superseded_at: string | null;
  name: string;
  session_type: string;
  difficulty: WorkoutTemplateDifficulty;
  age_band: string;
  duration_minutes: number;
  intent: string;
  coach_notes: string | null;
  requires_coach_authorization: boolean;
  active: boolean;
  created_by_account_id: string | null;
  created_by_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkoutTemplateItemRow {
  organization_id: string;
  item_id: string;
  template_id: string;
  ordinal: number;
  block: string;
  drill_id: string | null;
  free_text_drill: string | null;
  scale_level: WorkoutTemplateItemScaleLevel | null;
  duration_minutes: number | null;
  rep_count: number | null;
  contact_level: WorkoutTemplateItemContactLevel;
  coach_note: string | null;
  created_at: string;
}

const TEMPLATE_FIELDS =
  'organization_id, template_id, lineage_id, version, supersedes_template_id, superseded_at, name, '
  + 'session_type, difficulty, age_band, duration_minutes, intent, coach_notes, requires_coach_authorization, '
  + 'active, created_by_account_id, created_by_role, created_at, updated_at';

const ITEM_FIELDS =
  'organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill, scale_level, '
  + 'duration_minutes, rep_count, contact_level, coach_note, created_at';

export async function listWorkoutTemplates(
  organizationId: string,
  filter: { sessionType?: string; difficulty?: WorkoutTemplateDifficulty; ageBand?: string } = {},
): Promise<WorkoutTemplateRow[]> {
  return query<WorkoutTemplateRow>(
    `select ${TEMPLATE_FIELDS}
     from pilot.workout_templates
     where organization_id = $1
       and active
       and ($2::text is null or session_type = $2)
       and ($3::text is null or difficulty = $3)
       and ($4::text is null or age_band = $4)
     order by session_type, difficulty, name`,
    [organizationId, filter.sessionType ?? null, filter.difficulty ?? null, filter.ageBand ?? null],
  );
}

export interface WorkoutTemplateWithItems {
  template: WorkoutTemplateRow;
  items: WorkoutTemplateItemRow[];
}

export async function getWorkoutTemplateWithItems(
  organizationId: string,
  templateId: string,
): Promise<WorkoutTemplateWithItems | null> {
  const template = await queryOne<WorkoutTemplateRow>(
    `select ${TEMPLATE_FIELDS} from pilot.workout_templates where organization_id = $1 and template_id = $2`,
    [organizationId, templateId],
  );
  if (!template) {
    return null;
  }

  const items = await query<WorkoutTemplateItemRow>(
    `select ${ITEM_FIELDS} from pilot.workout_template_items
     where organization_id = $1 and template_id = $2
     order by ordinal asc`,
    [organizationId, templateId],
  );

  return { template, items };
}
