import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { withTransaction } from './db';
import { BLOCK_RENDERED_FORMATS, FROM_TEMPLATE, explainLine, templateSectionWords } from '@/src/lib/sessionScriptWords';
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
//   setSessionScriptRetired  retires a script (kept, left out of the browse
//     list) or brings a retired one back. In place, never a new version.
//   markSessionScriptReviewed  a coach marks a draft plan reviewed. In place,
//     never a new version.
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
// RENDERINGS FOLLOW THE BLOCKS ONLY WHERE THEY WERE MADE FROM THEM (audit
// 2026-10-17 item 8; Overwatch Q8 "A", 2026-10-18). A rendering flagged
// generated_from_blocks in a COACH format is re-rendered from the edited blocks
// (renderingFromBlocks), in place and in a new version alike. Every other
// rendering is copied as it is: one written by hand is the author's text and an
// edit to the blocks does not change it; a family format made from the blocks
// is not re-rendered either, because a block's title is the coach's free text
// and is withheld from families (Jason, 2026-10-12: "strip them";
// sessionScriptProjection.ts).
//
// AUTHORIZATION IS THE ROUTE'S (SESSION_SCRIPT_AUTHOR_ROLES in
// app/api/pilot/session-scripts/route.ts). Like issueWorkoutTemplate, this
// trusts its caller to have passed the role gate; organizationId is the
// session's and scopes every read and write below.

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

// THE STATED LENGTH is the author's figure -- the template's duration, or what
// an imported script says -- and is kept apart from what the blocks add up to
// (sessionScripts.ts coveredMinutes). One rule holds it on create and on edit:
// it stays as stated, except that it is never shorter than the blocks, so a
// plan whose last block ends at minute 50 does not read "45 min". The table
// checks it 10..300; outside that it is not stated.
function statedLength(stated: number | null, lastEnd: number): number | null {
  const length = Math.max(stated ?? 0, lastEnd);
  return length >= 10 && length <= 300 ? length : null;
}

type TemplateStep = Pick<
  WorkoutTemplateItemWithDrillHead,
  | 'block' | 'drill_id' | 'free_text_drill' | 'drill_name' | 'scale_level' | 'duration_minutes'
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
    // In words, and said to be the template's (F-078): "From the template: Warm-up, 3 reps".
    const facts = [step.block.trim() === '' ? '' : templateSectionWords(step.block), step.rep_count === null ? '' : `${step.rep_count} reps`]
      .filter((part) => part !== '');
    // The name of the version the block links (drill_id), not the lineage head's: a drill renamed
    // in a newer version would otherwise title a block that opens the older one (audit 2026-10-17
    // item 4). A template keeps the version it was written against (the content-import default,
    // OD-2026-10-08-008 ruling 5), and so does the plan made from it.
    const label = (step.drill_name ?? step.free_text_drill ?? '').trim() || `Step ${index + 1}`;
    return {
      block_order: index + 1,
      start_offset_min: start,
      end_offset_min: offset,
      block_label: label.slice(0, MAX_TEXT_LENGTH),
      what_to_say: step.coach_note?.trim() || null,
      what_to_explain: `${FROM_TEMPLATE}${facts.length > 0 ? facts.join(', ') : templateName}`,
      block_kind: step.drill_id === null ? 'instruction' : 'drill_round',
      drill_id: step.drill_id,
      scale_level: step.scale_level,
      contact_level: step.contact_level,
    };
  });
}

type RenderedBlock = Pick<
  SessionScriptBlockRow,
  'start_offset_min' | 'end_offset_min' | 'block_label' | 'what_to_say' | 'what_to_explain' | 'what_to_watch' | 'what_to_fix'
>;

/**
 * A plan as plain text, from its blocks in the order given: the plan's name,
 * then each block's minutes and title and the coaching lines its author
 * filled, under the labels the plan page and the live screen use. Pure.
 */
export function renderingFromBlocks(name: string, blocks: readonly RenderedBlock[]): string {
  const lines = [name];
  for (const block of blocks) {
    lines.push('', `${block.start_offset_min}-${block.end_offset_min} min  ${block.block_label}`);
    const explain = explainLine(block.what_to_explain ?? '');
    for (const [label, value] of [
      ['Say', block.what_to_say ?? ''],
      [explain.label, explain.value],
      ['Watch', block.what_to_watch ?? ''],
      ['Fix', block.what_to_fix ?? ''],
    ]) {
      if (value.trim() !== '') lines.push(`  ${label}: ${value.trim()}`);
    }
  }
  return lines.join('\n');
}

/** Re-renders a script's coach-format renderings made from its blocks. Returns how many. */
async function rerenderFromBlocks(
  client: PoolClient,
  organizationId: string,
  scriptId: string,
  name: string,
  blocks: readonly RenderedBlock[],
): Promise<number> {
  const result = await client.query(
    `update pilot.session_script_renderings
        set body = $3
      where organization_id = $1 and script_id = $2
        and generated_from_blocks and format = any($4::text[])`,
    [organizationId, scriptId, renderingFromBlocks(name, blocks), [...BLOCK_RENDERED_FORMATS]],
  );
  return result.rowCount ?? 0;
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
    // Asked again under lock: the read above takes none, so a template replaced
    // or withdrawn since would otherwise still become a plan. FOR SHARE waits
    // for a writer updating the row and then reads what it committed.
    const held = await client.query<{ active: boolean; superseded_at: string | null }>(
      `select active, superseded_at from pilot.workout_templates
        where organization_id = $1 and template_id = $2
          for share`,
      [params.organizationId, template.template_id],
    );
    if (!held.rows[0]?.active || held.rows[0].superseded_at !== null) {
      throw new SessionScriptAuthoringError('WORKOUT_TEMPLATE_NOT_CURRENT', 409);
    }
    // discipline is left to the column default: a template names none.
    // theme is left empty: it is sent to families and a template's intent is not.
    await client.query(
      `insert into pilot.session_scripts (
         organization_id, script_id, lineage_id, version, name, total_minutes, contact_structure,
         authoring_state, source_document, created_by_account_id
       ) values ($1, $2, $2, 1, $3, $4, $5, 'draft', $6, $7)`,
      [
        params.organizationId,
        scriptId,
        name,
        statedLength(template.duration_minutes, blocks[blocks.length - 1].end_offset_min),
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
 * The script a write is about to change, locked, and known to be the current
 * version in the state the writer read. Every write in this module starts here.
 *
 * FOR UPDATE: two writes to one script queue here, as does a content import
 * revising it (which locks the same row) and a run being started on it
 * (startSessionScriptRun share-locks this row before it asks the same
 * question, so neither can answer from before the other committed). The
 * questions -- is it still the current version, was it saved since the writer
 * read it -- are each asked AFTER the lock is held, so they see what the writer
 * this one waited for committed. Asked in the locking statement itself they
 * would be answered from before the wait.
 */
async function lockCurrentScript(
  client: PoolClient,
  params: { organizationId: string; scriptId: string; expectedUpdatedAt?: string },
): Promise<SessionScriptRow> {
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
  // Only the current version is written to, the rule startSessionScriptRun holds for starting one.
  const newer = await client.query(
    `select 1 from pilot.session_scripts
      where organization_id = $1 and lineage_id = $2 and version > $3 limit 1`,
    [params.organizationId, script.lineage_id, script.version],
  );
  if ((newer.rowCount ?? 0) > 0) {
    throw new SessionScriptAuthoringError('SESSION_SCRIPT_SUPERSEDED', 409);
  }
  // Compared to the millisecond, which is what a timestamp keeps on its way
  // to a browser and back; every in-place write below moves updated_at on by
  // at least that much.
  if (
    params.expectedUpdatedAt !== undefined
    && new Date(script.updated_at).getTime() !== Date.parse(params.expectedUpdatedAt)
  ) {
    throw new SessionScriptAuthoringError('SESSION_SCRIPT_CHANGED', 409);
  }
  return script;
}

/**
 * Change a script's name and its blocks' titles and minutes. A block the edit
 * does not name keeps what it has; blocks are never added, removed or
 * reordered here. A coach-format rendering made from the blocks is re-rendered
 * from the edited ones; every other rendering stays as written.
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
    const script = await lockCurrentScript(client, params);

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
    const totalMinutes = minutesChanged
      ? statedLength(script.total_minutes, Math.max(...blocks.map((block) => block.end_offset_min)))
      : script.total_minutes;

    const run = await client.query(
      `select 1 from pilot.session_script_runs
        where organization_id = $1 and script_id = $2 limit 1`,
      [params.organizationId, params.scriptId],
    );
    const hasRun = (run.rowCount ?? 0) > 0;

    let result: EditedSessionScript;
    let rerendered: number;
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
      rerendered = await rerenderFromBlocks(client, params.organizationId, script.script_id, name, blocks);
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
      rerendered = await rerenderFromBlocks(client, params.organizationId, newScriptId, name, blocks);
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
          renderings_rerendered: rerendered,
        },
      },
      client,
    );
    return result;
  });
}

export interface RetiredSessionScript {
  outcome: 'unchanged' | 'retired' | 'brought_back';
  script_id: string;
  version: number;
}

/** The states a plan can be brought back to: whatever it was before it was retired. */
const RESTORABLE_STATES = ['draft', 'coach_reviewed', 'in_use'] as const;

// Across every version of the plan: an edit or an import of a retired plan makes a new version that is
// retired too, while the retire's own audit row stays under the version that was retired.
async function stateBeforeRetiring(client: PoolClient, organizationId: string, lineageId: string): Promise<string> {
  const row = await client.query<{ state_before: string | null }>(
    `select details->>'state_before' as state_before
       from pilot.audit_events
      where organization_id = $1 and entity_type = 'session_script'
        and entity_id in (select script_id from pilot.session_scripts where organization_id = $1 and lineage_id = $2)
        and details->>'outcome' = 'retired'
      order by created_at desc, audit_id desc
      limit 1`,
    [organizationId, lineageId],
  );
  const before = row.rows[0]?.state_before ?? null;
  return before !== null && (RESTORABLE_STATES as readonly string[]).includes(before) ? before : 'draft';
}

/**
 * Retire a script, or bring a retired one back.
 *
 * RETIRED IS KEPT, NOT DELETED. The row, its blocks, its renderings and every
 * night delivered from it stay exactly as they are; the browse list leaves a
 * retired script out (sessionScripts.ts listSessionScripts) and returns it
 * again when asked to include retired ones.
 *
 * IN PLACE, NEVER A NEW VERSION, delivered or not. authoring_state is the
 * script's place in its life, not its content -- the rule content import
 * holds (contentImport/datasets/sessionScripts.ts) -- so retiring changes no
 * name and no block, and no delivered night's plan. It is the same question as
 * an edit in one respect: it is asked of the current version, in the state the
 * coach read (lockCurrentScript).
 *
 * WHAT IT DOES NOT DO. startSessionScriptRun does not read authoring_state, so
 * this stops nothing: a session live on a script that is then retired finishes
 * normally, and the screen is what stops offering Start on a retired plan.
 */
export async function setSessionScriptRetired(
  params: Actor & { scriptId: string; retired: boolean; expectedUpdatedAt?: string },
): Promise<RetiredSessionScript> {
  return withTransaction(async (client) => {
    const script = await lockCurrentScript(client, params);
    const isRetired = script.authoring_state === 'retired';
    if (isRetired === params.retired) {
      return { outcome: 'unchanged', script_id: script.script_id, version: script.version };
    }
    // Brought back, a plan is what it was before it was retired (the retire's own audit row holds
    // state_before), not a review nobody did (F-078). No such row: a draft.
    const stateAfter = params.retired ? 'retired' : await stateBeforeRetiring(client, params.organizationId, script.lineage_id);
    await client.query(
      `update pilot.session_scripts
          set authoring_state = $3,
              updated_at = greatest(now(), updated_at + interval '1 millisecond')
        where organization_id = $1 and script_id = $2`,
      [params.organizationId, script.script_id, stateAfter],
    );
    const outcome = params.retired ? 'retired' : 'brought_back';
    await writePilotAuditEvent(
      {
        event_type: 'update',
        actor_account_id: params.actorAccountId,
        actor_role: params.actorRole,
        organization_id: params.organizationId,
        entity_type: 'session_script',
        entity_id: script.script_id,
        details: {
          name: script.name,
          version: script.version,
          outcome,
          state_before: script.authoring_state,
          state_after: stateAfter,
        },
      },
      client,
    );
    return { outcome, script_id: script.script_id, version: script.version };
  });
}

export interface ReviewedSessionScript {
  outcome: 'unchanged' | 'reviewed';
  script_id: string;
  version: number;
}

/**
 * A coach marks a draft plan reviewed (F-092). "The AI teaches and drafts;
 * coaches decide" (OWNER_DECISIONS, app description): a plan made from a
 * template starts as a draft, and this is the coach's word that it has been
 * read and is fit to run. Engine-unlock proposal 029 would count only reviewed
 * and in-use plans (an open question in that proposal, not a rule here).
 *
 * Draft to coach_reviewed only. A plan already reviewed or in use is left as it
 * is. Nothing here writes in_use and nothing takes a review back: no ruling
 * covers either. A retired plan is refused: it is brought back first.
 *
 * IN PLACE, NEVER A NEW VERSION, for the reason retiring is
 * (setSessionScriptRetired): authoring_state is lifecycle, not content. Any
 * coach of the gym may mark any of its plans (OD-2026-10-11-007, whole-gym
 * reach); the role gate is the route's. The audit row names the coach.
 */
export async function markSessionScriptReviewed(
  params: Actor & { scriptId: string; expectedUpdatedAt?: string },
): Promise<ReviewedSessionScript> {
  return withTransaction(async (client) => {
    const script = await lockCurrentScript(client, params);
    if (script.authoring_state === 'retired') {
      throw new SessionScriptAuthoringError('SESSION_SCRIPT_RETIRED', 409);
    }
    if (script.authoring_state !== 'draft') {
      return { outcome: 'unchanged', script_id: script.script_id, version: script.version };
    }
    await client.query(
      `update pilot.session_scripts
          set authoring_state = 'coach_reviewed',
              updated_at = greatest(now(), updated_at + interval '1 millisecond')
        where organization_id = $1 and script_id = $2`,
      [params.organizationId, script.script_id],
    );
    await writePilotAuditEvent(
      {
        event_type: 'update',
        actor_account_id: params.actorAccountId,
        actor_role: params.actorRole,
        organization_id: params.organizationId,
        entity_type: 'session_script',
        entity_id: script.script_id,
        details: {
          name: script.name,
          version: script.version,
          outcome: 'reviewed',
          state_before: script.authoring_state,
          state_after: 'coach_reviewed',
        },
      },
      client,
    );
    return { outcome: 'reviewed', script_id: script.script_id, version: script.version };
  });
}
