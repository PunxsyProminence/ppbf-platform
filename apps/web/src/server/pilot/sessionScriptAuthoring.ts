import { randomUUID } from 'node:crypto';

import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { withTransaction } from './db';
import type { SessionScriptBlockRow, SessionScriptRow } from './sessionScripts';
import { getWorkoutTemplateWithItems, type WorkoutTemplateItemWithDrillHead } from './workoutTemplates';

// A COACH WRITES A SESSION SCRIPT. sessionScripts.ts reads the plan and
// sessionScriptRuns.ts records a night; until this module the only writer of a
// plan was content import, so a gym with no imported scripts had none.
//
// Two writes, both on tables owned by
// infra/azure/pilot_slice_postgres_session_scripts_migration.sql. Nothing here
// issues DDL, and nothing here deletes a row.
//
//   createSessionScriptFromTemplate  a workout template's steps, in the
//     template's order, become timed blocks: minutes from the start, running
//     on from one step to the next.
//   editSessionScript  the name, and each block's title and minutes.
//
// AN EDIT NEVER CHANGES A NIGHT ALREADY DELIVERED. A run pins script_id and
// script_version (sessionScriptRuns.ts startSessionScriptRun) and reads that
// version's blocks. So a script that has ANY run is not updated: the edit is
// written as a new row, version + 1 in the same lineage, with its blocks and
// renderings re-minted under it -- the shape a content-import revision already
// has (contentImport/datasets/sessionScripts.ts). The browse list and the start
// check both follow the highest version, so the new one is what a coach finds
// and starts. A script nobody has run yet is updated where it is.
//
// TWO COACHES EDITING AT ONCE: THE SECOND IS TOLD. An edit says which state of
// the script it was made from (expectedUpdatedAt, the updated_at its form was
// opened on). If the script has been saved since, the edit is refused with
// SESSION_SCRIPT_CHANGED and nothing is written, so one coach's save never
// silently replaces another's. When the first save made a new version instead,
// the second gets SESSION_SCRIPT_SUPERSEDED for the same reason.
//
// AUTHORIZATION IS THE ROUTE'S. Like issueWorkoutTemplate, this trusts its
// caller to have passed the role gate; organizationId is the session's and
// scopes every read and write below.

/** Who may create or edit a session script (roleEquals carries the legacy 'admin' row name). */
export const SESSION_SCRIPT_AUTHOR_ROLES: readonly PilotRole[] = ['coach', 'organization_admin'];

/** What a template step with no minutes of its own starts at. The coach edits it. */
export const DEFAULT_STEP_MINUTES = 5;

const MAX_OFFSET_MIN = 24 * 60;
const MAX_TEXT_LENGTH = 200;

export class SessionScriptAuthoringError extends Error {
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'SessionScriptAuthoringError';
    this.status = status;
  }
}

interface Actor {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
}

function mintId(prefix: 'scr' | 'blk'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

function cleanText(value: string, code: string): string {
  const text = value.trim();
  if (text === '' || text.length > MAX_TEXT_LENGTH) {
    throw new SessionScriptAuthoringError(code, 422);
  }
  return text;
}

// total_minutes is checked 10..300 by the table; outside that it is not stated.
function statedTotalMinutes(lastEnd: number): number | null {
  return lastEnd >= 10 && lastEnd <= 300 ? lastEnd : null;
}

type TemplateStep = Pick<
  WorkoutTemplateItemWithDrillHead,
  | 'block' | 'drill_id' | 'free_text_drill' | 'head_drill_name' | 'scale_level' | 'duration_minutes'
  | 'rep_count' | 'contact_level' | 'coach_note'
>;

// The session-level contact label, from the steps' own levels. All without
// contact, all with, without-then-with, and anything else that has contact in
// it reads 'contact'.
export function contactStructure(steps: readonly Pick<TemplateStep, 'contact_level'>[]): string {
  const withContact = steps.map((step) => step.contact_level !== 'none');
  if (!withContact.includes(true)) return 'non_contact';
  if (!withContact.includes(false)) return 'contact';
  const firstContact = withContact.indexOf(true);
  return withContact.slice(firstContact).every(Boolean) ? 'split_non_contact_then_contact' : 'contact';
}

export interface TemplateScriptBlock {
  block_order: number;
  start_offset_min: number;
  end_offset_min: number;
  block_label: string;
  what_to_say: string | null;
  what_to_explain: string;
  block_kind: 'drill_round' | 'instruction';
  drill_id: string | null;
  scale_level: SessionScriptBlockRow['scale_level'];
  contact_level: string;
}

/**
 * A template's steps as timed blocks, in the order given. Pure.
 *
 * what_to_explain carries the step's own facts (its section and rep count),
 * which a block has no columns for; a block must hold some text
 * (pilot_ssb_content), and a step with neither says which template it came from.
 */
export function blocksFromTemplateSteps(templateName: string, steps: readonly TemplateStep[]): TemplateScriptBlock[] {
  let offset = 0;
  return steps.map((step, index) => {
    const start = offset;
    offset += step.duration_minutes ?? DEFAULT_STEP_MINUTES;
    const facts = [step.block.trim(), step.rep_count === null ? '' : `${step.rep_count} reps`]
      .filter((part) => part !== '');
    const label = (step.head_drill_name ?? step.free_text_drill ?? '').trim() || `Step ${index + 1}`;
    return {
      block_order: index + 1,
      start_offset_min: start,
      end_offset_min: offset,
      block_label: label.slice(0, MAX_TEXT_LENGTH),
      what_to_say: step.coach_note?.trim() || null,
      what_to_explain: facts.length > 0 ? facts.join(' - ') : `From workout template: ${templateName}`,
      block_kind: step.drill_id === null ? 'instruction' : 'drill_round',
      drill_id: step.drill_id,
      scale_level: step.scale_level,
      contact_level: step.contact_level,
    };
  });
}

export interface CreatedSessionScript {
  script_id: string;
  lineage_id: string;
  version: number;
  name: string;
  block_count: number;
}

export async function createSessionScriptFromTemplate(
  params: Actor & { templateId: string; name?: string },
): Promise<CreatedSessionScript> {
  const detail = await getWorkoutTemplateWithItems(params.organizationId, params.templateId);
  if (!detail) {
    throw new SessionScriptAuthoringError('WORKOUT_TEMPLATE_NOT_FOUND', 404);
  }
  const { template, items } = detail;
  // The two refusals issueWorkoutTemplate makes of a template, under its codes:
  // one withdrawn or replaced by a newer version (the list read leaves those
  // out), and one with no steps -- blocks cannot be added afterwards, so a
  // script made from none could never be delivered.
  if (!template.active || template.superseded_at !== null) {
    throw new SessionScriptAuthoringError('WORKOUT_TEMPLATE_NOT_CURRENT', 409);
  }
  if (items.length === 0) {
    throw new SessionScriptAuthoringError('WORKOUT_TEMPLATE_EMPTY', 409);
  }
  const name = cleanText(params.name ?? template.name, 'SESSION_SCRIPT_NAME_INVALID');
  const blocks = blocksFromTemplateSteps(template.name, items);
  // An edit accepts no minute past this, so a script that started past it could not be saved again.
  if (blocks[blocks.length - 1].end_offset_min > MAX_OFFSET_MIN) {
    throw new SessionScriptAuthoringError('WORKOUT_TEMPLATE_TOO_LONG', 422);
  }
  const scriptId = mintId('scr');

  return withTransaction(async (client) => {
    // discipline is left to the column default: a template names none.
    // theme is left empty: it is sent to families and a template's intent is not.
    await client.query(
      `insert into pilot.session_scripts (
         organization_id, script_id, lineage_id, version, name, total_minutes, contact_structure,
         authoring_state, source_document, created_by_account_id
       ) values ($1, $2, $2, 1, $3, $4, $5, 'coach_reviewed', $6, $7)`,
      [
        params.organizationId,
        scriptId,
        name,
        statedTotalMinutes(blocks[blocks.length - 1].end_offset_min),
        contactStructure(items),
        `Workout template: ${template.name} v${template.version}`,
        params.actorAccountId,
      ],
    );
    for (const block of blocks) {
      await client.query(
        `insert into pilot.session_script_blocks (
           organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
           block_label, what_to_say, what_to_explain, block_kind, drill_id, scale_level, contact_level
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          params.organizationId,
          mintId('blk'),
          scriptId,
          block.block_order,
          block.start_offset_min,
          block.end_offset_min,
          block.block_label,
          block.what_to_say,
          block.what_to_explain,
          block.block_kind,
          block.drill_id,
          block.scale_level,
          block.contact_level,
        ],
      );
    }
    await writePilotAuditEvent(
      {
        event_type: 'create',
        actor_account_id: params.actorAccountId,
        actor_role: params.actorRole,
        organization_id: params.organizationId,
        entity_type: 'session_script',
        entity_id: scriptId,
        details: {
          name,
          version: 1,
          block_count: blocks.length,
          template_id: template.template_id,
          template_version: template.version,
        },
      },
      client,
    );
    return { script_id: scriptId, lineage_id: scriptId, version: 1, name, block_count: blocks.length };
  });
}

export interface SessionScriptBlockEdit {
  block_id: string;
  block_label: string;
  start_offset_min: number;
  end_offset_min: number;
}

export interface EditedSessionScript {
  /** 'new_version' when the script had a run: script_id is then the NEW row's. */
  outcome: 'unchanged' | 'updated' | 'new_version';
  script_id: string;
  version: number;
}

function cleanBlockEdits(edits: readonly SessionScriptBlockEdit[]): Map<string, SessionScriptBlockEdit> {
  const byId = new Map<string, SessionScriptBlockEdit>();
  for (const edit of edits) {
    const { start_offset_min: start, end_offset_min: end } = edit;
    if (
      !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end <= start || end > MAX_OFFSET_MIN
    ) {
      throw new SessionScriptAuthoringError('SESSION_SCRIPT_BLOCK_MINUTES_INVALID', 422);
    }
    if (byId.has(edit.block_id)) {
      throw new SessionScriptAuthoringError('SESSION_SCRIPT_BLOCK_REPEATED', 422);
    }
    byId.set(edit.block_id, { ...edit, block_label: cleanText(edit.block_label, 'SESSION_SCRIPT_BLOCK_LABEL_INVALID') });
  }
  return byId;
}

/**
 * Change a script's name and its blocks' titles and minutes. A block the edit
 * does not name keeps what it has; blocks are never added, removed or
 * reordered here.
 */
export async function editSessionScript(
  params: Actor & {
    scriptId: string;
    name?: string;
    blocks?: readonly SessionScriptBlockEdit[];
    /** The script's updated_at as the editor read it. Given, a script saved since is refused. */
    expectedUpdatedAt?: string;
  },
): Promise<EditedSessionScript> {
  const edits = cleanBlockEdits(params.blocks ?? []);
  const newName = params.name === undefined ? undefined : cleanText(params.name, 'SESSION_SCRIPT_NAME_INVALID');

  return withTransaction(async (client) => {
    // FOR UPDATE: two edits of one script queue here, as does a content import
    // revising it (which locks the same row) and a run being started on it
    // (its foreign key takes a key-share lock on this row). The two questions
    // below -- is it still the current version, has it been run -- are each
    // asked in a statement of their own AFTER the lock is held, so they see
    // what the writer this one waited for committed. Asked in the locking
    // statement itself they would be answered from before the wait.
    const found = await client.query<SessionScriptRow>(
      `select * from pilot.session_scripts
        where organization_id = $1 and script_id = $2
          for update`,
      [params.organizationId, params.scriptId],
    );
    const script = found.rows[0];
    if (!script) {
      throw new SessionScriptAuthoringError('SESSION_SCRIPT_NOT_FOUND', 404);
    }
    // Only the current version is edited, the rule startSessionScriptRun holds for starting one.
    const newer = await client.query(
      `select 1 from pilot.session_scripts
        where organization_id = $1 and lineage_id = $2 and version > $3 limit 1`,
      [params.organizationId, script.lineage_id, script.version],
    );
    if ((newer.rowCount ?? 0) > 0) {
      throw new SessionScriptAuthoringError('SESSION_SCRIPT_SUPERSEDED', 409);
    }
    // Compared to the millisecond, which is what a timestamp keeps on its way
    // to a browser and back; the in-place save below always moves updated_at
    // on by at least that much.
    if (
      params.expectedUpdatedAt !== undefined
      && new Date(script.updated_at).getTime() !== Date.parse(params.expectedUpdatedAt)
    ) {
      throw new SessionScriptAuthoringError('SESSION_SCRIPT_CHANGED', 409);
    }

    const stored = await client.query<SessionScriptBlockRow>(
      `select * from pilot.session_script_blocks
        where organization_id = $1 and script_id = $2
        order by block_order`,
      [params.organizationId, params.scriptId],
    );
    const storedIds = new Set(stored.rows.map((block) => block.block_id));
    if ([...edits.keys()].some((blockId) => !storedIds.has(blockId))) {
      throw new SessionScriptAuthoringError('SESSION_SCRIPT_BLOCK_NOT_IN_SCRIPT', 422);
    }

    const blocks = stored.rows.map((block) => {
      const edit = edits.get(block.block_id);
      return edit
        ? {
            ...block,
            block_label: edit.block_label,
            start_offset_min: edit.start_offset_min,
            end_offset_min: edit.end_offset_min,
          }
        : block;
    });
    const movedAt = (index: number) =>
      blocks[index].start_offset_min !== stored.rows[index].start_offset_min
      || blocks[index].end_offset_min !== stored.rows[index].end_offset_min;
    const changed = blocks.filter(
      (block, index) => movedAt(index) || block.block_label !== stored.rows[index].block_label,
    );
    const minutesChanged = blocks.some((_, index) => movedAt(index));
    const name = newName ?? script.name;
    if (changed.length === 0 && name === script.name) {
      return { outcome: 'unchanged', script_id: script.script_id, version: script.version };
    }
    // The stated length follows the blocks once a coach has moved them.
    const totalMinutes = minutesChanged
      ? statedTotalMinutes(Math.max(...blocks.map((block) => block.end_offset_min)))
      : script.total_minutes;

    const run = await client.query(
      `select 1 from pilot.session_script_runs
        where organization_id = $1 and script_id = $2 limit 1`,
      [params.organizationId, params.scriptId],
    );
    const hasRun = (run.rowCount ?? 0) > 0;

    let result: EditedSessionScript;
    if (!hasRun) {
      await client.query(
        `update pilot.session_scripts
            set name = $3, total_minutes = $4,
                updated_at = greatest(now(), updated_at + interval '1 millisecond')
          where organization_id = $1 and script_id = $2`,
        [params.organizationId, script.script_id, name, totalMinutes],
      );
      for (const block of changed) {
        await client.query(
          `update pilot.session_script_blocks
              set block_label = $4, start_offset_min = $5, end_offset_min = $6
            where organization_id = $1 and script_id = $2 and block_id = $3`,
          [
            params.organizationId,
            script.script_id,
            block.block_id,
            block.block_label,
            block.start_offset_min,
            block.end_offset_min,
          ],
        );
      }
      result = { outcome: 'updated', script_id: script.script_id, version: script.version };
    } else {
      const newScriptId = mintId('scr');
      const version = script.version + 1;
      await client.query(
        `insert into pilot.session_scripts (
           organization_id, script_id, lineage_id, version, name, discipline, theme, phase, day_of_week,
           total_minutes, contact_structure, target_group, prerequisite_note, reset_protocol,
           coach_priorities, frequent_phrases, authoring_state, source_document, created_by_account_id
         )
         select organization_id, $3, lineage_id, $4, $5, discipline, theme, phase, day_of_week,
                $6, contact_structure, target_group, prerequisite_note, reset_protocol,
                coach_priorities, frequent_phrases, authoring_state, source_document, $7
           from pilot.session_scripts
          where organization_id = $1 and script_id = $2`,
        [params.organizationId, script.script_id, newScriptId, version, name, totalMinutes, params.actorAccountId],
      );
      for (const block of blocks) {
        await client.query(
          `insert into pilot.session_script_blocks (
             organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
             block_label, what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind,
             drill_id, scale_level, contact_level
           )
           select organization_id, $4, $3, block_order, $5, $6, $7, what_to_say, what_to_explain,
                  what_to_watch, what_to_fix, block_kind, drill_id, scale_level, contact_level
             from pilot.session_script_blocks
            where organization_id = $1 and block_id = $2`,
          [
            params.organizationId,
            block.block_id,
            newScriptId,
            mintId('blk'),
            block.start_offset_min,
            block.end_offset_min,
            block.block_label,
          ],
        );
      }
      await client.query(
        `insert into pilot.session_script_renderings (
           organization_id, rendering_id, script_id, format, audience_note, body, generated_from_blocks
         )
         select organization_id, 'rnd_' || substr(md5($3 || format), 1, 14), $3, format, audience_note, body,
                generated_from_blocks
           from pilot.session_script_renderings
          where organization_id = $1 and script_id = $2`,
        [params.organizationId, script.script_id, newScriptId],
      );
      result = { outcome: 'new_version', script_id: newScriptId, version };
    }

    await writePilotAuditEvent(
      {
        event_type: hasRun ? 'create' : 'update',
        actor_account_id: params.actorAccountId,
        actor_role: params.actorRole,
        organization_id: params.organizationId,
        entity_type: 'session_script',
        entity_id: result.script_id,
        details: {
          name,
          version: result.version,
          outcome: result.outcome,
          edited_script_id: script.script_id,
          blocks_changed: changed.length,
        },
      },
      client,
    );
    return result;
  });
}
