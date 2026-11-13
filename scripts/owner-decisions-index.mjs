import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Index of rulings at the top of docs/current/OWNER_DECISIONS.md (OD-2026-11-11-001,
// "G1 A"): one row per "## OD-" entry -- id, date, topic, provenance, status, and
// whether the entry carries a "Not ruled here" paragraph. The index is a table of
// contents generated from the entries, never a second record (OD-2026-09-28-003).
//
// STATUS comes ONLY from a fixed-form line in the entry:
//   **Status, YYYY-MM-DD:** replaced by OD-...
//   **Status, YYYY-MM-DD:** partly replaced by OD-... (<what part>)
//   **Status, YYYY-MM-DD:** withdrawn ...
// No keyword search sets a status. A blank status means "no checked replacement
// recorded", not "in force".
//
// No install needed, so ci.yml runs --check ahead of the docs-only fast path.
// apps/web/src/docs/ownerDecisionsIndex.test.ts runs it on the real file and on
// planted cases.
//
// Usage: node scripts/owner-decisions-index.mjs [--check|--write] [path-to-decisions-file]

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = args.includes('--write') ? 'write' : 'check';
const fileArg = args.find((a) => !a.startsWith('--'));
const file = fileArg ?? path.join(repositoryRoot, 'docs/current/OWNER_DECISIONS.md');

const START = '<!-- owner-decisions-index:start -->';
const END = '<!-- owner-decisions-index:end -->';
const FIX = 'node scripts/owner-decisions-index.mjs --write';
const OPENING_END = /^evidence each was made on\.$/;
const OD_ID_RE = /OD-\d{4}-\d{2}-\d{2}-\d{3}/g;
const HEADING = /^## (OD-(\d{4}-\d{2}-\d{2})-\d{3})(?:\s+(?:--|—)\s+(.*))?$/;
const STATUS_LINE = /^\*\*Status, (\d{4}-\d{2}-\d{2}):\*\* (replaced by|partly replaced by|withdrawn)\b(.*)$/;
const MIN_ENTRIES = 40;

const LEGEND = [
  'One row per `## OD-` entry, generated from the entries below by `scripts/owner-decisions-index.mjs`;',
  'CI fails if it is out of date. This table is a table of contents, not a second record',
  '(OD-2026-09-28-003): the entries below are the record, word for word.',
  '',
  '**Status** is read only from a fixed-form dated line in the entry:',
  '`**Status, YYYY-MM-DD:** replaced by OD-...`, `partly replaced by OD-... (<part>)` or `withdrawn ...`.',
  'No keyword search sets it. **A blank status means "no checked replacement recorded". It is not a claim that the entry is in force.**',
  '**Not ruled here** is "yes" when the entry has a `**Not ruled here` paragraph.',
  'Cost: every PR that adds an entry, or a fixed-form Status line, must run `' + FIX + '` and commit the result.',
];

function fail(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (error) {
  fail([`Owner decisions index: cannot read ${file}: ${error.message}`]);
}

const cell = (s) => s.replace(/\|/g, '\\|').trim();

function parseEntries(lines) {
  const entries = [];
  let cur = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      const m = HEADING.exec(line);
      cur = null;
      if (m) {
        cur = { id: m[1], date: m[2], topic: (m[3] ?? '').replace(/:\s+"[^"]*"$/, ''), provenance: '', statuses: [], notRuled: false };
        entries.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    const p = /^\*\*Provenance: ([A-Za-z]+)/.exec(line);
    if (p && !cur.provenance) cur.provenance = p[1];
    if (/^\*\*Not ruled here/.test(line)) cur.notRuled = true;
    const s = STATUS_LINE.exec(line);
    if (s) cur.statuses.push({ date: s[1], kind: s[2], rest: s[3] });
  }
  return entries;
}

function statusCell(entry, known, problems) {
  return entry.statuses.map((st) => oneStatus(entry, st, known, problems)).filter(Boolean).join('; ');
}

function oneStatus(entry, st, known, problems) {
  if (st.kind === 'withdrawn') return `withdrawn (${st.date})`;
  const idsPart = /^\s+((?:OD-\d{4}-\d{2}-\d{2}-\d{3}(?:,\s*|\s+and\s+|\s*&\s*)?)+)/.exec(st.rest);
  const ids = idsPart ? idsPart[1].match(OD_ID_RE) : null;
  if (!ids) {
    problems.push(`${entry.id}: Status line "${st.kind}" does not name an OD id right after it`);
    return '';
  }
  for (const id of ids) {
    if (!known.has(id)) problems.push(`${entry.id}: Status line names ${id}, which heads no entry`);
    if (id === entry.id) problems.push(`${entry.id}: Status line names the entry itself`);
  }
  let out = `${st.kind} ${ids.join(', ')}`;
  if (st.kind === 'partly replaced by') {
    const part = /^\s*\(([^)]+)\)/.exec(st.rest.slice(idsPart[0].length));
    if (!part) problems.push(`${entry.id}: "partly replaced by" must name the part in parentheses`);
    else out += ` (${part[1]})`;
  }
  return `${out} (${st.date})`;
}

function buildBlock(entries, problems) {
  const known = new Set(entries.map((e) => e.id));
  const rows = entries.map((e) =>
    `| ${e.id} | ${e.date} | ${cell(e.topic)} | ${e.provenance} | ${cell(statusCell(e, known, problems))} | ${e.notRuled ? 'yes' : ''} |`,
  );
  return [
    START,
    '<!-- Generated. Do not edit between these markers; run `' + FIX + '`. -->',
    '',
    ...LEGEND,
    '',
    '| Id | Date | Topic | Provenance | Status | Not ruled here |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    END,
  ].join('\n');
}

const lines = text.split('\n');
const entries = parseEntries(lines);
const problems = [];
if (entries.length < MIN_ENTRIES) problems.push(`only ${entries.length} "## OD-" entries found (expected at least ${MIN_ENTRIES}); wrong file?`);
const block = buildBlock(entries, problems);
if (problems.length > 0) fail(['Owner decisions index failed:', ...problems.map((p) => `- ${p}`)]);

const startAt = text.indexOf(START);
const endAt = text.indexOf(END);
const hasBlock = startAt !== -1 && endAt > startAt;

let next;
if (hasBlock) {
  next = text.slice(0, startAt) + block + text.slice(endAt + END.length);
} else {
  const at = lines.findIndex((l) => OPENING_END.test(l));
  if (at === -1) fail(['Owner decisions index: no index markers and no opening paragraph ("... evidence each was made on.") to place one after.']);
  lines.splice(at + 1, 0, '', '## Index of rulings', '', block);
  next = lines.join('\n');
}

if (mode === 'write') {
  if (next !== text) fs.writeFileSync(file, next);
  console.log(`Owner decisions index: ${entries.length} rows ${next !== text ? 'written' : 'already current'}.`);
} else if (next !== text) {
  fail([`Owner decisions index is out of date (${hasBlock ? 'rows differ from the entries' : 'no index block'}).`, `Fix: ${FIX}`]);
} else {
  console.log(`Owner decisions index: ${entries.length} rows, current.`);
}
