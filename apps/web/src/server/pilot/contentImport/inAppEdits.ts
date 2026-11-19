import type { DbClient } from './actor';

// A COACH'S IN-APP EDIT IS NEVER SILENTLY SUPERSEDED BY AN IMPORT (lane IG;
// OD-2026-11-19-005, OW25-51: coaches and organization admins edit library
// drills and workout templates in the app, each edit a new version labelled
// REPORTED "In-app edit"; drillLibraryEdit.ts, workoutTemplateEdit.ts).
//
// THE GAP THIS CLOSES. A content import compares the package with the current
// version of each lineage and, when they differ, writes v(n+1) -- it never
// asked who wrote the current one. A later package (the Backbone seed, say)
// therefore wrote v(n+2) over the coach's text without a word, and carried the
// coach's "In-app edit" labels onto text the coach did not write.
//
// THE RULE. A unit that would be a new version over a current version that
// holds an in-app edit is HELD instead (datasets/index.ts): nothing is written
// for it, the plan says why, and nothing else in the package waits on it. The
// coach's edit wins (Overwatch, F1 = A: no override); a coach who wants the
// package's text back edits it in the app. A held item is listed on every plan
// and dry run until then.
//
// HOW AN IN-APP EDIT IS RECOGNISED, either of:
//   (a) the current version's stored field_labels hold an in-app label at any
//       depth (contentLabels.ts#inAppEditLabel). The edit paths carry earlier
//       in-app labels forward, so a coach's text edited two versions ago
//       still counts;
//   (b) pilot.audit_events holds an in_app_edit event on the current version's
//       id (the edit paths write one in the same transaction), which catches an
//       edit made before the label table existed.
// NOT created_by_*: the importer writes its own actor there too.

/** The source an in-app edit's label names (contentLabels.ts#inAppEditLabel). */
export const IN_APP_EDIT_SOURCE = 'In-app edit';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True for a label written by an in-app edit: it names the "In-app edit"
 * source, or it records the editor (`edited`) and is not an AI draft.
 */
export function isInAppEditLabel(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (Array.isArray(value.sources) && value.sources.includes(IN_APP_EDIT_SOURCE)) return true;
  return isPlainObject(value.edited) && !('draft' in value);
}

export interface FoundInAppLabel {
  /** Where in field_labels: 'purpose', 'scale_levels.A'. */
  path: string;
  label: Record<string, unknown>;
}

/**
 * Every in-app label in a field_labels object, at any depth (a field, or a
 * part of a field such as a scale level). Accepts the object or its JSON text;
 * unreadable text has none (the validator reports it).
 */
export function findInAppEditLabels(fieldLabels: unknown): FoundInAppLabel[] {
  let root = fieldLabels;
  if (typeof root === 'string') {
    if (!root.trim()) return [];
    try {
      root = JSON.parse(root);
    } catch {
      return [];
    }
  }
  const out: FoundInAppLabel[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      // A label's own sources and editor record are not labels.
      if (key === 'sources' || key === 'edited') continue;
      const at = path ? `${path}.${key}` : key;
      if (isInAppEditLabel(value)) out.push({ path: at, label: value as Record<string, unknown> });
      walk(value, at);
    }
  };
  walk(root, '');
  return out;
}

export interface InAppEditedHead {
  /** The first edited field or part, for the plan line; undefined when only the audit row says so. */
  path?: string;
  role?: string;
  /** YYYY-MM-DD of the edit, when known. */
  date?: string;
}

export interface HeadToCheck {
  lineage: string;
  /** The current version's row id (drill_id, template_id). */
  id: string;
  /** field_labels of the current version as overlaid (contentLabels.ts#overlayStoredLabels): JSON text, or undefined. */
  fieldLabels: unknown;
}

function day(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

/**
 * Which of `heads` hold an in-app edit, by lineage. `auditEntityType` is the
 * audit_events entity_type the edit path writes (drill_library,
 * workout_template); undefined skips (b).
 */
export async function inAppEditedHeads(
  client: DbClient,
  organizationId: string,
  auditEntityType: string | undefined,
  heads: readonly HeadToCheck[],
): Promise<Map<string, InAppEditedHead>> {
  const out = new Map<string, InAppEditedHead>();
  for (const head of heads) {
    const [first] = findInAppEditLabels(head.fieldLabels);
    if (!first) continue;
    const edited = isPlainObject(first.label.edited) ? first.label.edited : {};
    out.set(head.lineage, {
      path: first.path,
      role: typeof edited.by_role === 'string' ? edited.by_role : undefined,
      date: day(edited.at),
    });
  }

  const unchecked = heads.filter((head) => !out.has(head.lineage));
  if (!auditEntityType || unchecked.length === 0) return out;
  const { rows: ready } = await client.query<{ ready: boolean }>(`select to_regclass('pilot.audit_events') is not null as ready`);
  if (ready[0]?.ready !== true) return out;
  const { rows } = await client.query<{ entity_id: string; actor_role: string | null; created_at: unknown }>(
    `select entity_id, actor_role, created_at from pilot.audit_events
      where organization_id = $1 and entity_type = $2 and entity_id = any($3::text[])
        and details->>'action' = 'in_app_edit'
      order by created_at desc`,
    [organizationId, auditEntityType, unchecked.map((head) => head.id)],
  );
  for (const row of rows) {
    const head = unchecked.find((candidate) => candidate.id === row.entity_id);
    if (!head || out.has(head.lineage)) continue;
    out.set(head.lineage, { role: row.actor_role ?? undefined, date: day(row.created_at) });
  }
  return out;
}

/** The plan line's reason for an item held over an in-app edit. */
export function heldReason(version: number, edit: InAppEditedHead): string {
  const who = [edit.role, edit.date].filter(Boolean).join(', ');
  return `kept: its current version v${version} holds an in-app edit${edit.path ? ` (${edit.path})` : ''}${who ? ` by ${who}` : ''}; `
    + 'the package\'s version was not loaded. A coach who wants the package\'s text edits it in the app.';
}
