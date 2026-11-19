import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import { MINT } from './contentImport/ids';
import { writeEditedVersionLabels, type EditedPart } from './contentImport/datasets/contentLabels';
import type { PilotRole } from './contracts';
import { withTransaction } from './db';
import { assertDrillMeetsCueRule } from './drills';
import { ConflictError, NotFoundError, ValidationError } from './errors';

// A COACH EDITS A LIBRARY DRILL IN THE APP (OD-2026-11-19-005, OW25-51: "we will
// make sure we have an EDit button"; the third fix path beside a content PR and
// promote, OD-2026-11-15-011).
//
// NEVER IN PLACE (OD-2026-11-15-011 ruling 3). An edit writes v(n+1) of the
// lineage exactly as a content-import revision does (contentImport/datasets/
// drills.ts, the header and apply): the head gets superseded_at and STAYS active
// (gyms that adopted it pin that exact version, and so does issued work); the
// new row's id is MINT.drillVersion(lineage, n+1), it supersedes the head, and
// every child row -- scale levels, stop rules, cues, secondary skills, transfer
// claims -- is re-minted under it. The old version keeps its own rows.
//
// The new row is a COPY of the head with the edited columns laid over it
// (jsonb_populate_record), so a column added to pilot.drill_library later is
// carried, not dropped. created_by_* names the editor.
//
// WHAT AN EDIT DOES NOT TOUCH. field_provenance and a scale level's
// authoring_state are the floor-test gate (OD-2026-10-06-026 ruling 3;
// src/lib/drillFloorValidation.ts) -- an edit is not a floor test -- and the
// rest of NOT_EDITABLE is identity, provenance or lifecycle. A floor test
// recorded on the old version stays on the old version, as after an import.
//
// LABELS. Only the parts that really CHANGE count as edited, so a client that
// resends the whole record does not strip the draft label from text nobody
// touched (OD-2026-11-15-011 ruling 2). Each edited part's label becomes REPORTED
// with the editor (contentLabels.ts#writeEditedVersionLabels).
//
// KNOWN GAP (Overwatch 2026-11-19, flagged not fixed): a later content-import
// package that revises this drill compares the package to the head and writes
// v(n+2) over the coach's text.

export const DRILL_TEXT_FIELDS = [
  'target_behavior', 'purpose', 'standard_setup', 'execution', 'what_good_looks_like', 'what_bad_looks_like',
  'common_errors', 'corrections', 'transfer', 'equipment_needed',
] as const;
const SHORT_FIELDS = ['name', 'category'] as const;
const VOCABULARY_FIELDS = ['difficulty', 'contact_level'] as const;
const SCALE_TEXT_FIELDS = ['demand_description', 'constraint_applied', 'coach_watch_point'] as const;
const SCALE_FIELDS = [...SCALE_TEXT_FIELDS, 'contact_level'] as const;
const STOP_RULE_FIELDS = ['condition_text', 'rule_kind'] as const;

/** Every key a request may carry. */
export const EDITABLE_DRILL_LIBRARY_KEYS = [
  ...SHORT_FIELDS, ...VOCABULARY_FIELDS, ...DRILL_TEXT_FIELDS, 'requires_coach_authorization',
  'cues', 'scale_levels', 'stop_rules',
] as const;

/** Named so a request that sends one is told why, rather than "unknown". */
export const NOT_EDITABLE_DRILL_LIBRARY_KEYS = [
  'discipline', 'skill_id', 'content_class', 'source_ref', 'grounding_claim_ids', 'field_provenance', 'active',
  'organization_id', 'lineage_id', 'version', 'supersedes_drill_id', 'superseded_at',
  'created_by_account_id', 'created_by_role', 'created_at', 'updated_at',
] as const;

export const MAX_SHORT_TEXT = 200;
export const MAX_LONG_TEXT = 4000;
export const MAX_STOP_RULE_TEXT = 1000;
export const MAX_CUES = 12;
export const MAX_CUE_TEXT = 200;

type Row = Record<string, unknown>;

export interface DrillLibraryEditRequest {
  /** The version the editor was looking at; it must still be the head. */
  drillId: string;
  fields: Partial<Record<(typeof SHORT_FIELDS)[number] | (typeof VOCABULARY_FIELDS)[number] | (typeof DRILL_TEXT_FIELDS)[number], string>>
    & { requires_coach_authorization?: boolean };
  cues?: string[];
  scaleLevels?: Record<string, Partial<Record<(typeof SCALE_FIELDS)[number], string>>>;
  stopRules?: { ordinal: number; condition_text?: string; rule_kind?: string }[];
}

export interface DrillLibraryEditResult {
  changed: boolean;
  drill_id: string;
  lineage_id: string;
  version: number;
  previous_drill_id: string | null;
  edited: string[];
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(raw: unknown, key: string, max: number, required: boolean): string {
  if (typeof raw !== 'string') throw new ValidationError(`Unsupported ${key}: must be text`);
  const value = raw.trim();
  if (required && !value) throw new ValidationError(`Missing ${key}: it cannot be blank`);
  if (value.length > max) throw new ValidationError(`Unsupported ${key}: at most ${max} characters`);
  return value;
}

/**
 * Parses and bounds a PATCH body. Refuses an unknown key, a never-editable key,
 * and malformed parts; leaves vocabulary checks (difficulty, contact_level,
 * rule_kind) to the table's own CHECK constraints so the two cannot drift.
 */
export function parseDrillLibraryEdit(body: Row): DrillLibraryEditRequest {
  for (const key of Object.keys(body)) {
    if (key === 'drill_id') continue;
    if ((NOT_EDITABLE_DRILL_LIBRARY_KEYS as readonly string[]).includes(key)) {
      throw new ValidationError(`Unsupported field: ${key} is not editable`, 'FIELD_NOT_EDITABLE');
    }
    if (!(EDITABLE_DRILL_LIBRARY_KEYS as readonly string[]).includes(key)) {
      throw new ValidationError(`Unsupported field: ${key}`, 'UNKNOWN_FIELD');
    }
  }
  if (typeof body.drill_id !== 'string' || !body.drill_id.trim()) throw new ValidationError('Missing drill_id');

  const request: DrillLibraryEditRequest = { drillId: body.drill_id.trim(), fields: {} };
  for (const key of SHORT_FIELDS) {
    if (body[key] !== undefined) request.fields[key] = text(body[key], key, MAX_SHORT_TEXT, true);
  }
  for (const key of VOCABULARY_FIELDS) {
    if (body[key] !== undefined) request.fields[key] = text(body[key], key, MAX_SHORT_TEXT, true);
  }
  for (const key of DRILL_TEXT_FIELDS) {
    if (body[key] !== undefined) request.fields[key] = text(body[key], key, MAX_LONG_TEXT, false);
  }
  if (body.requires_coach_authorization !== undefined) {
    if (typeof body.requires_coach_authorization !== 'boolean') {
      throw new ValidationError('Unsupported requires_coach_authorization: must be true or false');
    }
    request.fields.requires_coach_authorization = body.requires_coach_authorization;
  }

  if (body.cues !== undefined) {
    if (!Array.isArray(body.cues) || body.cues.some((cue) => typeof cue !== 'string')) {
      throw new ValidationError('Unsupported cues: a list of text');
    }
    // Blank lines are dropped (a cue nobody wrote is not a cue); a repeat is one
    // cue -- the table keys a cue by its words (MINT.cue).
    const cues = [...new Set((body.cues as string[]).map((cue) => cue.trim()).filter((cue) => cue.length > 0))];
    if (cues.length > MAX_CUES) throw new ValidationError(`Unsupported cues: at most ${MAX_CUES}`);
    if (cues.some((cue) => cue.length > MAX_CUE_TEXT)) throw new ValidationError(`Unsupported cues: at most ${MAX_CUE_TEXT} characters each`);
    request.cues = cues;
  }

  if (body.scale_levels !== undefined) {
    if (!isPlainObject(body.scale_levels)) throw new ValidationError('Unsupported scale_levels: an object keyed by level');
    request.scaleLevels = {};
    for (const [level, raw] of Object.entries(body.scale_levels)) {
      if (!['A', 'B', 'C'].includes(level) || !isPlainObject(raw)) {
        throw new ValidationError(`Unsupported scale_levels.${level}`);
      }
      const edit: Partial<Record<(typeof SCALE_FIELDS)[number], string>> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!(SCALE_FIELDS as readonly string[]).includes(key)) {
          throw new ValidationError(`Unsupported field: scale_levels.${level}.${key}`, 'UNKNOWN_FIELD');
        }
        edit[key as (typeof SCALE_FIELDS)[number]] = text(value, `scale_levels.${level}.${key}`, MAX_LONG_TEXT, key === 'demand_description' || key === 'contact_level');
      }
      request.scaleLevels[level] = edit;
    }
  }

  if (body.stop_rules !== undefined) {
    if (!Array.isArray(body.stop_rules)) throw new ValidationError('Unsupported stop_rules: a list of {ordinal, condition_text, rule_kind}');
    const seen = new Set<number>();
    request.stopRules = body.stop_rules.map((raw, index) => {
      if (!isPlainObject(raw) || !Number.isInteger(raw.ordinal) || (raw.ordinal as number) < 1) {
        throw new ValidationError(`Unsupported stop_rules[${index}]: needs a whole-number ordinal`);
      }
      const ordinal = raw.ordinal as number;
      if (seen.has(ordinal)) throw new ValidationError(`Unsupported stop_rules: ordinal ${ordinal} twice`);
      seen.add(ordinal);
      const edit: { ordinal: number; condition_text?: string; rule_kind?: string } = { ordinal };
      for (const [key, value] of Object.entries(raw)) {
        if (key === 'ordinal') continue;
        if (!(STOP_RULE_FIELDS as readonly string[]).includes(key)) {
          throw new ValidationError(`Unsupported field: stop_rules.${key}`, 'UNKNOWN_FIELD');
        }
        edit[key as (typeof STOP_RULE_FIELDS)[number]] = text(value, `stop_rules.${key}`, MAX_STOP_RULE_TEXT, true);
      }
      return edit;
    });
  }
  return request;
}

async function rowsOf(tx: PoolClient, table: string, organizationId: string, drillId: string): Promise<Row[]> {
  const { rows } = await tx.query<{ row: Row }>(
    `select to_jsonb(t) as row from pilot.${table} t where t.organization_id = $1 and t.drill_id = $2`,
    [organizationId, drillId],
  );
  return rows.map((r) => r.row);
}

async function insertCopies(tx: PoolClient, table: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.query(
    `insert into pilot.${table}
     select (jsonb_populate_record(null::pilot.${table}, x)).* from jsonb_array_elements($1::jsonb) x`,
    [JSON.stringify(rows)],
  );
}

const CHECK_FIELD: Readonly<Record<string, string>> = {
  pilot_drill_library_difficulty_check: 'difficulty',
  pilot_drill_library_contact_check: 'contact_level',
};

/** A value a CHECK refused is the request's fault: said as a 400, naming the constraint, never the SQL. */
function translateWriteError(error: unknown, name: string): never {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === '23514' && typeof constraint === 'string') {
    throw new ValidationError(`Unsupported value: ${CHECK_FIELD[constraint] ?? constraint}`, 'VALUE_NOT_ALLOWED');
  }
  if (code === '23505' && constraint === 'pilot_drill_library_one_active_name') {
    throw new ConflictError(`A drill named "${name}" already exists in this discipline. Choose another name.`, 'DRILL_NAME_TAKEN');
  }
  if (code === '23505' && (constraint === 'pilot_drill_library_lineage_version' || constraint === 'pilot_drill_library_one_head_per_lineage')) {
    throw new ConflictError('This drill changed while it was being edited. Reload it and try again.', 'DRILL_VERSION_STALE');
  }
  throw error;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Writes the edit as v(n+1), in one transaction with its labels and audit row.
 * Nothing that really changes -> nothing is written (`changed: false`).
 * Another gym's drill reads as not found; a version that is no longer the head
 * is refused (409) so an editor never overwrites a change they did not see.
 */
export async function editLibraryDrill(input: {
  organizationId: string;
  request: DrillLibraryEditRequest;
  actorAccountId: string;
  actorRole: PilotRole;
}): Promise<DrillLibraryEditResult> {
  const { organizationId, request } = input;
  return withTransaction(async (tx) => {
    const headResult = await tx.query<{ row: Row }>(
      `select to_jsonb(d) as row from pilot.drill_library d
        where d.organization_id = $1 and d.drill_id = $2
        for update`,
      [organizationId, request.drillId],
    );
    const head = headResult.rows[0]?.row;
    if (!head) throw new NotFoundError('Not found', 'DRILL_NOT_FOUND');
    if (head.superseded_at !== null) {
      throw new ConflictError('This is not the current version of the drill. Reload it and edit the current version.', 'DRILL_VERSION_STALE');
    }
    const lineageId = head.lineage_id as string;
    const headVersion = head.version as number;
    const headId = head.drill_id as string;

    const scales = await rowsOf(tx, 'drill_scale_levels', organizationId, headId);
    const stops = await rowsOf(tx, 'drill_stop_rules', organizationId, headId);
    const cues = await rowsOf(tx, 'drill_cues', organizationId, headId);

    // What really changes.
    const edited: EditedPart[] = [];
    const patch: Row = {};
    for (const [key, value] of Object.entries(request.fields)) {
      if (!same(head[key], value)) {
        patch[key] = value;
        edited.push({ field: key });
      }
    }

    const cueChange = request.cues !== undefined
      && !same([...cues.map((cue) => cue.cue_text as string)].sort(), [...request.cues].sort());
    if (cueChange) edited.push({ field: 'cues' });

    const scaleEdits = new Map<string, Row>();
    for (const [level, edit] of Object.entries(request.scaleLevels ?? {})) {
      const row = scales.find((scale) => scale.scale_level === level);
      if (!row) throw new ValidationError(`Unsupported scale_levels.${level}: this drill has no level ${level}`);
      const changes = Object.fromEntries(Object.entries(edit).filter(([key, value]) => !same(row[key], value)));
      if (Object.keys(changes).length > 0) {
        scaleEdits.set(level, changes);
        edited.push({ field: 'scale_levels', part: level });
      }
    }

    const stopEdits = new Map<number, Row>();
    for (const edit of request.stopRules ?? []) {
      const row = stops.find((stop) => Number(stop.ordinal) === edit.ordinal);
      if (!row) throw new ValidationError(`Unsupported stop_rules: this drill has no stop rule ${edit.ordinal}`);
      const { ordinal, ...fields } = edit;
      const changes = Object.fromEntries(Object.entries(fields).filter(([key, value]) => !same(row[key], value)));
      if (Object.keys(changes).length > 0) {
        stopEdits.set(ordinal, changes);
        edited.push({ field: 'stop_rules', part: String(ordinal) });
      }
    }

    const describe = (part: EditedPart) => (part.part === undefined ? part.field : `${part.field}.${part.part}`);
    if (edited.length === 0) {
      return { changed: false, drill_id: headId, lineage_id: lineageId, version: headVersion, previous_drill_id: null, edited: [] };
    }

    const name = (patch.name ?? head.name) as string;
    // THE CUE RULE (OD-2026-10-06-026 ruling 2, standing): judged when the cues
    // change, as every other drill write judges it. A library drill's
    // conditioning exemption follows its discipline, which an edit cannot
    // change, so the head's own row answers it (referenceDrillId = the head).
    if (cueChange) {
      await assertDrillMeetsCueRule({
        organizationId,
        name,
        category: (patch.category ?? head.category) as string,
        cues: request.cues ?? [],
        referenceDrillId: headId,
      }, tx);
    }

    const newVersion = headVersion + 1;
    const newId = MINT.drillVersion(lineageId, newVersion);
    const at = new Date().toISOString();

    try {
      // Superseded first: one head per lineage and one current name per
      // discipline are both partial on superseded_at is null.
      await tx.query(
        `update pilot.drill_library set superseded_at = now(), updated_at = now()
          where organization_id = $1 and drill_id = $2 and superseded_at is null`,
        [organizationId, headId],
      );
      await tx.query(
        `insert into pilot.drill_library
         select (jsonb_populate_record(null::pilot.drill_library,
                  to_jsonb(d) || $3::jsonb
                  || jsonb_build_object('superseded_at', null, 'created_at', now(), 'updated_at', now()))).*
           from pilot.drill_library d
          where d.organization_id = $1 and d.drill_id = $2`,
        [organizationId, headId, JSON.stringify({
          ...patch,
          drill_id: newId,
          version: newVersion,
          supersedes_drill_id: headId,
          created_by_account_id: input.actorAccountId,
          created_by_role: input.actorRole,
        })],
      );

      await insertCopies(tx, 'drill_scale_levels', scales.map((row) => ({
        ...row,
        ...(scaleEdits.get(row.scale_level as string) ?? {}),
        drill_id: newId,
        scale_id: MINT.scale(newId, row.scale_level as string),
      })));
      await insertCopies(tx, 'drill_stop_rules', stops.map((row) => ({
        ...row,
        ...(stopEdits.get(Number(row.ordinal)) ?? {}),
        drill_id: newId,
        stop_rule_id: MINT.stopRule(newId, String(row.ordinal)),
      })));

      // Cues: a cue the editor kept keeps its family, focus type and evidence
      // note; a new one takes the table's defaults.
      const keptTexts = request.cues ?? cues.map((cue) => cue.cue_text as string);
      const kept = keptTexts.map((cueText) => cues.find((cue) => cue.cue_text === cueText));
      await insertCopies(tx, 'drill_cues', kept.filter((cue): cue is Row => cue !== undefined).map((row) => ({
        ...row,
        drill_id: newId,
        cue_id: MINT.cue(newId, row.cue_text as string),
      })));
      for (const cueText of keptTexts.filter((_, index) => kept[index] === undefined)) {
        await tx.query(
          `insert into pilot.drill_cues (organization_id, cue_id, drill_id, cue_text) values ($1, $2, $3, $4)`,
          [organizationId, MINT.cue(newId, cueText), newId, cueText],
        );
      }

      await insertCopies(tx, 'drill_secondary_skills',
        (await rowsOf(tx, 'drill_secondary_skills', organizationId, headId)).map((row) => ({ ...row, drill_id: newId })));
      await insertCopies(tx, 'transfer_claims',
        (await rowsOf(tx, 'transfer_claims', organizationId, headId)).map((row) => ({
          ...row,
          drill_id: newId,
          transfer_id: MINT.transfer(newId, row.claim_kind as string, row.statement as string),
        })));
    } catch (error) {
      translateWriteError(error, name);
    }

    const editId = randomUUID();
    await writeEditedVersionLabels(tx, {
      organizationId,
      dataset: 'drill-library',
      lineageId,
      fromVersion: headVersion,
      toVersion: newVersion,
      editId,
      editor: { accountId: input.actorAccountId, role: input.actorRole, at },
      edited,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.actorAccountId,
      actor_role: input.actorRole,
      organization_id: organizationId,
      entity_type: 'drill_library',
      entity_id: newId,
      details: {
        action: 'in_app_edit',
        edit_id: editId,
        lineage_id: lineageId,
        version: newVersion,
        from_drill_id: headId,
        edited: edited.map(describe),
      },
    }, tx);

    return {
      changed: true,
      drill_id: newId,
      lineage_id: lineageId,
      version: newVersion,
      previous_drill_id: headId,
      edited: edited.map(describe),
    };
  });
}
