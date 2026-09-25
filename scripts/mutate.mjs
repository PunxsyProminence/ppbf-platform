#!/usr/bin/env node
//
// Runs mutation proofs: deliberately break a property, confirm the test that
// names it turns red, restore, and report.
//
// WHY THIS EXISTS. A test that cannot fail is worse than no test, because it
// reports green and nobody looks again. The only cheap way to know a guard
// bites is to break the thing it guards and watch it die. That is already the
// repo's habit -- PR bodies carry mutation tables -- but the machinery was
// hand-rolled per slice, and on 2026-09-24 the hand-rolled machinery produced
// two defects of its own in one evening:
//
//   - A Python restore step written in text mode rewrote every line ending in
//     the file (3542 CRLF pairs) while "restoring" it.
//   - The same script raised on an unrelated encoding error BETWEEN applying a
//     mutant and restoring it, and left the mutation sitting in the working
//     tree. It was found only because a byte-hash comparison happened to be run
//     afterwards. Nothing in the script would have said so.
//
// Both are the same failure: a temporary mutation applied to the authoritative
// working state, with a recovery step that does not survive the process dying.
//
// WHAT THIS DOES DIFFERENTLY, and it is the whole point. It never mutates the
// working tree it was invoked from. Mutants are applied inside a throwaway git
// worktree checked out at the candidate commit, and that directory is deleted
// afterwards. `try/finally` is NOT the safety mechanism -- a killed process
// never runs `finally` -- it is only the tidy-up. The safety property is that
// the worst case of a hard kill is a leaked temp directory, never a mutated
// source file on the branch somebody is about to push.
//
// AN ANCHOR MUST MATCH EXACTLY ONCE. The hand-rolled scripts used
// `replace(old, new, 1)`, which silently takes the first of however many
// matches there are. That is the same class of defect this tool exists to
// catch: acting on a target nobody proved. An ambiguous anchor is an error
// here, not a coin flip.
//
// WHAT IT DOES NOT DO. It does not invent mutants -- you name the property to
// break, because "which edit would falsify this specific claim" is the
// judgement worth having and the part a machine guesses badly. It does not run
// in CI against product code: mutants deliberately create failing states, and
// CI cannot infer which property a given slice meant to prove. The harness's
// OWN behaviour is tested (see mutationHarnessContract.test.ts); the product
// mutation runs stay local and their results go in the pull request body.
//
// It also proves nothing about a property no test names. A mutant that stays
// green is a finding about the test, not a formality -- on 2026-09-24 exactly
// that turned up a test which passed through a self-cleaning success path and
// never exercised the reset it was named for.
//
// AND IT HAS NO TIMEOUT OF ITS OWN. A hung test command hangs the run. Because
// every mutation happens in disposable state, that is an availability problem
// rather than a source-integrity one: kill it and the worst case is still a
// leaked temp directory. Give the test command its own timeout if it needs one.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** A mutant's outcome, named for what it means rather than for an exit code. */
export const RED = 'RED';
export const GREEN = 'GREEN';

/**
 * Validates a spec and fills its defaults.
 *
 * Every failure here is a precise sentence rather than a stack trace, because
 * the audience is somebody mid-slice who mistyped an anchor at 1am.
 */
export function parseSpec(raw) {
  const spec = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!spec || typeof spec !== 'object') throw new Error('Spec must be an object.');
  if (typeof spec.test !== 'string' || !spec.test.trim()) {
    throw new Error('Spec needs a "test" command string, run inside the scratch worktree.');
  }
  if (!Array.isArray(spec.mutants) || spec.mutants.length === 0) {
    throw new Error('Spec needs a non-empty "mutants" array.');
  }

  const mutants = spec.mutants.map((m, i) => {
    const where = `mutants[${i}]${m && m.label ? ` (${m.label})` : ''}`;
    if (!m || typeof m !== 'object') throw new Error(`${where} must be an object.`);

    /* ONE MUTANT MAY NEED SEVERAL EDITS, and the mutations worth running most
       often do. On 2026-09-24 restoring a defaulted useState alone proved
       nothing, because a sibling reset masked it; the informative mutant was
       "restore the default AND remove the reset", and a one-edit-per-mutant
       harness cannot say that. `file`/`find`/`replace` stays as the shorthand
       for the common single-edit case. */
    const raw = Array.isArray(m.edits) && m.edits.length > 0
      ? m.edits
      : [{ file: m.file, find: m.find, replace: m.replace }];
    if (Array.isArray(m.edits) && m.edits.length === 0) throw new Error(`${where} has an empty "edits" array.`);

    const edits = raw.map((e, j) => {
      const at = raw.length > 1 ? `${where} edits[${j}]` : where;
      if (!e || typeof e !== 'object') throw new Error(`${at} must be an object.`);
      if (typeof e.file !== 'string' || !e.file.trim()) throw new Error(`${at} needs a "file" path, relative to the repository root.`);
      if (typeof e.find !== 'string' || e.find === '') throw new Error(`${at} needs a non-empty "find" anchor.`);
      if (typeof e.replace !== 'string') throw new Error(`${at} needs a "replace" string ("" is allowed -- that is a deletion).`);
      if (e.find === e.replace) throw new Error(`${at} does not change anything: "find" and "replace" are identical.`);
      let file;
      try {
        file = normalizeEditPath(e.file);
      } catch (error) {
        throw new Error(`${at}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { file, find: e.find, replace: e.replace };
    });

    const expect = m.expect ?? RED;
    if (expect !== RED && expect !== GREEN) throw new Error(`${where} has expect "${expect}"; it must be ${RED} or ${GREEN}.`);
    return {
      label: typeof m.label === 'string' && m.label.trim() ? m.label : `${edits[0].file}:${i}`,
      edits,
      expect,
      // A mutant may name its own test when one command does not suit all of
      // them. Defaults to the spec-level command.
      test: typeof m.test === 'string' && m.test.trim() ? m.test : spec.test,
    };
  });

  return { test: spec.test, sha: typeof spec.sha === 'string' ? spec.sha : null, mutants };
}

/**
 * Applies one anchor/replacement to a byte buffer.
 *
 * BYTES, NOT TEXT. Reading this file as a string and writing it back re-encodes
 * it: on Windows, Node and Python both translate "\n" to "\r\n" on a text-mode
 * write, so a faithful "restore" silently rewrites every line in the file. The
 * buffer never goes through a string here, so it cannot.
 */
export function applyMutantBytes(buffer, find, replace) {
  const haystack = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const needle = Buffer.from(find, 'utf8');
  const matches = countOccurrences(haystack, needle);

  if (matches === 0) {
    throw new Error('Anchor not found. The file moved under the spec, or the anchor was mistyped.');
  }
  if (matches > 1) {
    // Deliberately fatal. Taking the first of several matches is how a mutation
    // ends up proving something about a line nobody meant to touch.
    throw new Error(`Anchor matches ${matches} times; it must match exactly once. Extend it until it is unique.`);
  }

  const at = haystack.indexOf(needle);
  return Buffer.concat([
    haystack.subarray(0, at),
    Buffer.from(replace, 'utf8'),
    haystack.subarray(at + needle.length),
  ]);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Normalises a spec's file path and refuses anything that could leave the
 * scratch worktree.
 *
 * WHY THIS IS NOT PARANOIA. The tool's headline claim is that the branch you
 * are about to push is never the thing being mutated, and `path.join(tree, f)`
 * does not make that true on its own: `../../` walks straight out of the
 * disposable tree and into the caller's. There is a quieter version of the same
 * hole -- `node_modules` inside the scratch tree is a junction back to the
 * caller's real one, so a path under it writes through the link. A claim the
 * code does not enforce is a claim, not a property.
 */
export function normalizeEditPath(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('Edit path must be a non-empty string.');
  const raw = file.trim().replace(/\\/g, '/');
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`Edit path must be relative to the repository root, not absolute: ${file}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Edit path escapes the scratch worktree: ${file}`);
  }
  if (normalized.split('/').includes('node_modules')) {
    // Linked back to the caller by design, so a write here leaves the sandbox
    // even though the path looks contained.
    throw new Error(`Edit path is inside node_modules, which is linked to the invoking tree: ${file}`);
  }
  return normalized;
}

/**
 * A non-zero exit is RED. That is the whole rule, and it is deliberately blunt:
 * a crashed runner and a failed assertion both mean "this did not pass", and a
 * harness that tried to tell them apart would be guessing at another tool's
 * output format. `crashed` is reported separately so a reader can see that a
 * RED came from a runner that never started.
 */
export function classify(status) {
  return status === 0 ? GREEN : RED;
}

export const gradeOutcome = (expected, actual) => expected === actual;

/** The report. Ordered as run, so it reads like the session it describes. */
export function summarize(results) {
  const width = Math.max(...results.map((r) => r.label.length), 8);
  const lines = results.map((r) => {
    const verdict = r.ok ? 'ok  ' : 'MISS';
    const crashed = r.crashed ? '  (runner crashed -- RED did not come from an assertion)' : '';
    return `  ${verdict}  ${r.label.padEnd(width)}  expected ${r.expect}  got ${r.actual}${crashed}`;
  });
  const missed = results.filter((r) => !r.ok);
  lines.push('');
  lines.push(missed.length === 0
    ? `  ${results.length} of ${results.length} mutants behaved as declared.`
    : `  ${missed.length} of ${results.length} mutants did NOT behave as declared: ${missed.map((r) => r.label).join(', ')}`);
  if (missed.some((r) => r.expect === RED && r.actual === GREEN)) {
    lines.push('');
    lines.push('  A mutant that stayed GREEN is a finding about the test, not a formality.');
    lines.push('  Either the guard does not bite, or another path masks the thing you broke.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function run(command, cwd) {
  const shell = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const result = spawnSync(shell, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsVerbatimArguments: true });
  return { status: result.status ?? 1, crashed: result.status === null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function main(argv) {
  const specIndex = argv.indexOf('--spec');
  if (specIndex === -1 || !argv[specIndex + 1]) {
    process.stderr.write([
      'usage: node scripts/mutate.mjs --spec <spec.json> [--sha <commit>] [--keep]',
      '',
      'The spec names a test command and the mutants to prove against it:',
      '  {',
      '    "test": "npm --workspace web run test -- --runTestsByPath components/x.test.tsx -t \\"a name\\"",',
      '    "mutants": [',
      '      { "label": "guard removed", "file": "apps/web/components/X.tsx",',
      '        "find": "if (guard) {", "replace": "if (true) {", "expect": "RED" }',
      '    ]',
      '  }',
      '',
      'Mutants run in a throwaway worktree at the candidate commit. This working',
      'tree is never modified.',
    ].join('\n') + '\n');
    return 2;
  }

  const spec = parseSpec(fs.readFileSync(argv[specIndex + 1], 'utf8'));
  const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd());
  const shaArg = argv.includes('--sha') ? argv[argv.indexOf('--sha') + 1] : spec.sha;
  const sha = git(['rev-parse', shaArg || 'HEAD'], repoRoot);
  const keep = argv.includes('--keep');

  // THE CANDIDATE MUST BE COMMITTED -- THE WHOLE OF IT, not just the files the
  // spec mutates.
  //
  // This checked only the mutated files at first, and that was a hole of
  // exactly the kind this tool exists to close: "the proof ran against a
  // different candidate than the builder thought". The files a mutation proof
  // is ABOUT are usually two -- the source being broken and the TEST that is
  // supposed to notice -- and only the first appears in the spec. An
  // uncommitted test file therefore left the scratch worktree running the
  // previous version of the test, or, if the test file was new and untracked,
  // running no such test at all. `jest -t` matching nothing does not fail
  // loudly; it just does not fail, which this would have graded as a mutant
  // that survived. A wrong finding, reported confidently, about a test that
  // was never executed.
  //
  // Untracked files count for the same reason: a new test that exists only in
  // the working tree is not in `sha` either.
  const dirty = git(['status', '--porcelain'], repoRoot);
  if (dirty && !argv.includes('--allow-dirty')) {
    process.stderr.write(
      `Working tree is not clean, and mutants run against ${sha.slice(0, 8)}:\n\n${dirty}\n\n`
      + 'None of the above is in that commit, so the proof would describe code you are not\n'
      + 'holding -- most dangerously a test file, where the scratch worktree would run the\n'
      + 'old version, or no test at all, and a survivor would be reported for a test that\n'
      + 'never ran.\n\n'
      + 'Commit them, or pass --allow-dirty if you have established the difference cannot\n'
      + 'affect this proof.\n',
    );
    return 2;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-mutate-'));
  const tree = path.join(scratch, 'tree');
  let results = [];

  try {
    git(['worktree', 'add', '--detach', tree, sha], repoRoot);
    linkNodeModules(repoRoot, tree);

    process.stdout.write(`mutation proof against ${sha.slice(0, 8)}, in a throwaway worktree\n`
      + `  ${tree}\n  (this working tree is not touched)\n\n`);

    /* EVERY TARGET MUST BE A TRACKED REGULAR FILE AT THE CANDIDATE. Path
       normalisation stops traversal; this stops the rest. A symlink is a write
       through to wherever it points, a submodule gate is not a file, and an
       untracked path is not part of the thing being proven at all. Checked
       against the commit rather than the scratch tree, so the answer cannot
       depend on what the checkout happens to have materialised. */
    const touched = [...new Set(spec.mutants.flatMap((m) => m.edits.map((e) => e.file)))];
    for (const file of touched) {
      const entry = git(['ls-tree', '-z', sha, '--', file], repoRoot).replace(/\0$/, '');
      if (!entry) throw new Error(`${file} is not tracked at ${sha.slice(0, 8)}, so it is not part of the candidate.`);
      const mode = entry.slice(0, 6);
      if (mode === '120000') throw new Error(`${file} is a symlink at ${sha.slice(0, 8)}; a write through it would leave the scratch worktree.`);
      if (mode === '160000') throw new Error(`${file} is a submodule at ${sha.slice(0, 8)}, not a file this can mutate.`);
      if (mode !== '100644' && mode !== '100755') throw new Error(`${file} is not a regular file at ${sha.slice(0, 8)} (mode ${mode}).`);
    }

    /* THE POSITIVE CONTROL, and the hole that made this necessary.
       Grading was: run the command, non-zero means RED, expected RED plus
       actual RED means the proof passed. So a misspelled command, a missing
       binary, a dependency that fails to load or a shell error all EXIT
       NON-ZERO and were credited as a killed mutant. A proof that passes
       because nothing ran is the precise failure this tool exists to stop.
       Each distinct command must therefore go green on the pristine candidate
       before any mutant using it is graded. */
    const commands = [...new Set(spec.mutants.map((m) => m.test))];
    for (const command of commands) {
      process.stdout.write(`  baseline (unmutated) ... `);
      const baseline = run(command, tree);
      if (baseline.status !== 0) {
        process.stdout.write('NOT GREEN\n');
        const detail = (baseline.stderr || baseline.stdout || '').trim().split('\n').slice(-12).join('\n');
        throw new Error(
          'Positive control failed: the test command does not pass on the UNMUTATED candidate.\n\n'
          + `  command: ${command}\n`
          + `  exit:    ${baseline.status}${baseline.crashed ? ' (runner never started)' : ''}\n\n`
          + (detail ? `${detail}\n\n` : '')
          + 'Nothing was graded. A mutant cannot prove a test bites when that test does not\n'
          + 'pass to begin with -- every mutant would report RED for the wrong reason.',
        );
      }
      process.stdout.write('GREEN\n');
    }
    process.stdout.write('\n');

    for (const mutant of spec.mutants) {
      results.push(proveOne(mutant, tree));
    }
  } finally {
    if (keep) {
      process.stdout.write(`\n--keep: scratch worktree left at ${tree}\n`);
    } else {
      // Tidy-up, NOT the safety mechanism. If this never runs, a temp directory
      // leaks and nothing else does.
      try { git(['worktree', 'remove', '--force', tree], repoRoot); } catch { /* the rm below still tries */ }
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* leaked temp dir only */ }
      try { git(['worktree', 'prune'], repoRoot); } catch { /* nothing to prune */ }
    }
  }

  process.stdout.write(summarize(results) + '\n');
  return results.every((r) => r.ok) ? 0 : 1;
}

function proveOne(mutant, tree) {
  // Read every file this mutant touches BEFORE changing any of them, so a bad
  // anchor in the second edit still restores the first.
  const originals = new Map();
  for (const edit of mutant.edits) {
    const target = path.join(tree, edit.file);
    if (!originals.has(target)) originals.set(target, fs.readFileSync(target));
  }

  process.stdout.write(`  ${mutant.label} ... `);
  let actual = null;
  let crashed = false;
  try {
    // Applied in order and cumulatively, so two edits to one file both land.
    const staged = new Map(originals);
    for (const edit of mutant.edits) {
      const target = path.join(tree, edit.file);
      staged.set(target, applyMutantBytes(staged.get(target), edit.find, edit.replace));
    }
    for (const [target, bytes] of staged) fs.writeFileSync(target, bytes);

    const outcome = run(mutant.test, tree);
    actual = classify(outcome.status);
    crashed = outcome.crashed;
  } finally {
    // Inside a disposable tree, so this is hygiene between mutants rather than
    // a recovery boundary: one mutant must not be measured against another's.
    for (const [target, bytes] of originals) fs.writeFileSync(target, bytes);
  }

  for (const [target, bytes] of originals) {
    const after = sha256(fs.readFileSync(target));
    if (after !== sha256(bytes)) {
      // Cannot happen with the byte writes above, which is exactly why it is
      // asserted: the previous harness believed the same thing and was wrong.
      throw new Error(`Restore did not reproduce ${path.relative(tree, target)} byte-for-byte.`);
    }
  }

  const ok = gradeOutcome(mutant.expect, actual);
  process.stdout.write(`${actual}${ok ? '' : `  <- expected ${mutant.expect}`}\n`);
  return { label: mutant.label, expect: mutant.expect, actual, ok, crashed };
}

/**
 * A fresh worktree has no node_modules, and installing one per run costs
 * minutes. Reuse the invoking tree's by reference. Best effort on purpose: if
 * the link cannot be made, the run still works for any test command that does
 * not need it, and fails loudly in the runner's own words if it does.
 */
function linkNodeModules(repoRoot, tree) {
  for (const rel of ['node_modules', path.join('apps', 'web', 'node_modules')]) {
    const source = path.join(repoRoot, rel);
    const destination = path.join(tree, rel);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(source, destination, 'junction');
    } catch { /* see the note above */ }
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
