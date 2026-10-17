#!/usr/bin/env node
//
// The verdict of ci.yml's required `validate` check, read from `needs`.
//
// WHY THIS EXISTS. Until lane L38, `validate` was one job running every gate in
// series, and a PR that needed the PostgreSQL suite took 55-60 minutes; three
// runs on 2026-10-17 were cancelled at the 60-minute limit with every suite
// they ran green. ci.yml now runs the gates as parallel jobs (classify, static,
// unit, pg, e2e) and `validate` is a final job that only judges them. Branch
// protection, Overwatch's auto-merge and every lane wait on that one name.
//
// WHAT IT MUST NOT DO is pass on a part that did not run. A job whose `needs`
// failed or were skipped is itself skipped unless it says `if: always()`, and
// a skipped required check counts as passing -- so `validate` runs always(),
// and it is this script, not GitHub, that tells "skipped because the diff did
// not touch that surface" from "skipped because something upstream broke".
// It does that from classify's own flags:
//
//   classify   must succeed, and every flag must be exactly 'true' or 'false'
//   static     runs unless docs-only
//   unit       runs unless docs-only
//   pg         runs unless docs-only, when migrations is true
//   e2e        runs unless docs-only, when any *_e2e flag is true
//
// A part that had to run passes only as `success`; one that had not to run
// passes only as `skipped`. Anything else -- failure, cancelled, skipped when
// needed, ran when not needed -- is red. So is a `needs` entry this table does
// not know, or a part of this table missing from `needs`: adding a job without
// teaching the gate about it must not pass quietly.
//
// Input: env NEEDS = ${{ toJSON(needs) }}. Exit 0 green, 1 red.

import fs from 'node:fs';

/** Whether each part had to run, given classify's flags (booleans). */
export const PARTS = {
  static: (flags) => !flags.docs_only,
  unit: (flags) => !flags.docs_only,
  pg: (flags) => !flags.docs_only && flags.migrations,
  e2e: (flags) =>
    !flags.docs_only &&
    Object.entries(flags).some(([name, value]) => name.endsWith('_e2e') && value),
};

const REQUIRED_FLAGS = ['docs_only', 'migrations'];

/** Judge a `needs` object. Returns { ok, lines } -- one line per finding. */
export function judge(needs) {
  const lines = [];
  const fail = (line) => lines.push(`FAIL ${line}`);

  if (!needs || typeof needs !== 'object') {
    return { ok: false, lines: ['FAIL needs is not an object'] };
  }

  const classify = needs.classify;
  if (!classify || classify.result !== 'success') {
    fail(`classify: result ${classify ? classify.result : 'missing'}, expected success`);
    return { ok: false, lines };
  }

  const outputs = classify.outputs || {};
  const flags = {};
  for (const [name, value] of Object.entries(outputs)) {
    if (name !== 'docs_only' && name !== 'migrations' && !name.endsWith('_e2e')) continue;
    if (value !== 'true' && value !== 'false') {
      fail(`classify: output ${name}=${JSON.stringify(value)}, expected 'true' or 'false'`);
      continue;
    }
    flags[name] = value === 'true';
  }
  for (const name of REQUIRED_FLAGS) {
    if (!(name in outputs)) fail(`classify: output ${name} missing`);
  }
  if (!Object.keys(outputs).some((name) => name.endsWith('_e2e'))) {
    fail('classify: no *_e2e outputs');
  }
  if (lines.length > 0) return { ok: false, lines };

  for (const name of Object.keys(needs)) {
    if (name !== 'classify' && !(name in PARTS)) {
      fail(`${name}: a needs entry the gate does not know; add it to PARTS in scripts/ci-validate-gate.mjs`);
    }
  }

  for (const [name, mustRun] of Object.entries(PARTS)) {
    const part = needs[name];
    if (!part) {
      fail(`${name}: missing from validate's needs`);
      continue;
    }
    const expected = mustRun(flags) ? 'success' : 'skipped';
    if (part.result === expected) {
      lines.push(`ok   ${name}: ${part.result}`);
    } else {
      fail(`${name}: result ${part.result}, expected ${expected}`);
    }
  }

  return { ok: !lines.some((line) => line.startsWith('FAIL')), lines };
}

const isMainModule =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  let needs;
  try {
    needs = JSON.parse(process.env.NEEDS ?? '');
  } catch {
    needs = undefined;
  }
  const { ok, lines } = judge(needs);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['### validate', '', '```text', ...lines, '```', ''].join('\n'),
    );
  }
  process.exit(ok ? 0 : 1);
}
