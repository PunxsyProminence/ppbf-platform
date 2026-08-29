#!/usr/bin/env node
//
// Checks every open pull request's CONTESTED declaration against what the open
// pull requests actually touch.
//
// WHY THIS EXISTS. `CONTESTED:` is an absence claim, written by hand, about a
// set that moves hourly. The release lane sequences a merge window from it, so
// a wrong one lands two branches into the same file with nobody expecting it.
//
// Measured on 2026-08-29, over 20 open pull requests: seven declared
// `CONTESTED: none`, and FIVE of those overlapped eleven or twelve other open
// branches -- mostly on `apps/web/package.json` and
// `.github/workflows/apply-migrations.yml`. The two that were right were right.
//
// The interesting part is that none of the five was careless. Each was true
// when it was written and went stale when the board moved. #863 is the proof:
// its declaration named three files nothing else touched, was measured
// correctly against the 14 pull requests open at the time, and was false within
// the hour because #867 and #868 opened. A hand-written snapshot of a moving
// set is wrong by construction eventually, and the only fix is to measure it at
// the moment somebody acts on it.
//
// WHY THIS IS NOT A PULL-REQUEST CHECK, deliberately. Its answer depends on
// what OTHER branches are open, so as a required check it would be
// non-deterministic with respect to the commit: a green pull request would turn
// red because somebody else opened one, with no push of its own. That is a
// check nobody can act on and everybody learns to re-run. It also would have
// turned five open branches red the day it landed, for a condition none of
// their authors controls.
//
// So it is a manual dispatch, in run-checks.yml, next to the other read-only
// checks, and it follows that workflow's own taxonomy: it is a GATE, exiting
// non-zero when a human still has to decide something. A red run is a finding.
// The moment to dispatch it is when the release lane is sequencing a window --
// which is the moment the declaration is actually read.
//
// WHAT IT DOES NOT DO. It compares FILE SETS. Two branches that share no file
// can still collide semantically -- #716 and #718 were each green alone and
// broke `main` together over a documentation constant -- and nothing here sees
// that. It also does not grade the prose: a declaration that names files is
// taken at its word and only reported against, never failed, because deciding
// whether prose covers a path is the judgement this cannot make.

import process from 'node:process';

/** Bare-none spellings. A declaration is only FAILED when it asserts nothing. */
const NONE_TOKENS = ['none', 'nothing', 'n/a', 'na', 'no contested files'];

/**
 * Pull the CONTESTED value out of a pull request body.
 *
 * The field sits in a fenced brief header with the other declarations, and its
 * value may run over indented continuation lines until the next ALLCAPS field.
 * Same shape check-migration-declaration.mjs reads MIGRATIONS from, and read
 * the same way: first match wins, because a body may quote the template lower
 * down and the real declaration is the one at the top.
 */
export function parseContested(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  for (const [index, line] of lines.entries()) {
    const start = /^[ \t>*_`-]*CONTESTED:[ \t]*(.*)$/.exec(line);
    if (!start) continue;

    const collected = [start[1]];
    for (const next of lines.slice(index + 1)) {
      // A new ALLCAPS field ends the value; anything else continues it.
      if (/^[ \t>*_`-]*[A-Z][A-Z ]*:/.test(next)) break;
      if (/^\s*```/.test(next)) break;
      collected.push(next.trim());
    }

    const raw = collected.join(' ').replace(/`/g, '').trim();
    return { present: true, raw, none: assertsNone(raw) };
  }

  return { present: false, raw: null, none: false };
}

/**
 * Does this declaration assert that NOTHING is contested?
 *
 * Only the leading token is consulted. "none. Verified achievements.ts and
 * onePercentClub.ts are absent from #804's diff before starting." is a none
 * claim with its working shown, and it is still a none claim. A declaration
 * that opens by naming a file is not, however much hedging follows.
 */
export function assertsNone(raw) {
  const lead = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[*_\s]+/, '');
  return NONE_TOKENS.some(
    (token) => lead === token || lead.startsWith(`${token}.`) || lead.startsWith(`${token},`)
      || lead.startsWith(`${token} `) || lead.startsWith(`${token}--`) || lead.startsWith(`${token} --`),
  );
}

/** Which other pull requests share a file with this one, and which files. */
export function overlapsFor(number, files, byNumber) {
  const mine = new Set(files);
  const found = new Map();

  for (const [other, otherFiles] of byNumber) {
    if (String(other) === String(number)) continue;
    const shared = otherFiles.filter((file) => mine.has(file)).sort();
    if (shared.length > 0) found.set(String(other), shared);
  }

  return found;
}

/**
 * Grade one pull request's declaration against the measurement.
 *
 * A declaration that NAMES anything produces a note and never a failure. Over-
 * declaring is safe and under-declaring is the failure this exists for, which
 * is the same asymmetry check-migration-declaration.mjs settles the same way:
 * failing an over-declaration pushes lanes toward declaring less, and that is
 * the wrong direction to be wrong in.
 */
export function evaluatePullRequest({ number, declaration, overlaps }) {
  const failures = [];
  const notes = [];
  const shared = [...overlaps.entries()];

  if (shared.length === 0) {
    if (declaration.present && !declaration.none) {
      notes.push(
        `#${number} names contested surface while sharing no file with any open pull request. `
        + `Allowed -- the branch it named may have merged -- but the line is stale.`,
      );
    }
    return { ok: true, failures, notes };
  }

  const summary = shared
    .map(([other, files]) => `#${other} (${files.length}: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''})`)
    .join('; ');

  if (!declaration.present) {
    notes.push(`#${number} has no CONTESTED line and shares files with ${shared.length} open pull request(s): ${summary}`);
  } else if (declaration.none) {
    failures.push(
      `#${number} declares CONTESTED none, but shares files with ${shared.length} open pull request(s): ${summary}`,
    );
  } else {
    notes.push(`#${number} declares contested surface and shares files with ${shared.length}: ${summary}`);
  }

  return { ok: failures.length === 0, failures, notes };
}

export function evaluateAll(pullRequests) {
  const byNumber = new Map(pullRequests.map((pr) => [String(pr.number), pr.files]));
  const failures = [];
  const notes = [];

  for (const pr of pullRequests) {
    const result = evaluatePullRequest({
      number: pr.number,
      declaration: parseContested(pr.body),
      overlaps: overlapsFor(pr.number, pr.files, byNumber),
    });
    failures.push(...result.failures);
    notes.push(...result.notes);
  }

  return { ok: failures.length === 0, failures, notes };
}

/* ---------------------------------------------------------------- the CLI */

const API = 'https://api.github.com';

async function api(pathname, token) {
  const response = await fetch(`${API}${pathname}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ppbf-check-contested-overlap',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${pathname} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  if (!repository) {
    console.error('GITHUB_REPOSITORY is unset (expected "owner/repo").');
    process.exit(2);
  }

  const open = await api(`/repos/${repository}/pulls?state=open&per_page=100`, token);
  const pullRequests = [];

  for (const pr of open) {
    // Paginated deliberately: a 42-file pull request exists on this board, and
    // the default page is 30, so a single unpaged call would under-report the
    // large branches -- which are exactly the ones that overlap.
    const files = [];
    for (let page = 1; ; page += 1) {
      const batch = await api(`/repos/${repository}/pulls/${pr.number}/files?per_page=100&page=${page}`, token);
      files.push(...batch.map((file) => file.filename));
      if (batch.length < 100) break;
    }
    pullRequests.push({ number: pr.number, body: pr.body, files });
  }

  const result = evaluateAll(pullRequests);

  console.log(`Open pull requests measured: ${pullRequests.length}`);
  console.log('');
  for (const note of result.notes) console.log(`note: ${note}`);
  if (result.notes.length > 0) console.log('');
  for (const failure of result.failures) console.error(`FINDING: ${failure}`);

  if (!result.ok) {
    console.error('');
    console.error('A CONTESTED declaration says nothing is shared where measurement says');
    console.error('otherwise. The release lane sequences a merge window from that line.');
    console.error('These are file-set overlaps only; two branches sharing no file can still');
    console.error('collide semantically, and nothing here sees that.');
    process.exit(1);
  }

  console.log('Every CONTESTED declaration is consistent with the measured overlap.');
  console.log('File sets only -- a semantic collision between branches sharing no file');
  console.log('is invisible to this check.');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(2);
  });
}
