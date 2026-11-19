import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import { MINT } from './contentImport/ids';
import { versionId } from './contentImport/datasets/templateScriptVersions';
import { writeEditedVersionLabels, type EditedPart } from './contentImport/datasets/contentLabels';
import { normalizeCell } from './contentImport/values';
import { VOCABULARIES, type VocabularyName } from './contentImport/vocabularies';
import type { PilotRole } from './contracts';
import { withTransaction } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';

// A COACH EDITS A WORKOUT TEMPLATE AND ITS ITEMS IN THE APP (OD-2026-11-19-005,
// OW25-51; Overwatch ruling 2026-11-19).
//
// NEVER IN PLACE. Templates are versioned and "never edited in place"
// (workout_issues migration; workoutTemplates.ts). An edit writes v(n+1) of the
// lineage exactly as a content-import revision does (contentImport/datasets/
// templates.ts and templateScriptVersions.ts): the head is superseded and
// withdrawn (superseded_at, active = false), the new row's id is
// versionId('wtp', lineage, n+1), it supersedes the head and takes the head's
// active flag, and the items are written fresh under it, item_id =
// MINT.templateItem(new id, ordinal). The old version keeps its own items.
//
// ISSUED WORKOUTS DO NOT CHANGE. Issuing COPIES a template's steps into
// pilot.workout_issues / workout_issue_steps and drill_assignments, with the
// template version (workoutTemplates.ts, workoutIssues.ts); nothing reads the
// template back. The old version stays for template_version to name. A new issue
// takes the new version (issue refuses a template that is not current).
// Training tracks name a template LINEAGE and so open the edited version from
// then on.
//
// ITEMS are sent as the template's whole ordered list: an entry with item_id
// starts from that item of the version being edited (its details included) and
// lays the sent fields over it; an entry without one is a new item. The list's
// order is the new ordinals. An item left out is not in the new version.
//
// LABELS. Only what really changes counts as edited (a resent unchanged field
// keeps its AI-draft label, OD-2026-11-15-011 ruling 2). An edited template
// field is labelled REPORTED with the editor; a changed item list is labelled as
// the field 'items' (contentLabels.ts#writeEditedVersionLabels).
//
// KNOWN GAP (Overwatch 2026-11-19, flagged not fixed): a later content-import
// package that revises this template writes v(n+2) over the coach's edit.

const TEMPLATE_TEXT_FIELDS = ['name', 'session_type', 'age_band', 'intent'] as const;
const TEMPLATE_KEYS = [
  ...TEMPLATE_TEXT_FIELDS, 'difficulty', 'duration_minutes', 'coach_notes', 'requires_coach_authorization', 'items',
] as const;
const NOT_EDITABLE_TEMPLATE_KEYS = [
  'details', 'active', 'organization_id', 'lineage_id', 'version', 'supersedes_template_id', 'superseded_at',
  'created_by_account_id', 'created_by_role', 'created_at', 'updated_at',
] as const;
const ITEM_KEYS = [
  'item_id', 'block', 'drill_id', 'free_text_drill', 'scale_level', 'duration_minutes', 'rep_count', 'contact_level', 'coach_note',
] as const;
const NOT_EDITABLE_ITEM_KEYS = ['details', 'ordinal', 'template_id', 'organization_id', 'created_at'] as const;
/** The item columns an entry may set; everything else is carried from the item it names. */
const ITEM_CONTENT = ['block', 'drill_id', 'free_text_drill', 'scale_level', 'duration_minutes', 'rep_count', 'contact_level', 'coach_note'] as const;

export const MAX_SHORT_TEXT = 200;
export const MAX_LONG_TEXT = 4000;
export const MAX_NOTE_TEXT = 1000;
export const MAX_ITEMS = 60;

type Row = Record<string, unknown>;
type ItemContent = Partial<Record<(typeof ITEM_CONTENT)[number], string | number | null>>;

export interface WorkoutTemplateEditRequest {
  /** The version the editor was looking at; it must still be the current one. */
  templateId: string;
  fields: Row;
  items?: { itemId?: string; content: ItemContent }[];
}

export interface WorkoutTemplateEditResult {
  changed: boolean;
  template_id: string;
  lineage_id: string;
  version: number;
  previous_template_id: string | null;
  edited: string[];
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read as the content importer reads a cell (contentImport/values.ts#normalizeCell). */
function text(raw: unknown, key: string, max: number, required: boolean): string {
  if (typeof raw !== 'string') throw new ValidationError(`Unsupported ${key}: must be text`);
  const value = normalizeCell(raw);
  if (required && !value) throw new ValidationError(`Missing ${key}: it cannot be blank`);
  if (value.length > max) throw new ValidationError(`Unsupported ${key}: at most ${max} characters`);
  return value;
}

/** Optional text: null or blank clears it (stored as null, as the importer stores a blank optional cell). */
function optionalText(raw: unknown, key: string, max: number): string | null {
  if (raw === null) return null;
  const value = text(raw, key, max, false);
  return value === '' ? null : value;
}

function wholeNumber(raw: unknown, key: string, min: number, max: number | null, nullable: boolean): number | null {
  if (raw === null && nullable) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || (max !== null && raw > max)) {
    throw new ValidationError(`Unsupported ${key}: a whole number ${max === null ? `of at least ${min}` : `from ${min} to ${max}`}`);
  }
  return raw;
}

function inVocabulary(value: string, key: string, name: VocabularyName): string {
  if (!VOCABULARIES[name].values.includes(value)) {
    throw new ValidationError(`Unsupported ${key}: one of ${VOCABULARIES[name].values.join(', ')}`, 'VALUE_NOT_ALLOWED');
  }
  return value;
}

function refuseKey(key: string, allowed: readonly string[], notEditable: readonly string[], prefix = ''): void {
  if (notEditable.includes(key)) throw new ValidationError(`Unsupported field: ${prefix}${key} is not editable`, 'FIELD_NOT_EDITABLE');
  if (!allowed.includes(key)) throw new ValidationError(`Unsupported field: ${prefix}${key}`, 'UNKNOWN_FIELD');
}

/** Parses and bounds a PATCH body: unknown and never-editable keys, vocabularies and the importer's numeric bounds. */
export function parseWorkoutTemplateEdit(body: Row): WorkoutTemplateEditRequest {
  for (const key of Object.keys(body)) {
    if (key !== 'template_id') refuseKey(key, TEMPLATE_KEYS, NOT_EDITABLE_TEMPLATE_KEYS);
  }
  if (typeof body.template_id !== 'string' || !body.template_id.trim()) throw new ValidationError('Missing template_id');
  const request: WorkoutTemplateEditRequest = { templateId: body.template_id.trim(), fields: {} };

  for (const key of TEMPLATE_TEXT_FIELDS) {
    if (body[key] !== undefined) request.fields[key] = text(body[key], key, key === 'intent' ? MAX_LONG_TEXT : MAX_SHORT_TEXT, true);
  }
  if (body.difficulty !== undefined) request.fields.difficulty = inVocabulary(text(body.difficulty, 'difficulty', MAX_SHORT_TEXT, true), 'difficulty', 'difficulty');
  if (body.duration_minutes !== undefined) request.fields.duration_minutes = wholeNumber(body.duration_minutes, 'duration_minutes', 1, 180, false);
  if (body.coach_notes !== undefined) request.fields.coach_notes = optionalText(body.coach_notes, 'coach_notes', MAX_LONG_TEXT);
  if (body.requires_coach_authorization !== undefined) {
    if (typeof body.requires_coach_authorization !== 'boolean') {
      throw new ValidationError('Unsupported requires_coach_authorization: must be true or false');
    }
    request.fields.requires_coach_authorization = body.requires_coach_authorization;
  }

  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) throw new ValidationError('Unsupported items: the whole ordered list of items');
    if (body.items.length > MAX_ITEMS) throw new ValidationError(`Unsupported items: at most ${MAX_ITEMS}`);
    // The importer never revises a template down to no steps, and a template
    // with none cannot be issued.
    if (body.items.length === 0) throw new ValidationError('Unsupported items: a template keeps at least one item', 'ITEMS_EMPTY');
    const seen = new Set<string>();
    request.items = body.items.map((raw, index) => {
      if (!isPlainObject(raw)) throw new ValidationError(`Unsupported items[${index}]`);
      const content: ItemContent = {};
      let itemId: string | undefined;
      for (const [key, value] of Object.entries(raw)) {
        refuseKey(key, ITEM_KEYS, NOT_EDITABLE_ITEM_KEYS, 'items.');
        const name = `items[${index}].${key}`;
        switch (key) {
          case 'item_id':
            if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`Unsupported ${name}`);
            itemId = value.trim();
            if (seen.has(itemId)) throw new ValidationError(`Unsupported items: ${itemId} twice`);
            seen.add(itemId);
            break;
          case 'block': content.block = text(value, name, MAX_SHORT_TEXT, true); break;
          case 'drill_id': content.drill_id = optionalText(value, name, MAX_SHORT_TEXT); break;
          case 'free_text_drill': content.free_text_drill = optionalText(value, name, MAX_NOTE_TEXT); break;
          case 'coach_note': content.coach_note = optionalText(value, name, MAX_NOTE_TEXT); break;
          case 'scale_level': content.scale_level = value === null ? null : inVocabulary(text(value, name, 1, true), name, 'scale_level'); break;
          case 'contact_level': content.contact_level = inVocabulary(text(value, name, MAX_SHORT_TEXT, true), name, 'contact_level'); break;
          case 'duration_minutes': content.duration_minutes = wholeNumber(value, name, 1, 90, true); break;
          case 'rep_count': content.rep_count = wholeNumber(value, name, 1, null, true); break;
          default: break;
        }
      }
      if (itemId === undefined && (content.block === undefined)) {
        throw new ValidationError(`Missing items[${index}].block: a new item needs a block`);
      }
      return { itemId, content };
    });
  }
  return request;
}

/** A value a CHECK refused (one source per item, no minutes or reps above light contact) is the request's fault. */
function translateWriteError(error: unknown, name: string): never {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === '23514') {
    if (constraint === 'pilot_wti_one_source') {
      throw new ValidationError('Unsupported items: each item names a drill, describes one in words, or carries details', 'ITEM_NEEDS_SOURCE');
    }
    if (constraint === 'pilot_wti_no_contact_volume') {
      throw new ValidationError('Unsupported items: an item above light technical contact carries no minutes or reps', 'ITEM_CONTACT_VOLUME');
    }
    throw new ValidationError('Unsupported value', 'VALUE_NOT_ALLOWED');
  }
  if (code === '23505' && constraint === 'pilot_workout_templates_one_active_name') {
    throw new ConflictError(`A template named "${name}" already exists. Choose another name.`, 'TEMPLATE_NAME_TAKEN');
  }
  if (code === '23505') {
    throw new ConflictError('This template changed while it was being edited. Reload it and try again.', 'TEMPLATE_VERSION_STALE');
  }
  throw error;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** A value as the comparison reads it: text normalized as the importer reads a cell, blank text as none. */
const comparable = (value: unknown) => (typeof value === 'string' ? normalizeCell(value) || null : value ?? null);

async function rowsOf(tx: PoolClient, organizationId: string, templateId: string): Promise<Row[]> {
  const { rows } = await tx.query<{ row: Row }>(
    `select to_jsonb(i) as row from pilot.workout_template_items i
      where i.organization_id = $1 and i.template_id = $2
      order by i.ordinal`,
    [organizationId, templateId],
  );
  return rows.map((r) => r.row);
}

/**
 * Writes the edit as v(n+1), in one transaction with its items, labels and
 * audit row. Nothing that really changes -> nothing is written. Another gym's
 * template reads as not found; a version that is no longer current is refused.
 */
export async function editWorkoutTemplate(input: {
  organizationId: string;
  request: WorkoutTemplateEditRequest;
  actorAccountId: string;
  actorRole: PilotRole;
}): Promise<WorkoutTemplateEditResult> {
  const { organizationId, request } = input;
  return withTransaction(async (tx) => {
    const headResult = await tx.query<{ row: Row }>(
      `select to_jsonb(t) as row from pilot.workout_templates t
        where t.organization_id = $1 and t.template_id = $2
        for update`,
      [organizationId, request.templateId],
    );
    const head = headResult.rows[0]?.row;
    if (!head) throw new NotFoundError('Not found', 'WORKOUT_TEMPLATE_NOT_FOUND');
    if (head.superseded_at !== null) {
      throw new ConflictError('This is not the current version of the template. Reload it and edit the current version.', 'TEMPLATE_VERSION_STALE');
    }
    const headId = head.template_id as string;
    const lineageId = head.lineage_id as string;
    const headVersion = head.version as number;
    const oldItems = await rowsOf(tx, organizationId, headId);

    // What really changes. Stored text is read the way the sent text was
    // (normalizeCell, blank = none), so text resent unchanged keeps its label.
    const edited: EditedPart[] = [];
    const patch: Row = {};
    for (const [key, value] of Object.entries(request.fields)) {
      if (!same(comparable(head[key]), comparable(value))) {
        patch[key] = value;
        edited.push({ field: key });
      }
    }

    // The new item list: each entry from the item it names (or blank), with the
    // sent fields laid over it.
    let newItems: Row[] | null = null;
    if (request.items !== undefined) {
      const bases: Row[] = [];
      newItems = request.items.map((entry, index) => {
        let base: Row = {};
        if (entry.itemId !== undefined) {
          const found = oldItems.find((item) => item.item_id === entry.itemId);
          if (!found) throw new ValidationError(`Unsupported items[${index}].item_id: not an item of this version of the template`);
          base = found;
        }
        bases.push(base);
        return { ...base, ...entry.content, ordinal: index + 1 };
      });

      // THE IMPORTER'S DRILL RULES (contentImport/validate.ts: withdrawn_drill,
      // step_contact_above_drill), judged against the drill's CURRENT version --
      // the one an issue runs (workoutTemplates.ts, planTemplateIssue) -- and only
      // for an item whose drill or contact really changes. A new or changed drill
      // must be one the gym runs (its current version active), and is stored as
      // that current version, as the importer stores a step's drill. An item
      // carried with its drill unchanged keeps the version it was written with,
      // even an older one, so resending a whole list is never refused for it.
      // The current version is share-locked against a drill edit (which locks
      // it for update): a drill edit that comes second judges the steps this
      // edit wrote; one that comes first leaves this edit a 409 to reload.
      const ladder: readonly string[] = VOCABULARIES.contact_level.values;
      const contactOf = (item: Row) => (item.contact_level as string | undefined) ?? 'none';
      for (const [index, item] of newItems.entries()) {
        const base = bases[index];
        const drillChanged = item.drill_id !== base.drill_id;
        if (typeof item.drill_id !== 'string' || (!drillChanged && contactOf(item) === contactOf(base))) continue;
        const { rows } = await tx.query<{ current_id: string; contact_level: string; active: boolean }>(
          `select h.drill_id as current_id, h.contact_level, h.active
             from pilot.drill_library d
             join pilot.drill_library h
               on h.organization_id = d.organization_id and h.lineage_id = d.lineage_id and h.superseded_at is null
            where d.organization_id = $1 and d.drill_id = $2
              for share of h`,
          [organizationId, item.drill_id],
        );
        const drill = rows[0];
        if (!drill) {
          // A drill edit that replaced the current version while this edit
          // waited on its lock leaves the locked read empty: that is a change
          // to reload, not a drill that does not exist.
          const { rows: exists } = await tx.query(
            `select 1 from pilot.drill_library where organization_id = $1 and drill_id = $2`,
            [organizationId, item.drill_id],
          );
          if (exists.length > 0) {
            throw new ConflictError('A drill in this template changed while it was being edited. Reload it and try again.', 'TEMPLATE_DRILL_CHANGED');
          }
          throw new ValidationError(`Unsupported items[${index}].drill_id: not a drill of this gym`, 'ITEM_DRILL_NOT_FOUND');
        }
        if (drillChanged) {
          if (!drill.active) {
            throw new ValidationError(`Unsupported items[${index}].drill_id: this gym has withdrawn that drill`, 'ITEM_DRILL_WITHDRAWN');
          }
          item.drill_id = drill.current_id;
        }
        if (ladder.indexOf(contactOf(item)) > ladder.indexOf(drill.contact_level)) {
          throw new ValidationError(
            `Unsupported items[${index}].contact_level: ${contactOf(item)} is above the drill's own contact level (${drill.contact_level})`,
            'ITEM_CONTACT_ABOVE_DRILL',
          );
        }
      }

      const content = (item: Row) => [...ITEM_CONTENT, 'details', 'ordinal']
        .map((key) => (key === 'contact_level' ? contactOf(item) : comparable(item[key])));
      if (!same(oldItems.map(content), newItems.map(content))) edited.push({ field: 'items' });
      else newItems = null;
    }

    if (edited.length === 0) {
      return { changed: false, template_id: headId, lineage_id: lineageId, version: headVersion, previous_template_id: null, edited: [] };
    }

    // The lineage's highest version + 1, as the importer numbers a revision
    // (templateScriptVersions.ts, maxVersions). The head is locked above; a
    // version number or head that another write took first is refused by the
    // lineage-version and one-head-per-lineage indexes (409).
    const { rows: maxRows } = await tx.query<{ max_version: number }>(
      `select max(version)::int as max_version from pilot.workout_templates where organization_id = $1 and lineage_id = $2`,
      [organizationId, lineageId],
    );
    const newVersion = (maxRows[0]?.max_version ?? headVersion) + 1;
    const newId = versionId('wtp', lineageId, newVersion);
    const at = new Date().toISOString();
    const name = (patch.name ?? head.name) as string;

    try {
      // Superseded and withdrawn first, as the importer does: one head per
      // lineage and one active name are both partial indexes.
      await tx.query(
        `update pilot.workout_templates set superseded_at = now(), active = false, updated_at = now()
          where organization_id = $1 and template_id = $2 and superseded_at is null`,
        [organizationId, headId],
      );
      await tx.query(
        `insert into pilot.workout_templates
         select (jsonb_populate_record(null::pilot.workout_templates,
                  to_jsonb(t) || $3::jsonb
                  || jsonb_build_object('superseded_at', null, 'created_at', now(), 'updated_at', now()))).*
           from pilot.workout_templates t
          where t.organization_id = $1 and t.template_id = $2`,
        [organizationId, headId, JSON.stringify({
          ...patch,
          template_id: newId,
          version: newVersion,
          supersedes_template_id: headId,
          active: head.active,
          created_by_account_id: input.actorAccountId,
          created_by_role: input.actorRole,
        })],
      );

      for (const item of newItems ?? oldItems) {
        const itemId = MINT.templateItem(newId, String(item.ordinal));
        if (item.item_id !== undefined) {
          // Carried from an item of the old version: every column, the edit laid over.
          await tx.query(
            `insert into pilot.workout_template_items
             select (jsonb_populate_record(null::pilot.workout_template_items, $1::jsonb)).*`,
            [JSON.stringify({ ...item, item_id: itemId, template_id: newId, created_at: at })],
          );
        } else {
          // A new item: the named columns, the table's defaults for the rest.
          await tx.query(
            `insert into pilot.workout_template_items
               (organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill, scale_level,
                duration_minutes, rep_count, contact_level, coach_note)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,'none'),$12)`,
            [
              organizationId, itemId, newId, item.ordinal, item.block, item.drill_id ?? null, item.free_text_drill ?? null,
              item.scale_level ?? null, item.duration_minutes ?? null, item.rep_count ?? null, item.contact_level ?? null,
              item.coach_note ?? null,
            ],
          );
        }
      }
    } catch (error) {
      translateWriteError(error, name);
    }

    const editId = randomUUID();
    await writeEditedVersionLabels(tx, {
      organizationId,
      dataset: 'workout-templates',
      lineageId,
      fromVersion: headVersion,
      toVersion: newVersion,
      editId,
      editor: { accountId: input.actorAccountId, role: input.actorRole, at },
      edited,
    });

    const editedNames = edited.map((part) => part.field);
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.actorAccountId,
      actor_role: input.actorRole,
      organization_id: organizationId,
      entity_type: 'workout_template',
      entity_id: newId,
      details: { action: 'in_app_edit', edit_id: editId, lineage_id: lineageId, version: newVersion, from_template_id: headId, edited: editedNames },
    }, tx);

    return {
      changed: true,
      template_id: newId,
      lineage_id: lineageId,
      version: newVersion,
      previous_template_id: headId,
      edited: editedNames,
    };
  });
}
