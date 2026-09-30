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
//
// AN ITEM KEEPS THE DRILL VERSION IT WAS WRITTEN AGAINST. item.drill_id
// names one exact pilot.drill_library row, and a revised drill is a new row
// in the same lineage (drill_library v3 migration :86-89), so a template can
// point at a drill that has since been revised. The item is NOT repointed:
// the template was authored against that version, and silently swapping the
// drill under it is the in-place edit versioning exists to prevent. Instead
// the read reports, per item, the lineage's head and whether the item is
// behind it, so the coach sees it and decides.

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

/**
 * An item as the detail read returns it: the stored row plus where its drill
 * stands in its lineage. Derived on every read (nothing stored), so it cannot
 * drift from the drill rows it describes.
 *
 *   head_drill_id             the highest version in the item's drill lineage;
 *                             equal to drill_id when the item is current. Null
 *                             for a free-text item, which has no lineage.
 *   uses_older_drill_version  true when a higher version of the item's drill
 *                             exists. Always false for a free-text item.
 */
export interface WorkoutTemplateItemWithDrillHead extends WorkoutTemplateItemRow {
  head_drill_id: string | null;
  uses_older_drill_version: boolean;
}

const TEMPLATE_FIELDS =
  'organization_id, template_id, lineage_id, version, supersedes_template_id, superseded_at, name, '
  + 'session_type, difficulty, age_band, duration_minutes, intent, coach_notes, requires_coach_authorization, '
  + 'active, created_by_account_id, created_by_role, created_at, updated_at';

const ITEM_FIELDS =
  'organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill, scale_level, '
  + 'duration_minutes, rep_count, contact_level, coach_note, created_at';

// The same columns qualified to the item alias, because the detail read joins
// pilot.drill_library, which also has organization_id, drill_id,
// contact_level and created_at -- a bare column would be ambiguous.
const ITEM_FIELDS_QUALIFIED = ITEM_FIELDS.split(', ').map((field) => `i.${field}`).join(', ');

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
  items: WorkoutTemplateItemWithDrillHead[];
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

  // HEAD = the highest version in the lineage, the rule drillLibraryV3.ts's
  // listReferenceLifecycles already uses for "the adopted lineage's HEAD".
  // Not superseded_at: that column is set by whoever loads the revision, and
  // a comparison of versions cannot be left out of step with the rows. Not
  // filtered on active either: active means "not withdrawn", a separate axis
  // from superseded (drillAdoptionReadiness.ts:51-52), so it says nothing
  // about which version is newest.
  //
  // The lateral join is scoped to the item's own organization at both hops,
  // so a lineage id shared with another gym can never supply the head.
  const items = await query<WorkoutTemplateItemWithDrillHead>(
    `select ${ITEM_FIELDS_QUALIFIED},
            head.drill_id as head_drill_id,
            coalesce(head.drill_id <> i.drill_id, false) as uses_older_drill_version
     from pilot.workout_template_items i
     left join pilot.drill_library pinned
       on pinned.organization_id = i.organization_id
      and pinned.drill_id = i.drill_id
     left join lateral (
       select h.drill_id
       from pilot.drill_library h
       where h.organization_id = pinned.organization_id
         and h.lineage_id = pinned.lineage_id
       order by h.version desc
       limit 1
     ) head on true
     where i.organization_id = $1 and i.template_id = $2
     order by i.ordinal asc`,
    [organizationId, templateId],
  );

  return { template, items };
}
