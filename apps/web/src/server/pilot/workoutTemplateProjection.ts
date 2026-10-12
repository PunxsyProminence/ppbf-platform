import type { PilotRole } from './contracts';
import { roleEquals } from './roleAlias';
import type {
  WorkoutTemplateItemWithDrillHead,
  WorkoutTemplateRow,
  WorkoutTemplateWithItems,
} from './workoutTemplates';

// WHAT A READER RECEIVES OF A WORKOUT TEMPLATE (issue #1475, lane P2b).
//
// GET /api/pilot/workout-templates admits the eight coaching-content reader
// roles (coachingContentAccess.ts) and used to hand all eight the stored rows.
// A stored row carries created_by_account_id -- a staff account id, which for a
// provisioned staff account is the sign-in email -- with created_by_role and
// the coach's free-text coach_notes, and each item carries coach_note. An
// athlete signed in to the live app received all of them.
//
// OD-2026-10-06-025 ruling 2: families see a coach's display name, never the
// internal account id. No family screen reads this route today, so nothing is
// put in the id's place.
//
// The coach's other free text goes with it (Jason, 2026-10-12: "strip them"):
// a template's intent and an item's free_text_drill are also typed by a coach.
//
// Only the types are imported from workoutTemplates.ts, so this file does not
// load that module (or anything it imports) at runtime.

/**
 * The readers who receive the stored rows as they are: a coach and an
 * organization admin (roleEquals carries the legacy 'admin' row name). Every
 * other admitted role -- athlete, parent, volunteer, staff, platform owner --
 * receives the projection below.
 */
export function readsFullWorkoutTemplates(role: PilotRole): boolean {
  return roleEquals(role, 'coach') || roleEquals(role, 'organization_admin');
}

/**
 * AN EXPLICIT ALLOW-LIST, not Omit<> or a destructured rest (the
 * projectAnnouncementForBoard rule): a column added to the template or to an
 * item later is withheld from these readers until someone names it here.
 */
export type ReaderVisibleWorkoutTemplate = Pick<
  WorkoutTemplateRow,
  | 'organization_id'
  | 'template_id'
  | 'lineage_id'
  | 'version'
  | 'supersedes_template_id'
  | 'superseded_at'
  | 'name'
  | 'session_type'
  | 'difficulty'
  | 'age_band'
  | 'duration_minutes'
  | 'requires_coach_authorization'
  | 'active'
  | 'created_at'
  | 'updated_at'
>;

export type ReaderVisibleWorkoutTemplateItem = Pick<
  WorkoutTemplateItemWithDrillHead,
  | 'organization_id'
  | 'item_id'
  | 'template_id'
  | 'ordinal'
  | 'block'
  | 'drill_id'
  | 'scale_level'
  | 'duration_minutes'
  | 'rep_count'
  | 'contact_level'
  | 'created_at'
  | 'head_drill_id'
  | 'head_drill_name'
  | 'uses_older_drill_version'
>;

export interface ReaderVisibleWorkoutTemplateWithItems {
  template: ReaderVisibleWorkoutTemplate;
  items: ReaderVisibleWorkoutTemplateItem[];
}

function projectTemplate(template: WorkoutTemplateRow): ReaderVisibleWorkoutTemplate {
  return {
    organization_id: template.organization_id,
    template_id: template.template_id,
    lineage_id: template.lineage_id,
    version: template.version,
    supersedes_template_id: template.supersedes_template_id,
    superseded_at: template.superseded_at,
    name: template.name,
    session_type: template.session_type,
    difficulty: template.difficulty,
    age_band: template.age_band,
    duration_minutes: template.duration_minutes,
    requires_coach_authorization: template.requires_coach_authorization,
    active: template.active,
    created_at: template.created_at,
    updated_at: template.updated_at,
  };
}

function projectItem(item: WorkoutTemplateItemWithDrillHead): ReaderVisibleWorkoutTemplateItem {
  return {
    organization_id: item.organization_id,
    item_id: item.item_id,
    template_id: item.template_id,
    ordinal: item.ordinal,
    block: item.block,
    drill_id: item.drill_id,
    scale_level: item.scale_level,
    duration_minutes: item.duration_minutes,
    rep_count: item.rep_count,
    contact_level: item.contact_level,
    created_at: item.created_at,
    head_drill_id: item.head_drill_id,
    head_drill_name: item.head_drill_name,
    uses_older_drill_version: item.uses_older_drill_version,
  };
}

/** The list read. A coach or organization admin gets the same array back. */
export function projectWorkoutTemplatesForReader(
  role: PilotRole,
  templates: WorkoutTemplateRow[],
): WorkoutTemplateRow[] | ReaderVisibleWorkoutTemplate[] {
  return readsFullWorkoutTemplates(role) ? templates : templates.map(projectTemplate);
}

/**
 * The detail read. A coach or organization admin gets the same object back,
 * with whatever keys the read put beside `template` and `items`; every other
 * reader gets those two keys and nothing else.
 */
export function projectWorkoutTemplateDetailForReader(
  role: PilotRole,
  detail: WorkoutTemplateWithItems,
): WorkoutTemplateWithItems | ReaderVisibleWorkoutTemplateWithItems {
  if (readsFullWorkoutTemplates(role)) {
    return detail;
  }
  return { template: projectTemplate(detail.template), items: detail.items.map(projectItem) };
}
