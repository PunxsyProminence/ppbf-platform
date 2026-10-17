import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One status per capability module, and the status matches the code.
// docs/capabilities/modules/NNN-*.md is the only place build status lives
// (OD-2026-09-28-010 item 17). Jason, 2026-10-16: "Fix capability-status
// truth: DONE, mapped, claimed/no-code, DRAFT. These need to be unambiguous."
//
// A module's header table carries three rows this script reads, and nothing
// else in the file counts as evidence (audit-log history does not):
//   | Status | **DONE** |          one of the four tokens below, nothing else
//   | Code   | `path`, `path` |    repository-relative paths, or `none`
//   | Tests  | `path` |            repository-relative test files, or `none`
// An optional `| Status note |` row holds any prose about the status.
//
//   DONE             the slice is on main: Code names an existing route.ts or
//                    page.tsx (a role can reach it) and Tests names an
//                    existing test file.
//   MAPPED           existing code serves the capability, wholly or in part,
//                    but it is not DONE (no reachable entry point, or no test).
//   CLAIMED-NO-CODE  was recorded DONE and no code serves it; kept until Jason
//                    walks it through (OD-2026-09-28-010 item 18). Only the
//                    modules in CLAIMED_NO_CODE below may carry it.
//   DRAFT            designed or stubbed; no code.
//
// ManualVerification (whether a person has tried it) is a separate row and is
// checked by apps/web/src/docs/capabilityEvidence.test.ts, not here.
//
// No install needed, so ci.yml runs it ahead of the docs-only fast path: a
// module file is documentation, and that path skips `npm test`.
// apps/web/src/docs/capabilityStatus.test.ts runs it against the real modules
// and against one planted violation per rule.
//
// Usage: node scripts/check-capability-status.mjs [modules-dir]

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulesDir = process.argv[2] ?? path.join(repositoryRoot, 'docs/capabilities/modules');

// Every module carries the Code and Tests rows (since 2026-10-16, lane L32).
// A module without them fails. False only while a bulk move is in flight.
const REQUIRE_ALL = true;

// The modules carrying "claimed, no code" under OD-2026-09-28-010 item 18:
// recorded DONE, no code behind them. The only way on is that ruling (a DONE
// found to have no code; 056 and 149 joined 2026-10-16). The ways off are
// Jason's walk-through, or code landing (007, 014 and 037 left 2026-10-16).
const CLAIMED_NO_CODE = new Set(['022', '028', '056', '064', '065', '149']);

const STATUSES = ['DONE', 'MAPPED', 'CLAIMED-NO-CODE', 'DRAFT'];
const TEST_FILE = /\.(test|spec)\.(tsx?|mjs|js)$/;
const ENTRY_POINT = /(^|\/)(route\.ts|page\.tsx)$/;
// Floor only guards against reading nothing (201 module files on 2026-10-16).
const MIN_MODULES = 200;

function row(text, name) {
  const match = new RegExp(`^\\|\\s*${name}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm').exec(text);
  return match ? match[1] : null;
}

function paths(cell) {
  if (cell.trim() === 'none') return [];
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
}

let files;
try {
  files = fs.readdirSync(modulesDir).filter((f) => /^\d{3}[a-z]?-.*\.md$/.test(f)).sort();
} catch (error) {
  console.error(`Capability status check: cannot read ${modulesDir}: ${error.message}`);
  process.exit(1);
}

const errors = [];
const legacy = [];
const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));

for (const file of files) {
  const id = file.slice(0, 3);
  const text = fs.readFileSync(path.join(modulesDir, file), 'utf8');
  const statusCell = row(text, 'Status');
  const codeCell = row(text, 'Code');
  const testsCell = row(text, 'Tests');
  const fail = (message) => errors.push(`${file}: ${message}`);

  if (codeCell === null && testsCell === null) {
    legacy.push(file);
    continue;
  }
  if (codeCell === null || testsCell === null) {
    fail('has one of the Code and Tests rows but not the other');
    continue;
  }

  const status = /^\*{0,2}([A-Z-]+)\*{0,2}$/.exec(statusCell ?? '')?.[1];
  if (!status || !STATUSES.includes(status)) {
    fail(`Status must be exactly one of ${STATUSES.join(', ')} (found "${statusCell}"); put prose in a "Status note" row`);
    continue;
  }
  counts[status] += 1;

  const code = paths(codeCell);
  const tests = paths(testsCell);
  if (code.length === 0 && codeCell.trim() !== 'none') fail('Code row lists no `path` and is not `none`');
  if (tests.length === 0 && testsCell.trim() !== 'none') fail('Tests row lists no `path` and is not `none`');
  for (const p of [...code, ...tests]) {
    if (!fs.existsSync(path.join(repositoryRoot, p))) fail(`cites missing ${p} (paths are repository-relative)`);
  }
  for (const p of code) if (TEST_FILE.test(p)) fail(`Code row cites a test file, ${p}; it belongs in Tests`);
  for (const p of tests) if (!TEST_FILE.test(p)) fail(`Tests row cites ${p}, which is not a test file`);

  if (status === 'DONE') {
    if (!code.some((p) => ENTRY_POINT.test(p))) fail('DONE needs a route.ts or page.tsx in Code (a way in for a role)');
    if (tests.length === 0) fail('DONE needs at least one test file in Tests');
  }
  if (status === 'MAPPED' && code.length === 0) fail('MAPPED needs at least one existing path in Code');
  if ((status === 'DRAFT' || status === 'CLAIMED-NO-CODE') && code.length > 0) {
    fail(`${status} means no code, but Code cites ${code.length} path(s): MAPPED or DONE`);
  }
  if (status === 'CLAIMED-NO-CODE' && !CLAIMED_NO_CODE.has(id)) {
    fail('CLAIMED-NO-CODE is only for the modules relabelled under OD-2026-09-28-010 item 18');
  }
}

if (files.length < MIN_MODULES) errors.push(`only ${files.length} module files found (floor ${MIN_MODULES})`);
if (REQUIRE_ALL) for (const file of legacy) errors.push(`${file}: no Code and Tests rows`);

const summary = STATUSES.map((s) => `${s} ${counts[s]}`).join(', ');
if (errors.length > 0) {
  console.error(`Capability status check FAILED (${errors.length}):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`Capability status: ${files.length} modules; ${summary}; not yet in the format: ${legacy.length}`);
if (legacy.length > 0 && !REQUIRE_ALL) {
  console.log(`  (reported, not failed until REQUIRE_ALL: ${legacy.slice(0, 5).join(', ')}${legacy.length > 5 ? ', ...' : ''})`);
}
