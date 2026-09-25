import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The mutation harness proves other tests bite. This proves the harness does.
 *
 * WHY IT NEEDS ITS OWN SUITE. The machinery it replaces produced two defects in
 * one evening on 2026-09-24: a restore step that rewrote every line ending in
 * the file it was "restoring", and a crash between applying a mutant and
 * restoring it that left the mutation in the working tree. Both were found by
 * accident. A tool whose entire job is catching silent failure cannot itself
 * fail silently.
 *
 * The suite is in two halves. The pure functions are graded directly. The
 * safety property -- that the caller's working tree is never mutated -- is
 * proven end to end against a real throwaway git repository, because that claim
 * is about process and filesystem behaviour and a unit test of it would prove
 * nothing.
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const scriptPath = path.join(repositoryRoot, 'scripts/mutate.mjs');
const moduleUrl = pathToFileURL(scriptPath).href;

/** Real ESM consumed by a CLI, and the default jest runner has no ESM loader. */
function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(await (${expression}) ?? null));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

/** Throws inside the child, so the message is what a user would actually read. */
function evaluateError(expression: string): string {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    try { await (${expression}); process.stdout.write(JSON.stringify(null)); }
    catch (e) { process.stdout.write(JSON.stringify(e instanceof Error ? e.message : String(e))); }
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** Round-trips through base64 so the expression carries bytes, not a re-encoded string. */
const applyBytes = (source: string, find: string, replace: string) =>
  evaluate(`m.applyMutantBytes(Buffer.from(${JSON.stringify(b64(source))}, 'base64'), ${JSON.stringify(find)}, ${JSON.stringify(replace)}).toString('base64')`);

describe('the anchor must name exactly one place', () => {
  it('replaces a unique anchor', () => {
    const out = Buffer.from(applyBytes('a = 1;\nb = 2;\n', 'a = 1', 'a = 99'), 'base64').toString('utf8');
    expect(out).toBe('a = 99;\nb = 2;\n');
  });

  it('refuses an anchor that matches twice, rather than taking the first', () => {
    /* The defect this exists for. The hand-rolled scripts used
       replace(old, new, 1), which silently mutates the first of however many
       matches -- so the proof describes a line nobody chose. */
    const message = evaluateError(`m.applyMutantBytes(Buffer.from('x = 1;\\nx = 1;\\n'), 'x = 1', 'x = 2')`);
    expect(message).toMatch(/matches 2 times/);
    expect(message).toMatch(/exactly once/);
  });

  it('refuses an anchor that is not there, so a moved file cannot pass quietly', () => {
    const message = evaluateError(`m.applyMutantBytes(Buffer.from('a = 1;\\n'), 'nope', 'x')`);
    expect(message).toMatch(/Anchor not found/);
  });

  it('allows an empty replacement, because deleting a guard is a mutation', () => {
    const out = Buffer.from(applyBytes('keep\nDELETE ME\nkeep\n', 'DELETE ME\n', ''), 'base64').toString('utf8');
    expect(out).toBe('keep\nkeep\n');
  });
});

describe('bytes are not re-encoded', () => {
  it('leaves CRLF line endings exactly as they were', () => {
    /* THE 2026-09-24 DEFECT, pinned. A text-mode restore rewrote 3542 CRLF
       pairs in a file it claimed to restore byte-for-byte. Mixed endings here
       on purpose: a re-encode normalises them, and this notices. */
    const source = 'alpha\r\nbeta\r\ntarget\r\ngamma\n';
    const out = Buffer.from(applyBytes(source, 'target', 'TARGET'), 'base64');
    expect(out.toString('utf8')).toBe('alpha\r\nbeta\r\nTARGET\r\ngamma\n');
    expect(out.filter((byte) => byte === 0x0d).length).toBe(3);
  });

  it('leaves bytes either side of the anchor untouched, including a BOM', () => {
    const source = '﻿const a = 1;\n';
    const out = Buffer.from(applyBytes(source, 'const a = 1', 'const a = 2'), 'base64');
    expect(out[0]).toBe(0xef);
    expect(out.toString('utf8')).toBe('﻿const a = 2;\n');
  });
});

describe('a mutation target cannot leave the scratch worktree', () => {
  /* The tool's headline claim is that the branch you are about to push is never
     the thing being mutated, and path.join(tree, file) does not make that true:
     "../../" walks straight out. The quieter version is node_modules, which is
     a junction back to the caller's real dependency tree, so a write there
     leaves the sandbox while looking contained. */
  const norm = (file: string) => evaluate(`m.normalizeEditPath(${JSON.stringify(file)})`);
  const normErr = (file: string) => evaluateError(`m.normalizeEditPath(${JSON.stringify(file)})`);

  it('accepts an ordinary repository-relative path, in posix form', () => {
    expect(norm('apps/web/components/X.tsx')).toBe('apps/web/components/X.tsx');
    expect(norm('apps\\web\\components\\X.tsx')).toBe('apps/web/components/X.tsx');
    expect(norm('./apps/web/./X.tsx')).toBe('apps/web/X.tsx');
  });

  it('refuses traversal that resolves outside the tree', () => {
    expect(normErr('../../outside.txt')).toMatch(/escapes the scratch worktree/);
    expect(normErr('apps/../../outside.txt')).toMatch(/escapes the scratch worktree/);
  });

  it('allows traversal that stays inside, because that is not an escape', () => {
    expect(norm('apps/web/../web/X.tsx')).toBe('apps/web/X.tsx');
  });

  it('refuses absolute paths, posix and windows', () => {
    expect(normErr('/etc/passwd')).toMatch(/must be relative/);
    expect(normErr('C:/Dev/ppbf-platform/x.ts')).toMatch(/must be relative/);
  });

  it('refuses node_modules, which is linked back to the invoking tree', () => {
    expect(normErr('node_modules/jest/index.js')).toMatch(/linked to the invoking tree/);
    expect(normErr('apps/web/node_modules/x/index.js')).toMatch(/linked to the invoking tree/);
  });

  it('rejects a bad path during spec parsing, before anything is created', () => {
    const message = evaluateError(`m.parseSpec(${JSON.stringify(JSON.stringify({
      test: 't',
      mutants: [{ file: '../../escape.txt', find: 'a', replace: 'b' }],
    }))})`);
    expect(message).toMatch(/escapes the scratch worktree/);
  });
});

describe('grading a mutant', () => {
  it('reads a non-zero exit as RED and a zero exit as GREEN', () => {
    expect(evaluate('m.classify(0)')).toBe('GREEN');
    expect(evaluate('m.classify(1)')).toBe('RED');
    // A runner that could not start is still "did not pass". The harness does
    // not parse another tool's output to tell the two apart; it reports the
    // crash separately instead.
    expect(evaluate('m.classify(127)')).toBe('RED');
  });

  it('grades against what the spec declared, not against red-is-good', () => {
    expect(evaluate('m.gradeOutcome("RED", "RED")')).toBe(true);
    expect(evaluate('m.gradeOutcome("RED", "GREEN")')).toBe(false);
    // A mutant declared GREEN is how you record a change that SHOULD be
    // invisible to a test -- proving the test is not over-fitted to it.
    expect(evaluate('m.gradeOutcome("GREEN", "GREEN")')).toBe(true);
  });
});

describe('the report says what a survivor means', () => {
  const summarize = (results: unknown) => evaluate(`m.summarize(${JSON.stringify(results)})`) as unknown as string;

  it('names the mutants that did not behave as declared', () => {
    const out = summarize([
      { label: 'guard removed', expect: 'RED', actual: 'RED', ok: true, crashed: false },
      { label: 'default restored', expect: 'RED', actual: 'GREEN', ok: false, crashed: false },
    ]);
    expect(out).toMatch(/1 of 2 mutants did NOT behave as declared: default restored/);
  });

  it('says a survivor is a finding about the test, not a formality', () => {
    /* Earned on 2026-09-24: a mutant stayed green because the test exercised a
       self-cleaning success path and never reached the reset it was named for.
       Read as a formality, that is a shrug; read as a finding, it is a hole. */
    const out = summarize([{ label: 'reset removed', expect: 'RED', actual: 'GREEN', ok: false, crashed: false }]);
    expect(out).toMatch(/finding about the test, not a formality/);
    expect(out).toMatch(/another path masks the thing you broke/);
  });

  it('flags a RED that came from a crashed runner rather than an assertion', () => {
    const out = summarize([{ label: 'typo', expect: 'RED', actual: 'RED', ok: true, crashed: true }]);
    expect(out).toMatch(/runner crashed -- RED did not come from an assertion/);
  });

  it('says so plainly when every mutant behaved', () => {
    const out = summarize([{ label: 'a', expect: 'RED', actual: 'RED', ok: true, crashed: false }]);
    expect(out).toMatch(/1 of 1 mutants behaved as declared/);
    expect(out).not.toMatch(/did NOT behave/);
  });
});

describe('the spec is validated before anything is touched', () => {
  const err = (spec: unknown) => evaluateError(`m.parseSpec(${JSON.stringify(JSON.stringify(spec))})`);

  it('requires a test command', () => {
    expect(err({ mutants: [{ file: 'a', find: 'x', replace: 'y' }] })).toMatch(/needs a "test" command/);
  });

  it('requires at least one mutant', () => {
    expect(err({ test: 'npm test', mutants: [] })).toMatch(/non-empty "mutants"/);
  });

  it('refuses a mutant that changes nothing', () => {
    const message = err({ test: 't', mutants: [{ file: 'a', find: 'same', replace: 'same' }] });
    expect(message).toMatch(/does not change anything/);
  });

  it('refuses an expectation that is not RED or GREEN', () => {
    expect(err({ test: 't', mutants: [{ file: 'a', find: 'x', replace: 'y', expect: 'PASS' }] }))
      .toMatch(/it must be RED or GREEN/);
  });

  it('accepts a mutant made of several edits, because the informative ones often are', () => {
    /* Earned on 2026-09-24: restoring a defaulted useState alone proved
       nothing, because a sibling reset masked it. The mutant worth running was
       "restore the default AND remove the reset", which one edit cannot say. */
    const spec = {
      test: 't',
      mutants: [{
        label: 'default restored and its mask removed',
        edits: [
          { file: 'a.tsx', find: 'useState(null)', replace: "useState('Dull')" },
          { file: 'a.tsx', find: 'setType(null);\n', replace: '' },
        ],
      }],
    };
    const parsed = evaluate(`m.parseSpec(${JSON.stringify(JSON.stringify(spec))})`);
    expect(parsed.mutants[0].edits).toHaveLength(2);
    expect(parsed.mutants[0].edits[1].replace).toBe('');
  });

  it('validates every edit in a multi-edit mutant, not just the first', () => {
    const message = err({
      test: 't',
      mutants: [{ label: 'two', edits: [{ file: 'a', find: 'x', replace: 'y' }, { file: 'a', find: 'same', replace: 'same' }] }],
    });
    expect(message).toMatch(/edits\[1\]/);
    expect(message).toMatch(/does not change anything/);
  });

  it('defaults an unstated expectation to RED, which is what a proof usually means', () => {
    const parsed = evaluate(`m.parseSpec(${JSON.stringify(JSON.stringify({ test: 't', mutants: [{ file: 'a', find: 'x', replace: 'y' }] }))})`);
    expect(parsed.mutants[0].expect).toBe('RED');
    expect(parsed.mutants[0].test).toBe('t');
  });
});

/**
 * THE SAFETY PROPERTY, end to end.
 *
 * Everything above grades a pure function. This grades the claim the tool
 * exists for -- that the tree you invoke it from is never mutated -- against a
 * real git repository, a real child process and a real mutant. A unit test of
 * this would be a unit test of my own belief about it.
 */
describe('the invoking working tree is never mutated', () => {
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let repo = '';
  let specDir = '';

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-harness-test-'));
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-harness-spec-'));
    git(['init', '--quiet', '-b', 'main'], repo);
    git(['config', 'user.email', 'harness@test.local'], repo);
    git(['config', 'user.name', 'Harness Test'], repo);
    // CRLF on purpose: the restore must not normalise it.
    fs.writeFileSync(path.join(repo, 'subject.txt'), 'alpha\r\nGUARD\r\nomega\r\n');
    git(['add', '.'], repo);
    git(['commit', '--quiet', '-m', 'subject'], repo);
  });

  afterAll(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* temp dir */ }
    try { fs.rmSync(specDir, { recursive: true, force: true }); } catch { /* temp dir */ }
  });

  const runHarness = (spec: unknown) => {
    // OUTSIDE the repository under test. A spec written inside it is untracked
    // dirt, which the clean-tree guard would (correctly) refuse.
    const specPath = path.join(specDir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const result = spawnSync(process.execPath, [scriptPath, '--spec', specPath], {
      cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
  };

  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'subject.txt'))).digest('hex');

  it('kills a mutant, reports it, and leaves the checked-out file byte-identical', () => {
    const before = digest();
    // The "test" greps the file in whatever tree it is run from: it passes on
    // the original and fails once GUARD is gone. So a RED here proves the
    // mutant reached a real file, and the hash proves it was not this one.
    const result = runHarness({
      test: process.platform === 'win32' ? 'findstr GUARD subject.txt' : 'grep -q GUARD subject.txt',
      mutants: [{ label: 'guard removed', file: 'subject.txt', find: 'GUARD', replace: 'GONE', expect: 'RED' }],
    });

    expect(result.out).toMatch(/1 of 1 mutants behaved as declared/);
    expect(result.status).toBe(0);
    expect(digest()).toBe(before);
    expect(fs.readFileSync(path.join(repo, 'subject.txt'), 'utf8')).toBe('alpha\r\nGUARD\r\nomega\r\n');
  });

  it('reports a survivor as a miss and still leaves the tree untouched', () => {
    const before = digest();
    const result = runHarness({
      test: process.platform === 'win32' ? 'findstr alpha subject.txt' : 'grep -q alpha subject.txt',
      mutants: [{ label: 'unrelated line changed', file: 'subject.txt', find: 'GUARD', replace: 'GONE', expect: 'RED' }],
    });

    expect(result.out).toMatch(/did NOT behave as declared/);
    expect(result.out).toMatch(/finding about the test/);
    expect(result.status).toBe(1);
    expect(digest()).toBe(before);
  });

  it('applies every edit of a multi-edit mutant, and restores all of them', () => {
    const before = digest();
    // Neither edit alone removes both words; the test greps for both, so only
    // a mutant that landed BOTH turns it red.
    const result = runHarness({
      test: process.platform === 'win32'
        ? 'findstr GUARD subject.txt && findstr omega subject.txt'
        : 'grep -q GUARD subject.txt && grep -q omega subject.txt',
      mutants: [{
        label: 'both landmarks removed',
        expect: 'RED',
        edits: [
          { file: 'subject.txt', find: 'GUARD', replace: 'GONE' },
          { file: 'subject.txt', find: 'omega', replace: 'zeta' },
        ],
      }],
    });

    expect(result.out).toMatch(/1 of 1 mutants behaved as declared/);
    expect(result.status).toBe(0);
    expect(digest()).toBe(before);
  });

  it('restores the first file even when a later edit has a bad anchor', () => {
    /* The partial-application case. An anchor that has gone stale must not
       leave the earlier edits of the same mutant sitting in the tree. */
    const before = digest();
    const result = runHarness({
      test: 'exit 0',
      mutants: [{
        label: 'second anchor is stale',
        edits: [
          { file: 'subject.txt', find: 'GUARD', replace: 'GONE' },
          { file: 'subject.txt', find: 'NOT PRESENT ANYWHERE', replace: 'x' },
        ],
      }],
    });

    expect(result.status).toBe(2);
    expect(result.out).toMatch(/Anchor not found/);
    expect(digest()).toBe(before);
  });

  it('refuses to grade anything when the test command is not green unmutated', () => {
    /* THE POSITIVE CONTROL. Grading was: non-zero means RED, expected RED plus
       actual RED means proof accepted. So a misspelled command, a missing
       binary or a dependency that fails to load all exit non-zero and were
       credited as a killed mutant -- a proof that passes because nothing ran.
       Note the mutant below declares RED, and would have been "satisfied" by
       the broken command. */
    const before = digest();
    const result = runHarness({
      test: 'this-command-does-not-exist-anywhere --please',
      mutants: [{ label: 'would have been credited', file: 'subject.txt', find: 'GUARD', replace: 'GONE', expect: 'RED' }],
    });

    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/Positive control failed/);
    expect(result.out).toMatch(/does not pass on the UNMUTATED candidate/);
    // Nothing graded: no mutant may be credited off a broken runner.
    expect(result.out).not.toMatch(/behaved as declared/);
    expect(result.out).not.toMatch(/would have been credited\s+expected/);
    expect(digest()).toBe(before);
  });

  it('refuses a target that is not tracked at the candidate commit', () => {
    const before = digest();
    const untracked = path.join(specDir, 'not-in-the-repo.txt');
    fs.writeFileSync(untracked, 'x');
    const result = runHarness({
      test: 'exit 0',
      mutants: [{ label: 'untracked target', file: 'not-in-the-repo.txt', find: 'x', replace: 'y' }],
    });
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/is not tracked at/);
    expect(digest()).toBe(before);
    fs.rmSync(untracked, { force: true });
  });

  it('refuses when ANY file is uncommitted, not only the ones it would mutate', () => {
    /* THE HOLE THIS CLOSES, and it is the one the tool exists to prevent:
       "the proof ran against a different candidate than the builder thought".
       A mutation proof is about two files -- the source being broken and the
       TEST meant to notice -- and only the first appears in the spec. Checking
       just the mutated file left an uncommitted test running as its previous
       version in the scratch tree, and a NEW test file not existing there at
       all. `jest -t` matching nothing does not fail loudly, so that graded as
       a surviving mutant: a confident wrong finding about a test that never
       ran. */
    const unrelated = path.join(repo, 'the-test-that-should-notice.txt');
    fs.writeFileSync(unrelated, 'a test file the spec never mentions\n');
    try {
      const result = runHarness({
        test: 'exit 0',
        mutants: [{ label: 'anything', file: 'subject.txt', find: 'GUARD', replace: 'GONE' }],
      });
      expect(result.status).toBe(2);
      expect(result.out).toMatch(/Working tree is not clean/);
      expect(result.out).toMatch(/the-test-that-should-notice/);
      expect(result.out).toMatch(/a survivor would be reported for a test that\s+never ran/);
    } finally {
      fs.rmSync(unrelated, { force: true });
    }
  });

  it('can be told the difference does not matter, but only explicitly', () => {
    const unrelated = path.join(repo, 'scratch-note.txt');
    fs.writeFileSync(unrelated, 'unrelated scratch\n');
    try {
      const specPath = path.join(specDir, 'spec.json');
      fs.writeFileSync(specPath, JSON.stringify({
        test: process.platform === 'win32' ? 'findstr GUARD subject.txt' : 'grep -q GUARD subject.txt',
        mutants: [{ label: 'guard removed', file: 'subject.txt', find: 'GUARD', replace: 'GONE', expect: 'RED' }],
      }));
      const result = spawnSync(process.execPath, [scriptPath, '--spec', specPath, '--allow-dirty'], {
        cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      });
      expect(result.status).toBe(0);
      expect(`${result.stdout}`).toMatch(/1 of 1 mutants behaved as declared/);
    } finally {
      fs.rmSync(unrelated, { force: true });
    }
  });

  it('refuses to run at all when the file it would mutate has uncommitted edits', () => {
    /* Mutants run against a commit. An uncommitted edit is not in that commit,
       so a green table would describe code the author is not holding. */
    const subject = path.join(repo, 'subject.txt');
    const committed = fs.readFileSync(subject);
    fs.writeFileSync(subject, 'alpha\r\nGUARD\r\nomega\r\nuncommitted\r\n');
    try {
      const result = runHarness({
        test: 'exit 0',
        mutants: [{ label: 'anything', file: 'subject.txt', find: 'GUARD', replace: 'GONE' }],
      });
      expect(result.status).toBe(2);
      expect(result.out).toMatch(/Working tree is not clean/);
    } finally {
      fs.writeFileSync(subject, committed);
    }
  });
});
