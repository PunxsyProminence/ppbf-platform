import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import { INVISIBLE_FORMAT } from './feedbackSafetyScan';
import { carryLabelsToNewVersion } from './contentImport/datasets/contentLabels';
import { normalizeCell } from './contentImport/values';
import { VOCABULARIES } from './contentImport/vocabularies';
import type { PilotRole } from './contracts';
import { withTransaction } from './db';
import { orNotWritten } from '@/src/lib/drillPresentation';
import { BLOCK_RENDERED_FORMATS, FROM_DRILL, FROM_TEMPLATE, explainLine, templateSectionWords } from '@/src/lib/sessionScriptWords';
import type { SessionScriptBlockRow, SessionScriptRow } from './sessionScripts';
import { getWorkoutTemplateWithItems, issueOrder, issueParents, type WorkoutTemplateItemWithDrillHead } from './workoutTemplates';

// A COACH WRITES A SESSION SCRIPT. sessionScripts.ts reads the plan and
// sessionScriptRuns.ts records a night; until this module the only writer of a
// plan was content import, so a gym with no imported scripts had none.
//
// Two writes, both on tables owned by
// infra/azure/pilot_slice_postgres_session_scripts_migration.sql. Nothing here
// issues DDL, and nothing here deletes a row: an edit that removes a block is
// written as a new version (Overwatch Q2 = A on #2191).
//
//   createSessionScriptFromTemplate  a workout template's steps, in the order
//     a workout issued from it runs them (issueOrder), become timed blocks:
//     minutes from the start, running on from one step to the next, except
//     that a step an owner placed inside another (a link issueOrder follows)
//     and gave no minutes runs inside that step's minutes.
//   editSessionScript  the name, each block's title and minutes, and (lane
//     W4-5) the blocks themselves: a library drill added, a block removed, the
//     running order.
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

/**
 * What a template step with no minutes of its own starts at, unless an owner placed it inside
 * another step by a link issueOrder follows: it then runs inside that step's minutes
 * (blocksFromTemplateSteps). The coach edits it.
 */
export const DEFAULT_STEP_MINUTES = 5;

const MAX_OFFSET_MIN = 24 * 60;
const MAX_TEXT_LENGTH = 200;

/**
 * A title cut to MAX_TEXT_LENGTH UTF-16 units (cleanText's measure) at a code-point boundary. A plain
 * slice can end in half a surrogate pair, which the database stores as U+FFFD; this drops that half
 * (App Overwatch on #2191; Codex on #2203).
 */
export function cutToLength(text: string): string {
  const cut = text.slice(0, MAX_TEXT_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

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
  | 'item_id' | 'ordinal' | 'details'
  | 'block' | 'drill_id' | 'free_text_drill' | 'drill_name' | 'scale_level' | 'duration_minutes'
  | 'rep_count' | 'contact_level' | 'coach_note'
>;

// The session-level contact label, from the steps' own levels. All without
// contact, all with, without-then-with, and anything else that has contact in
// it reads 'contact'.
export function contactStructure(steps: readonly { contact_level: string }[]): string {
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
 * A template's steps as timed blocks, in the order a workout issued from the
 * template runs them (issueOrder). Pure.
 *
 * Each block runs on from the one before it, for its step's minutes, or
 * DEFAULT_STEP_MINUTES when the step states none. A step an owner placed inside
 * another (details.within_item_id, followed as issueOrder follows it) that
 * states no minutes adds none: it runs inside its parent's time, so its block
 * has its parent's minutes and the next block starts where it would without it
 * (D-PK73-3: "no Long Road minutes change"). One that states its own minutes
 * keeps them, like any step (lane W4-8, TL-ORD-2; App Overwatch on #2205,
 * comment 7181958209).
 *
 * what_to_explain carries the step's own facts (its section and rep count),
 * which a block has no columns for; a block must hold some text
 * (pilot_ssb_content), and a step with neither says which template it came from.
 */
export function blocksFromTemplateSteps(templateName: string, steps: readonly TemplateStep[]): TemplateScriptBlock[] {
  const parents = issueParents(steps);
  const windows = new Map<string, { start: number; end: number }>();
  let offset = 0;
  return issueOrder(steps).map((step, index) => {
    const parent = parents.get(step.item_id) ?? null;
    // A parent is always placed before the steps inside it, so its window is known here.
    const inside = step.duration_minutes === null && parent !== null ? windows.get(parent) : undefined;
    const start = inside ? inside.start : offset;
    const end = inside ? inside.end : (offset += step.duration_minutes ?? DEFAULT_STEP_MINUTES);
    windows.set(step.item_id, { start, end });
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
      end_offset_min: end,
      block_label: cutToLength(label),
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
 * then each block's minutes and title and its four coaching lines, under the
 * labels the plan page and the live screen use; a line the author left empty
 * reads "Not written yet". Pure.
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
      // A field the author left empty says so, as the plan page's block list does.
      lines.push(`  ${label}: ${orNotWritten(value.trim())}`);
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
  // out), and one with no steps -- a plan made from it would start with
  // nothing to deliver.
  if (!template.active || template.superseded_at !== null) {
    throw new SessionScriptAuthoringError('WORKOUT_TEMPLATE_NOT_CURRENT', 409);
  }
  if (items.length === 0) {
    throw new SessionScriptAuthoringError('WORKOUT_TEMPLATE_EMPTY', 409);
  }
  const name = cleanText(params.name ?? template.name, 'SESSION_SCRIPT_NAME_INVALID');
  const blocks = blocksFromTemplateSteps(template.name, items);
  // The latest minute any block reaches: a nested step's block ends with its parent's, which need
  // not be the last block's end.
  const lastEnd = blocks.reduce((last, block) => Math.max(last, block.end_offset_min), 0);
  // An edit accepts no minute past this, so a script that started past it could not be saved again.
  if (lastEnd > MAX_OFFSET_MIN) {
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
        statedLength(template.duration_minutes, lastEnd),
        // In the blocks' running order, which the label's "without, then with contact" reads.
        contactStructure(blocks),
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

interface BlockAddPlace {
  /** The caller's name for the new block in `order`; not stored. */
  ref: string;
  start_offset_min: number;
  end_offset_min: number;
}

/**
 * A block an edit adds (lane W4-5): a drill from the gym's library (SP-1a); a text block, written
 * by the coach, its contact level picked by the coach (SP-1b, Q1 = C on #2189); or a copy of a
 * block of any plan of the gym (SP-1b). A drill's or a copy's title is its source's unless given.
 */
export type SessionScriptBlockAdd =
  | (BlockAddPlace & { kind: 'drill'; drill_id: string; block_label?: string })
  | (BlockAddPlace & { kind: 'text'; block_kind: string; block_label: string; text: string; contact_level: string })
  | (BlockAddPlace & { kind: 'copy'; block_id: string; block_label?: string });

/** A text block is any kind but a drill round (the migration's ten kinds, :84-86). */
const TEXT_BLOCK_KINDS: readonly string[] = [
  'arrival', 'instruction', 'demonstration', 'reset_minute', 'teaching_minute', 'transition', 'conditioning', 'reflection', 'close',
];
/** The kinds the table lets hold no text (pilot_ssb_content). */
const MAY_HOLD_NO_TEXT: readonly string[] = ['transition', 'arrival', 'close'];
const CONTACT_LADDER: readonly string[] = VOCABULARIES.contact_level.values;
/** A template step's coach note, which a step carries into its block's Say, has this cap (workoutTemplateEdit.ts MAX_NOTE_TEXT). */
const MAX_BLOCK_TEXT_LENGTH = 1000;

function cleanAdd(add: SessionScriptBlockAdd): SessionScriptBlockAdd {
  checkMinutes(add.start_offset_min, add.end_offset_min);
  if (add.kind !== 'text') {
    return { ...add, block_label: add.block_label === undefined ? undefined : cleanText(add.block_label, 'SESSION_SCRIPT_BLOCK_LABEL_INVALID') };
  }
  if (!TEXT_BLOCK_KINDS.includes(add.block_kind)) refuse('SESSION_SCRIPT_BLOCK_KIND_INVALID');
  // Q1 = C: required, from the ladder, no default -- a text block written for contact work must not read as none.
  if (!CONTACT_LADDER.includes(add.contact_level)) refuse('SESSION_SCRIPT_BLOCK_CONTACT_INVALID');
  // Read and measured as a template step's coach note is (normalizeCell: NFC, LF, no edge space); words
  // that are only invisible characters are no words.
  const text = normalizeCell(add.text);
  // Nothing a reader sees: the safety scan's own invisible class (feedbackSafetyScan.ts INVISIBLE_FORMAT --
  // format characters, default-ignorables such as variation selectors and Hangul fillers, the Braille
  // blank), as a pain note reads it (painReportNotes.ts), so the two cannot drift (reviewer D; Codex).
  const empty = text.replace(INVISIBLE_FORMAT, '').trim() === '';
  if (text.length > MAX_BLOCK_TEXT_LENGTH || (empty && !MAY_HOLD_NO_TEXT.includes(add.block_kind))) {
    refuse('SESSION_SCRIPT_BLOCK_TEXT_INVALID');
  }
  return { ...add, block_label: cleanText(add.block_label, 'SESSION_SCRIPT_BLOCK_LABEL_INVALID'), text: empty ? '' : text };
}

export interface EditedSessionScript {
  /** 'new_version' when the script had a run, or the edit removed a block: script_id is then the NEW row's. */
  outcome: 'unchanged' | 'updated' | 'new_version';
  script_id: string;
  version: number;
  /** With 'new_version', why: the plan had been run, or (no run) the edit removed a block -- so a screen says which (reviewer B on #2191). */
  because?: 'run' | 'removal';
}

function refuse(code: string): never {
  throw new SessionScriptAuthoringError(code, 422);
}

function checkMinutes(start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > MAX_OFFSET_MIN) {
    refuse('SESSION_SCRIPT_BLOCK_MINUTES_INVALID');
  }
}

/**
 * The plan's running order after an edit: stored block ids and new blocks' refs. Pure.
 *
 * Without `order`, the blocks kept stay in their order and the new ones follow in the order
 * given. With it, it must name every block kept and every new one exactly once: a list that
 * leaves a block out is refused, never read as a removal, which only `remove` says.
 */
export function runningOrderAfter(
  storedIds: readonly string[],
  change: { edited: readonly string[]; remove: readonly string[]; refs: readonly string[]; order?: readonly string[] },
): string[] {
  const stored = new Set(storedIds);
  if (change.remove.some((id) => !stored.has(id))) refuse('SESSION_SCRIPT_BLOCK_NOT_IN_SCRIPT');
  const removed = new Set(change.remove);
  // A block named twice, or both edited and removed, is not one change.
  if (removed.size !== change.remove.length || change.edited.some((id) => removed.has(id))) {
    refuse('SESSION_SCRIPT_BLOCK_REPEATED');
  }
  const refs = new Set(change.refs);
  if (refs.size !== change.refs.length || change.refs.some((ref) => ref.trim() === '' || stored.has(ref))) {
    refuse('SESSION_SCRIPT_BLOCK_REF_INVALID');
  }
  const kept = storedIds.filter((id) => !removed.has(id));
  const order = change.order ?? [...kept, ...change.refs];
  const expected = new Set([...kept, ...change.refs]);
  if (order.length !== expected.size || new Set(order).size !== order.length || order.some((id) => !expected.has(id))) {
    refuse('SESSION_SCRIPT_ORDER_INVALID');
  }
  // An order may be empty: a plan with no blocks is kept, shown ("This plan has no blocks yet") and
  // not started (sessionScriptRuns.ts) until blocks are added to it.
  return [...order];
}

/** How much contact a plan label says. observation_only and non_contact both say none. */
const CONTACT_RANK: Readonly<Record<string, number>> = { non_contact: 0, observation_only: 0, split_non_contact_then_contact: 1, contact: 2 };

/**
 * The plan's contact label once its blocks change. Pure. The blocks raise it when they carry more
 * contact than it says, and never lower it: the label may be the author's own, set apart from the
 * blocks (an import names it in its own column, and a block imported with no contact level reads
 * 'none'), and nothing records which it is. So a plan never reads less contact than it is
 * (Overwatch Q1 on #2189). Whether a coach may lower it is asked on #2191.
 */
export function contactStructureAfter(stored: string, after: readonly { contact_level: string }[]): string {
  const read = contactStructure(after);
  return (CONTACT_RANK[read] ?? 0) > (CONTACT_RANK[stored] ?? 0) ? read : stored;
}

function cleanBlockEdits(edits: readonly SessionScriptBlockEdit[]): Map<string, SessionScriptBlockEdit> {
  const byId = new Map<string, SessionScriptBlockEdit>();
  for (const edit of edits) {
    checkMinutes(edit.start_offset_min, edit.end_offset_min);
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

interface DrillForBlock {
  drill_id: string;
  name: string;
  contact_level: string;
}

/**
 * Every drill the edit touches, share-locked in ONE statement in drill_id order before the plan is
 * locked, as content import locks the drills it names (one statement, drill_id order) before plans:
 * the drills new blocks link, and the drills the plan's stored blocks link -- a new version copies
 * those, and each copy's foreign key check locks its drill, which under the plan's lock would wait on
 * an import holding it while the import waits for the plan. Two statements would each be in order
 * but not their union, and could still deadlock (reviewer A on #2191, rounds 2 and 4). A drill revised
 * mid-edit is seen as replaced, or waits for this edit (drillLibraryEdit.ts locks it FOR UPDATE before
 * drill_contact_below_steps). A new block links only a current drill of this gym: active and not
 * superseded, the browse list's rule. Not locked: the read of which drills the stored blocks link.
 */
async function lockDrills(
  client: PoolClient,
  organizationId: string,
  scriptId: string,
  newDrillIds: readonly string[],
): Promise<Map<string, DrillForBlock>> {
  const found = await client.query<DrillForBlock & { current: boolean }>(
    `select drill_id, name, contact_level, (active and superseded_at is null) as current
       from pilot.drill_library
      where organization_id = $1
        and (drill_id = any($2::text[])
             or drill_id in (select drill_id from pilot.session_script_blocks where organization_id = $1 and script_id = $3))
      order by drill_id
        for share`,
    [organizationId, [...new Set(newDrillIds)], scriptId],
  );
  const byId = new Map(found.rows.map((row) => [row.drill_id, row]));
  for (const drillId of newDrillIds) {
    const drill = byId.get(drillId);
    if (!drill) refuse('SESSION_SCRIPT_DRILL_NOT_FOUND');
    if (!drill.current) throw new SessionScriptAuthoringError('SESSION_SCRIPT_DRILL_NOT_CURRENT', 409);
  }
  return byId;
}

/**
 * The current version of each copied block's drill lineage, keyed by the source's drill id -- taken
 * as the template editor takes a new item's drill (workoutTemplateEdit.ts; the importer's
 * withdrawn_drill and step_contact_above_drill rules). Read without a lock so that it joins
 * lockDrills' one ordered statement, which then checks it is still current and active: a drill the gym
 * withdrew, or replaced since this read, is refused there. A lineage with none current is refused here.
 */
async function copyHeads(client: PoolClient, organizationId: string, drillIds: readonly string[]): Promise<Map<string, string>> {
  if (drillIds.length === 0) return new Map();
  const found = await client.query<{ source_id: string; head_id: string }>(
    `select d.drill_id as source_id, h.drill_id as head_id
       from pilot.drill_library d
       join pilot.drill_library h
         on h.organization_id = d.organization_id and h.lineage_id = d.lineage_id and h.superseded_at is null
      where d.organization_id = $1 and d.drill_id = any($2::text[])`,
    [organizationId, [...new Set(drillIds)]],
  );
  const heads = new Map(found.rows.map((row) => [row.source_id, row.head_id]));
  if (drillIds.some((id) => !heads.has(id))) throw new SessionScriptAuthoringError('SESSION_SCRIPT_DRILL_NOT_CURRENT', 409);
  return heads;
}

/** The blocks a copy is made from: any block of the gym's plans, this one included. Not locked. */
async function copySources(client: PoolClient, organizationId: string, blockIds: readonly string[]): Promise<Map<string, SessionScriptBlockRow>> {
  if (blockIds.length === 0) return new Map();
  const found = await client.query<SessionScriptBlockRow>(
    `select * from pilot.session_script_blocks where organization_id = $1 and block_id = any($2::text[])`,
    [organizationId, [...new Set(blockIds)]],
  );
  const byId = new Map(found.rows.map((row) => [row.block_id, row]));
  if (blockIds.some((id) => !byId.has(id))) refuse('SESSION_SCRIPT_COPY_SOURCE_NOT_FOUND');
  return byId;
}

/** A block as the edit leaves it: a stored one (block_id set) or a new one (block_id null). */
type PlannedBlock = Omit<SessionScriptBlockRow, 'organization_id' | 'script_id' | 'block_id'> & { block_id: string | null };

/**
 * Change a script: its name, its blocks' titles and minutes (a block not named keeps what it has),
 * and (lane W4-5) its blocks: a block added (a library drill, a text block or a copy), a block
 * removed, the running order. Minutes are stored as sent; the editor proposes them (Q2 = A on
 * #2189). Contact (Q1 = C): a drill block carries its drill's own level and an Explain line naming
 * the drill (FROM_DRILL); a text block the level the coach picked; a copy its source's. When the
 * blocks change, the contact label is raised, never lowered (contactStructureAfter). A plan may
 * be left with no blocks. Coach renderings made from the blocks are re-rendered; the rest stay.
 *
 * A plan with a run, or an edit that removes a block, gets a new version: no block row is ever
 * deleted (Overwatch Q2 = A on #2191). Otherwise in place, renumbered 1..n when blocks change.
 */
export async function editSessionScript(
  params: Actor & {
    scriptId: string;
    name?: string;
    blocks?: readonly SessionScriptBlockEdit[];
    /** Lane W4-5 SP-1a: blocks to add, blocks to remove, and the running order after. */
    add?: readonly SessionScriptBlockAdd[];
    remove?: readonly string[];
    order?: readonly string[];
    /** The script's updated_at as the editor read it. Given, a script saved since is refused. */
    expectedUpdatedAt?: string;
  },
): Promise<EditedSessionScript> {
  const edits = cleanBlockEdits(params.blocks ?? []);
  const adds = (params.add ?? []).map(cleanAdd);
  const remove = params.remove ?? [];
  const newName = params.name === undefined ? undefined : cleanText(params.name, 'SESSION_SCRIPT_NAME_INVALID');

  return withTransaction(async (client) => {
    // The drills first, then the plan: content import locks drill rows before plan rows, so taking
    // them the other way round here could deadlock against it. A copy links its drill's current
    // version, found first (unlocked) so it joins the same single ordered lock (reviewers C and D, #2196).
    const sources = await copySources(client, params.organizationId, adds.flatMap((add) => (add.kind === 'copy' ? [add.block_id] : [])));
    const heads = await copyHeads(client, params.organizationId, [...sources.values()].flatMap((block) => (block.drill_id === null ? [] : [block.drill_id])));
    const drillAdds = adds.flatMap((add) => (add.kind === 'drill' ? [add.drill_id] : []));
    const drills = await lockDrills(client, params.organizationId, params.scriptId, [...drillAdds, ...heads.values()]);
    const script = await lockCurrentScript(client, params);

    const stored = await client.query<SessionScriptBlockRow>(
      `select * from pilot.session_script_blocks
        where organization_id = $1 and script_id = $2
        order by block_order`,
      [params.organizationId, params.scriptId],
    );
    const byId = new Map(stored.rows.map((block) => [block.block_id, block]));
    if ([...edits.keys()].some((blockId) => !byId.has(blockId))) {
      refuse('SESSION_SCRIPT_BLOCK_NOT_IN_SCRIPT');
    }
    const storedIds = stored.rows.map((block) => block.block_id);
    const order = runningOrderAfter(storedIds, {
      edited: [...edits.keys()],
      remove,
      refs: adds.map((add) => add.ref),
      order: params.order,
    });
    const addByRef = new Map(adds.map((add) => [add.ref, add]));

    const keptBefore = storedIds.filter((id) => order.includes(id));
    const keptAfter = order.filter((id) => byId.has(id));
    const orderChanged = keptAfter.some((id, index) => id !== keptBefore[index]);
    const structural = adds.length > 0 || remove.length > 0 || orderChanged;

    const blocks: PlannedBlock[] = order.map((id, index) => {
      const block = byId.get(id);
      if (block) {
        const edit = edits.get(id);
        return {
          ...block,
          ...(edit && {
            block_label: edit.block_label,
            start_offset_min: edit.start_offset_min,
            end_offset_min: edit.end_offset_min,
          }),
          block_order: structural ? index + 1 : block.block_order,
        };
      }
      const add = addByRef.get(id) as (typeof adds)[number];
      const place = { block_id: null, block_order: index + 1, start_offset_min: add.start_offset_min, end_offset_min: add.end_offset_min };
      if (add.kind === 'text') {
        return {
          ...place, block_label: add.block_label, what_to_say: add.text || null, what_to_explain: null, what_to_watch: null,
          what_to_fix: null, block_kind: add.block_kind as SessionScriptBlockRow['block_kind'], drill_id: null, scale_level: null,
          contact_level: add.contact_level,
        };
      }
      if (add.kind === 'copy') {
        // Everything the source block says, its contact level included (the sizing); a new id, its own
        // place; its drill's current version (copyHeads, locked in lockDrills), never below its contact.
        const { block_label, what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind, drill_id, scale_level, contact_level } =
          sources.get(add.block_id) as SessionScriptBlockRow;
        const drill = drill_id === null ? null : (drills.get(heads.get(drill_id) as string) as DrillForBlock);
        if (!CONTACT_LADDER.includes(contact_level)) refuse('SESSION_SCRIPT_BLOCK_CONTACT_INVALID');
        if (drill && CONTACT_LADDER.indexOf(contact_level) > CONTACT_LADDER.indexOf(drill.contact_level)) {
          refuse('SESSION_SCRIPT_COPY_CONTACT_ABOVE_DRILL');
        }
        return {
          ...place, block_label: add.block_label ?? cutToLength(block_label), what_to_say,
          // The "From the drill" line names the version the block links (audit 2026-10-17 item 4; reviewer C).
          what_to_explain: drill && what_to_explain?.startsWith(FROM_DRILL) ? `${FROM_DRILL}${drill.name}` : what_to_explain,
          what_to_watch, what_to_fix, block_kind, drill_id: drill?.drill_id ?? null, scale_level, contact_level,
        };
      }
      const drill = drills.get(add.drill_id) as DrillForBlock;
      return {
        ...place,
        block_label: add.block_label ?? (cutToLength(drill.name.trim()) || `Step ${index + 1}`),
        what_to_say: null,
        what_to_explain: `${FROM_DRILL}${drill.name}`,
        what_to_watch: null,
        what_to_fix: null,
        block_kind: 'drill_round',
        drill_id: drill.drill_id,
        scale_level: null,
        contact_level: drill.contact_level,
      };
    });
    const before = (block: PlannedBlock) => (block.block_id === null ? undefined : byId.get(block.block_id));
    const moved = (block: PlannedBlock) => {
      const was = before(block);
      return !was || block.start_offset_min !== was.start_offset_min || block.end_offset_min !== was.end_offset_min;
    };
    const changed = blocks.filter((block) => {
      const was = before(block);
      return was !== undefined && (moved(block) || block.block_label !== was.block_label);
    });
    const minutesChanged = blocks.some(moved);
    const name = newName ?? script.name;
    if (!structural && changed.length === 0 && name === script.name) {
      return { outcome: 'unchanged', script_id: script.script_id, version: script.version };
    }
    const totalMinutes = minutesChanged
      ? statedLength(script.total_minutes, blocks.reduce((last, block) => Math.max(last, block.end_offset_min), 0))
      : script.total_minutes;
    const contact = structural ? contactStructureAfter(script.contact_structure, blocks) : script.contact_structure;

    const run = await client.query(
      `select 1 from pilot.session_script_runs
        where organization_id = $1 and script_id = $2 limit 1`,
      [params.organizationId, params.scriptId],
    );
    const hasRun = (run.rowCount ?? 0) > 0;
    const newVersion = hasRun || remove.length > 0;

    const insertNew = (scriptId: string, block: PlannedBlock) =>
      client.query(
        `insert into pilot.session_script_blocks (
           organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
           block_label, what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind,
           drill_id, scale_level, contact_level
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          params.organizationId, mintId('blk'), scriptId, block.block_order, block.start_offset_min,
          block.end_offset_min, block.block_label, block.what_to_say, block.what_to_explain, block.what_to_watch,
          block.what_to_fix, block.block_kind, block.drill_id, block.scale_level, block.contact_level,
        ],
      );

    let result: EditedSessionScript;
    let rerendered: number;
    if (!newVersion) {
      await client.query(
        `update pilot.session_scripts
            set name = $3, total_minutes = $4, contact_structure = $5,
                updated_at = greatest(now(), updated_at + interval '1 millisecond')
          where organization_id = $1 and script_id = $2`,
        [params.organizationId, script.script_id, name, totalMinutes, contact],
      );
      if (structural) {
        // pilot_ssb_order_uq is checked row by row and is not deferrable: every kept block is first
        // lifted clear of 1..n, so no block is moved onto a place another still holds.
        const lift = stored.rows.reduce((most, block) => Math.max(most, block.block_order), blocks.length);
        await client.query(
          `update pilot.session_script_blocks set block_order = block_order + $3
            where organization_id = $1 and script_id = $2`,
          [params.organizationId, script.script_id, lift],
        );
      }
      for (const block of blocks) {
        if (block.block_id === null) {
          await insertNew(script.script_id, block);
        } else if (structural || changed.includes(block)) {
          await client.query(
            `update pilot.session_script_blocks
                set block_order = $4, block_label = $5, start_offset_min = $6, end_offset_min = $7
              where organization_id = $1 and script_id = $2 and block_id = $3`,
            [
              params.organizationId, script.script_id, block.block_id, block.block_order,
              block.block_label, block.start_offset_min, block.end_offset_min,
            ],
          );
        }
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
                $6, $8, target_group, prerequisite_note, reset_protocol,
                coach_priorities, frequent_phrases, authoring_state, source_document, $7
           from pilot.session_scripts
          where organization_id = $1 and script_id = $2`,
        [params.organizationId, script.script_id, newScriptId, version, name, totalMinutes, params.actorAccountId, contact],
      );
      for (const block of blocks) {
        if (block.block_id === null) {
          await insertNew(newScriptId, block);
          continue;
        }
        await client.query(
          `insert into pilot.session_script_blocks (
             organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
             block_label, what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind,
             drill_id, scale_level, contact_level
           )
           select organization_id, $4, $3, $8, $5, $6, $7, what_to_say, what_to_explain,
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
            block.block_order,
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
      // The new version keeps the backbone labels of the one it replaces (lineage-wide stage links stay as they are).
      await carryLabelsToNewVersion(client, params.organizationId, 'session-scripts', script.lineage_id, script.version, version);
      rerendered = await rerenderFromBlocks(client, params.organizationId, newScriptId, name, blocks);
      result = { outcome: 'new_version', script_id: newScriptId, version, because: hasRun ? 'run' : 'removal' };
    }

    await writePilotAuditEvent(
      {
        event_type: newVersion ? 'create' : 'update',
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
          blocks_added: adds.length,
          ...(sources.size > 0 && { copied_from: adds.flatMap((add) => (add.kind === 'copy' ? [add.block_id] : [])) }),
          blocks_removed: remove.length,
          order_changed: orderChanged,
          ...(!hasRun && remove.length > 0 && { new_version_because: 'a block was removed' }),
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
