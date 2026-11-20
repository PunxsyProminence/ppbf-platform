// TWO STOPS FOR THE BACKBONE EXPORTERS THAT NO FLAG PASSES
// (lane GD; Overwatch Q2 = A and C1 on #2042).
//
// The exporters (scripts/backbone-export-*.mjs) re-write committed seed files from the frozen
// Backbone. Each has an OVERWRITE GUARD, and --allow-overwrite passes it on purpose. Two things the
// frozen Backbone holds must never come back that way, so these stops do not look at that flag:
//
//   HELD TEXT. Six DOC-136 home sessions are held out of this public repository
//   (OD-2026-10-02-013 answer 2A; OW25-49 (c), OD-2026-11-19-005: they stay held and are never
//   loaded). The frozen Backbone still names them -- a track's session_refs and groups carry
//   their ids and source lines -- and lane HW (#1980) took that text out of the committed track
//   row. A row an exporter is about to write that names a held template id, or carries the
//   DOC-136 source key, stops the run. The held ids are kept here as hashes, so this file names
//   no held record.
//
//   TYPED LINES. A template step with no drill_id is a typed line. Typed lines are to become
//   library drills (OW26-05 "B: Turn typed lines into library drills", OD-2026-11-19-030;
//   OW27-09 "B: A new drill for every line", OD-2026-11-20-001): a later lane sets the step's
//   drill_id. The frozen Backbone keeps the typed line, so a committed step that links a drill
//   is never written back as a typed line.
//
// A finding names the file, the row and the column -- never the held text, and never a held id.
// The exporter throws before any file is produced, as its overwrite guard does.

import { createHash } from 'node:crypto';

/** The source key of the held sheets. The key is public; what the sheets say is not. */
export const HELD_SOURCE_KEY = 'DOC-136';

/**
 * sha256 (first 16 hex characters) of each held template id: six held records, none listed by id.
 * backbone-export-guards.test.ts holds this list to the youth-recreational exporter's own.
 */
export const HELD_ID_HASHES = Object.freeze([
  '1438ce3e53ab6f52',
  '57dfa625ba5cfa30',
  '719783bb92502d36',
  'bb2605371c7b8702',
  'c96da59c208e814d',
  'fdb8f0adbde362ba',
]);

export function hashOfId(id) {
  return createHash('sha256').update(String(id), 'utf8').digest('hex').slice(0, 16);
}

const TEMPLATE_ID = /\bwtp_[0-9a-f]{14}\b/g;
const SOURCE_KEY = new RegExp(`(?<![A-Za-z0-9-])${HELD_SOURCE_KEY}(?![0-9])`);

/** How a finding names a row: its first id column, and never a held id. */
function rowLabel(header, row, index, held) {
  const column = header.find((name) => name.endsWith('_id') && name !== 'organization_id' && (row[name] ?? '') !== '');
  if (!column) return `row ${index + 1}`;
  return held.has(hashOfId(row[column])) ? `${column} (a held record)` : `${column} ${row[column]}`;
}

/**
 * The cells of `rows` that name a held record: a held template id, or the DOC-136 source key.
 * `rows` are objects keyed by column, `header` the file's columns in order.
 * Returns [{ kind: 'held_text', file, row, column }].
 */
export function heldTextFindings(file, header, rows, heldHashes = HELD_ID_HASHES) {
  const held = new Set(heldHashes);
  const found = [];
  rows.forEach((row, index) => {
    for (const column of header) {
      const cell = row[column];
      if (typeof cell !== 'string' || cell === '') continue;
      const namesHeldId = (cell.match(TEMPLATE_ID) ?? []).some((id) => held.has(hashOfId(id)));
      if (namesHeldId || SOURCE_KEY.test(cell)) found.push({ kind: 'held_text', file, row: rowLabel(header, row, index, held), column });
    }
  });
  return found;
}

/**
 * The committed template steps that link a drill and that `newRows` would write back as a typed
 * line (a blank drill_id). A step is matched by its template and position, so one re-minted under
 * a new item_id is still the same step. A committed step the export no longer has is not one of
 * these: the overwrite guard names a removed row.
 * Returns [{ kind: 'typed_line', file, template, ordinal, drill }].
 */
export function typedLineFindings(file, committedRows, newRows) {
  const position = (row) => `${row.template_id ?? ''}\u0000${Number(row.ordinal)}`;
  const fresh = new Map(newRows.map((row) => [position(row), row]));
  const found = [];
  for (const old of committedRows) {
    if ((old.drill_id ?? '') === '') continue;
    const next = fresh.get(position(old));
    if (next && (next.drill_id ?? '') === '') {
      found.push({ kind: 'typed_line', file, template: old.template_id, ordinal: String(old.ordinal), drill: old.drill_id });
    }
  }
  return found;
}

/** One line per finding, as the overwrite guards print theirs. */
export function describeStops(findings) {
  return findings.map((found) => (found.kind === 'typed_line'
    ? `  ${found.file} template_id ${found.template}: step ${found.ordinal} links drill ${found.drill}; the export would write it back as a typed line`
    : `  ${found.file} ${found.row}: ${found.column} names a held ${HELD_SOURCE_KEY} record`));
}

/**
 * The refusal for `findings`, or null when there are none. The caller throws it before producing a
 * file, whatever --allow-overwrite says.
 */
export function stopMessage(findings) {
  if (findings.length === 0) return null;
  const held = findings.filter((found) => found.kind === 'held_text').length;
  const typed = findings.length - held;
  const what = [
    ...(held ? [`write ${held} cell(s) that name a held ${HELD_SOURCE_KEY} record (held out of this repository, OW25-49 (c))`] : []),
    ...(typed ? [`write ${typed} typed line(s) back over a step that links a drill (OW26-05 B, OW27-09 B)`] : []),
  ].join(', and ');
  return [
    `refused: this run would ${what}. Nothing was written, and --allow-overwrite does not change that.`,
    ...describeStops(findings),
  ].join('\n');
}
