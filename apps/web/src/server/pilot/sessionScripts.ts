import { query, queryOne } from './db';

// pilot.session_scripts, pilot.session_script_blocks and
// pilot.session_script_renderings are owned by
// infra/azure/pilot_slice_postgres_session_scripts_migration.sql, applied
// through the apply-migrations workflow like every other table. Nothing here
// issues DDL.
//
// READ-ONLY MODULE. A script is a plan a coach follows on the floor; what
// actually happened on a given night is pilot.session_script_runs, which is a
// separate write path and deliberately not folded in here -- the migration
// keeps them apart so a single delivery cannot silently overwrite the plan.
// This module surfaces the plan for reading.
//
// BLOCKS CARRY MINUTE OFFSETS, NOT CLOCK TIMES. A session at 4:00 and one at
// 6:30 are the same script, so nothing here resolves an offset against a wall
// clock or a date. Callers that want clock times must add the offset to a
// start time they own; doing it here would bake one session's start into a
// script every session shares.

export type SessionScriptScaleLevel = 'A' | 'B' | 'C';

export type SessionScriptBlockKind =
  | 'arrival'
  | 'instruction'
  | 'demonstration'
  | 'drill_round'
  | 'reset_minute'
  | 'teaching_minute'
  | 'transition'
  | 'conditioning'
  | 'reflection'
  | 'close';

export type SessionScriptRenderingFormat =
  | 'cheat_sheet'
  | 'class_plan'
  | 'instructor_script'
  | 'class_flow'
  | 'athlete_handout'
  | 'parent_summary';

export interface SessionScriptRow {
  organization_id: string;
  script_id: string;
  lineage_id: string;
  version: number;
  name: string;
  discipline: string;
  theme: string;
  phase: string | null;
  day_of_week: string | null;
  total_minutes: number | null;
  contact_structure: string;
  target_group: string;
  prerequisite_note: string;
  reset_protocol: string;
  coach_priorities: string;
  frequent_phrases: string;
  authoring_state: string;
  source_document: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

export interface SessionScriptBlockRow {
  organization_id: string;
  block_id: string;
  script_id: string;
  block_order: number;
  start_offset_min: number;
  end_offset_min: number;
  block_label: string;
  what_to_say: string | null;
  what_to_explain: string | null;
  what_to_watch: string | null;
  what_to_fix: string | null;
  block_kind: SessionScriptBlockKind;
  drill_id: string | null;
  scale_level: SessionScriptScaleLevel | null;
  contact_level: string;
}

export interface SessionScriptRenderingRow {
  organization_id: string;
  rendering_id: string;
  script_id: string;
  format: SessionScriptRenderingFormat;
  audience_note: string;
  body: string;
  generated_from_blocks: boolean;
  created_at: string;
}

export interface SessionScriptWithDetail extends SessionScriptRow {
  blocks: SessionScriptBlockRow[];
  renderings: SessionScriptRenderingRow[];
}

const SCRIPT_FIELDS =
  'organization_id, script_id, lineage_id, version, name, discipline, theme, phase, day_of_week, '
  + 'total_minutes, contact_structure, target_group, prerequisite_note, reset_protocol, '
  + 'coach_priorities, frequent_phrases, authoring_state, source_document, created_by_account_id, '
  + 'created_at, updated_at';

const BLOCK_FIELDS =
  'organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min, block_label, '
  + 'what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind, drill_id, scale_level, '
  + 'contact_level';

const RENDERING_FIELDS =
  'organization_id, rendering_id, script_id, format, audience_note, body, generated_from_blocks, created_at';

/**
 * The coach-facing browse list.
 *
 * Retired scripts are excluded by default because a retired script is one the
 * gym has decided not to run; a coach browsing for tonight should not find it
 * sitting alongside live ones. Pass includeRetired to see them anyway -- they
 * are kept, not deleted, so an old plan stays readable.
 */
export async function listSessionScripts(
  organizationId: string,
  filter: {
    discipline?: string;
    phase?: string;
    dayOfWeek?: string;
    authoringState?: string;
    includeRetired?: boolean;
  } = {},
): Promise<SessionScriptRow[]> {
  return query<SessionScriptRow>(
    `select ${SCRIPT_FIELDS}
     from pilot.session_scripts
     where organization_id = $1
       and ($2::boolean or authoring_state <> 'retired')
       and ($3::text is null or discipline = $3)
       and ($4::text is null or phase = $4)
       and ($5::text is null or day_of_week = $5)
       and ($6::text is null or authoring_state = $6)
     order by discipline, name, version desc`,
    [
      organizationId,
      filter.includeRetired ?? false,
      filter.discipline ?? null,
      filter.phase ?? null,
      filter.dayOfWeek ?? null,
      filter.authoringState ?? null,
    ],
  );
}

/**
 * One script plus its blocks in running order and every authored rendering.
 *
 * Blocks come back ordered by block_order, which the migration constrains
 * unique per script -- that is the sequence the coach runs, and it is the only
 * ordering this module promises. start_offset_min is NOT used for ordering:
 * two blocks may legitimately share a start offset (a conditioning block
 * running under a teaching minute), and sorting by offset would make their
 * order arbitrary.
 */
export async function getSessionScriptWithDetail(
  organizationId: string,
  scriptId: string,
): Promise<SessionScriptWithDetail | null> {
  const script = await queryOne<SessionScriptRow>(
    `select ${SCRIPT_FIELDS} from pilot.session_scripts where organization_id = $1 and script_id = $2`,
    [organizationId, scriptId],
  );
  if (!script) {
    return null;
  }

  const [blocks, renderings] = await Promise.all([
    query<SessionScriptBlockRow>(
      `select ${BLOCK_FIELDS} from pilot.session_script_blocks
       where organization_id = $1 and script_id = $2
       order by block_order`,
      [organizationId, scriptId],
    ),
    query<SessionScriptRenderingRow>(
      `select ${RENDERING_FIELDS} from pilot.session_script_renderings
       where organization_id = $1 and script_id = $2
       order by format`,
      [organizationId, scriptId],
    ),
  ]);

  return { ...script, blocks, renderings };
}

/** Every version of one script lineage, oldest first. Mirrors getDrillLibraryLineage. */
export async function getSessionScriptLineage(
  organizationId: string,
  lineageId: string,
): Promise<SessionScriptRow[]> {
  return query<SessionScriptRow>(
    `select ${SCRIPT_FIELDS}
     from pilot.session_scripts
     where organization_id = $1 and lineage_id = $2
     order by version asc`,
    [organizationId, lineageId],
  );
}

/**
 * Minutes a script actually accounts for, derived from its blocks.
 *
 * This is deliberately NOT total_minutes: that column is what the author said
 * the session lasts, and this is what the blocks add up to. A gap between the
 * two is the useful signal (a script claiming 60 minutes whose blocks cover
 * 45 has fifteen unplanned minutes), so they are reported separately rather
 * than reconciled here.
 *
 * Overlapping blocks are counted once. Blocks may overlap by design -- a
 * conditioning block running underneath a teaching minute is one clock, not
 * two -- so summing each block's duration would double-count real sessions.
 * The intervals are merged instead.
 */
export function coveredMinutes(blocks: Pick<SessionScriptBlockRow, 'start_offset_min' | 'end_offset_min'>[]): number {
  if (blocks.length === 0) {
    return 0;
  }
  const sorted = [...blocks].sort((a, b) => a.start_offset_min - b.start_offset_min);
  let covered = 0;
  let spanStart = sorted[0].start_offset_min;
  let spanEnd = sorted[0].end_offset_min;

  for (const block of sorted.slice(1)) {
    if (block.start_offset_min > spanEnd) {
      covered += spanEnd - spanStart;
      spanStart = block.start_offset_min;
      spanEnd = block.end_offset_min;
    } else if (block.end_offset_min > spanEnd) {
      spanEnd = block.end_offset_min;
    }
  }
  return covered + (spanEnd - spanStart);
}
