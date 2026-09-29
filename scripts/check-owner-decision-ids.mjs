import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One owner decision id names one decision. docs/current/OWNER_DECISIONS.md is
// where Jason's decisions are recorded (OD-2026-09-28-003), and documents,
// tests and PRs cite them by id. #986 and #975 each created an
// OD-2026-09-26-001 because each took "the next free number" from its own
// branch; #989 then had to repoint code comments. This refuses a malformed
// "## OD-" heading and any id that heads two entries.
//
// No install needed, so ci.yml runs it ahead of the docs-only fast path: a new
// decision entry is usually a docs-only change, which skips `npm test`.
// apps/web/src/docs/ownerDecisionIds.test.ts runs this script against the real
// file and against planted collisions.
//
// Usage: node scripts/check-owner-decision-ids.mjs [path-to-decisions-file]

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? path.join(repositoryRoot, 'docs/current/OWNER_DECISIONS.md');

const OD_HEADING = /^## OD-/;
const OD_ID = /^## (OD-\d{4}-\d{2}-\d{2}-\d{3})(?=\s|$)/;
// Floor only guards against reading nothing (44 entries on 2026-09-28).
const MIN_ENTRIES = 40;

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (error) {
  console.error(`Owner decision id check: cannot read ${file}: ${error.message}`);
  process.exit(1);
}

const ids = [];
const malformed = [];
text.split(/\r?\n/).forEach((line, index) => {
  if (!OD_HEADING.test(line)) return;
  const match = OD_ID.exec(line);
  if (match) ids.push(match[1]);
  else malformed.push(`line ${index + 1}: ${line}`);
});

const seen = new Set();
const repeated = new Set();
for (const id of ids) {
  if (seen.has(id)) repeated.add(id);
  seen.add(id);
}

const problems = [];
if (ids.length < MIN_ENTRIES) {
  problems.push(`only ${ids.length} "## OD-" entries found (expected at least ${MIN_ENTRIES}); wrong file?`);
}
for (const line of malformed) problems.push(`malformed id heading, ${line}`);
for (const id of [...repeated].sort()) problems.push(`${id} heads more than one entry`);

if (problems.length > 0) {
  console.error('Owner decision id check failed:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Owner decision ids: ${ids.length} entries, all well-formed, none repeated.`);
