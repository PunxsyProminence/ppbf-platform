import type { PilotRole } from './contracts';
import { roleEquals } from './roleAlias';
import type {
  SessionScriptBlockRow,
  SessionScriptRenderingFormat,
  SessionScriptRenderingRow,
  SessionScriptRow,
  SessionScriptWithDetail,
} from './sessionScripts';

// WHAT A READER RECEIVES OF A SESSION SCRIPT (issue #1475, lane P2b).
//
// GET /api/pilot/session-scripts admits the eight coaching-content reader
// roles (coachingContentAccess.ts) and used to hand all eight the stored rows:
// created_by_account_id (a staff account id, which for a provisioned staff
// account is the sign-in email), source_document, coach_priorities and
// frequent_phrases, and on the detail read every block's coach-facing
// teaching text and every rendering's body.
//
// OD-2026-10-06-025 ruling 2: families see a coach's display name, never the
// internal account id. No family screen reads this route today, so nothing is
// put in the id's place, and the coach's teaching text is left out with it
// (Overwatch on #1475): what a family screen shows of a script is decided
// when one is built. The coach's other free text goes too (Jason, 2026-10-12:
// "strip them"): prerequisite_note, reset_protocol and each block's label.
//
// Only the types are imported from sessionScripts.ts, so this file does not
// load that module at runtime.

/**
 * The readers who receive the stored rows as they are: a coach and an
 * organization admin (roleEquals carries the legacy 'admin' row name). Every
 * other admitted role -- athlete, parent, volunteer, staff, platform owner --
 * receives the projection below.
 */
export function readsFullSessionScripts(role: PilotRole): boolean {
  return roleEquals(role, 'coach') || roleEquals(role, 'organization_admin');
}

/**
 * AN EXPLICIT ALLOW-LIST, not Omit<> or a destructured rest (the
 * projectAnnouncementForBoard rule): a column added to a script, a block or a
 * rendering later is withheld from these readers until someone names it here.
 */
export type ReaderVisibleSessionScript = Pick<
  SessionScriptRow,
  | 'organization_id'
  | 'script_id'
  | 'lineage_id'
  | 'version'
  | 'name'
  | 'discipline'
  | 'theme'
  | 'phase'
  | 'day_of_week'
  | 'total_minutes'
  | 'contact_structure'
  | 'target_group'
  | 'authoring_state'
  | 'created_at'
  | 'updated_at'
>;

// The running order without block_label or what_to_say, what_to_explain,
// what_to_watch and what_to_fix, which are the coach's own words for the floor.
export type ReaderVisibleSessionScriptBlock = Pick<
  SessionScriptBlockRow,
  | 'organization_id'
  | 'block_id'
  | 'script_id'
  | 'block_order'
  | 'start_offset_min'
  | 'end_offset_min'
  | 'block_kind'
  | 'drill_id'
  | 'scale_level'
  | 'contact_level'
>;

export type ReaderVisibleSessionScriptRendering =
  Pick<
    SessionScriptRenderingRow,
    'organization_id' | 'rendering_id' | 'script_id' | 'format' | 'generated_from_blocks' | 'created_at'
  >
  & Partial<Pick<SessionScriptRenderingRow, 'audience_note' | 'body'>>;

export interface ReaderVisibleSessionScriptWithDetail extends ReaderVisibleSessionScript {
  blocks: ReaderVisibleSessionScriptBlock[];
  renderings: ReaderVisibleSessionScriptRendering[];
}

/**
 * The two renderings written for a family. Their text is the point of them;
 * every other format (instructor_script, cheat_sheet, class_plan, class_flow,
 * and any format added later) is the coach's copy and keeps its row without
 * audience_note or body.
 */
const FAMILY_RENDERING_FORMATS: readonly SessionScriptRenderingFormat[] = ['athlete_handout', 'parent_summary'];

function projectScript(script: SessionScriptRow): ReaderVisibleSessionScript {
  return {
    organization_id: script.organization_id,
    script_id: script.script_id,
    lineage_id: script.lineage_id,
    version: script.version,
    name: script.name,
    discipline: script.discipline,
    theme: script.theme,
    phase: script.phase,
    day_of_week: script.day_of_week,
    total_minutes: script.total_minutes,
    contact_structure: script.contact_structure,
    target_group: script.target_group,
    authoring_state: script.authoring_state,
    created_at: script.created_at,
    updated_at: script.updated_at,
  };
}

function projectBlock(block: SessionScriptBlockRow): ReaderVisibleSessionScriptBlock {
  return {
    organization_id: block.organization_id,
    block_id: block.block_id,
    script_id: block.script_id,
    block_order: block.block_order,
    start_offset_min: block.start_offset_min,
    end_offset_min: block.end_offset_min,
    block_kind: block.block_kind,
    drill_id: block.drill_id,
    scale_level: block.scale_level,
    contact_level: block.contact_level,
  };
}

function projectRendering(rendering: SessionScriptRenderingRow): ReaderVisibleSessionScriptRendering {
  const row: ReaderVisibleSessionScriptRendering = {
    organization_id: rendering.organization_id,
    rendering_id: rendering.rendering_id,
    script_id: rendering.script_id,
    format: rendering.format,
    generated_from_blocks: rendering.generated_from_blocks,
    created_at: rendering.created_at,
  };
  if (FAMILY_RENDERING_FORMATS.includes(rendering.format)) {
    row.audience_note = rendering.audience_note;
    row.body = rendering.body;
  }
  return row;
}

/** The list read. A coach or organization admin gets the same array back. */
export function projectSessionScriptsForReader(
  role: PilotRole,
  scripts: SessionScriptRow[],
): SessionScriptRow[] | ReaderVisibleSessionScript[] {
  return readsFullSessionScripts(role) ? scripts : scripts.map(projectScript);
}

/** The detail read. A coach or organization admin gets the same object back. */
export function projectSessionScriptDetailForReader(
  role: PilotRole,
  script: SessionScriptWithDetail,
): SessionScriptWithDetail | ReaderVisibleSessionScriptWithDetail {
  if (readsFullSessionScripts(role)) {
    return script;
  }
  return {
    ...projectScript(script),
    blocks: script.blocks.map(projectBlock),
    renderings: script.renderings.map(projectRendering),
  };
}
