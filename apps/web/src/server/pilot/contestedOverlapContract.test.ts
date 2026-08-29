import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `CONTESTED:` is an absence claim about a set that moves hourly.
 *
 * WHY THIS EXISTS. The release lane sequences a merge window from that line, so
 * a wrong one lands two branches in the same file with nobody expecting it.
 * Measured over the 20 pull requests open on 2026-08-29: seven declared
 * `CONTESTED: none` and FIVE of those shared files with eleven or twelve other
 * open branches. None was careless -- each was true when written and went stale
 * when the board moved, which is why measuring it at the moment somebody acts
 * on it is the only fix that holds.
 *
 * The suite covers the checker's judgement, not the network. Fetching open pull
 * requests is a thin CLI shell around these exported functions precisely so the
 * decision is testable without a token.
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const scriptPath = path.join(repositoryRoot, 'scripts/check-contested-overlap.mjs');
const moduleUrl = pathToFileURL(scriptPath).href;

// Real ESM consumed by a workflow step, and the default jest runner has no ESM
// loader. Same one-child-process pattern the other declaration checkers use.
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

/** A brief header with the given CONTESTED value, as bodies actually carry it. */
const body = (contested: string) =>
  ['```', 'LANE:        a-lane', 'MIGRATIONS:  NONE', `CONTESTED:   ${contested}`, 'SCOPE:       a scope', '```'].join('\n');

/** Grade a whole board in one call. */
const grade = (prs: { number: number; body: string; files: string[] }[]) =>
  evaluate(`m.evaluateAll(${JSON.stringify(prs)})`);

describe('reading the declaration out of a body', () => {
  it('takes the value and its continuation lines, stopping at the next field', () => {
    const parsed = evaluate(`m.parseContested(${JSON.stringify(
      '```\nLANE: x\nCONTESTED:   none. Verified achievements.ts\n             is absent from #804\n SCOPE: y\n```',
    )})`);

    expect(parsed.present).toBe(true);
    expect(parsed.raw).toBe('none. Verified achievements.ts is absent from #804');
    expect(parsed.none).toBe(true);
  });

  it('reports absence rather than guessing when there is no CONTESTED line', () => {
    expect(evaluate(`m.parseContested('a body with no brief header')`))
      .toEqual({ present: false, raw: null, none: false });
  });

  it.each([
    ['none', true],
    ['NONE', true],
    ['none. Both files are append-or-annotate by convention', true],
    ['none -- nothing else is open on this surface', true],
    ['nothing', true],
    ['apps/web/package.json', false],
    ['.github/workflows/ci.yml, scripts/ci-classify-paths.mjs', false],
    ['#797 designs this same surface (see below)', false],
    ['none. Verified achievements.ts is absent from #804 before starting', true],
  ])('reads %p as a none-claim: %p', (raw, expected) => {
    expect(evaluate(`m.assertsNone(${JSON.stringify(raw)})`)).toBe(expected);
  });

  it('grades on the leading token only, and that is a deliberate limit', () => {
    // A none-claim whose justification NAMES files is still a none-claim. The
    // alternative -- treat any declaration containing a path as naming
    // contested surface -- was tried and rejected, because #866's real wording
    // is exactly that shape: "none. Verified achievements.ts and
    // onePercentClub.ts are absent from #804's diff before starting." That is
    // a genuine absence claim, it was wrong (the branch shares
    // apps/web/package.json with eleven others), and a path rule would lose it.
    //
    // Telling "named as absent" from "named as contested" is a reading of
    // prose, which docs/current/EVIDENCE_APPLICABILITY.md says not to automate.
    // So the cost is accepted in the direction that is cheap: a declaration
    // opening "none of the coach files, but package.json is shared" is graded
    // a none-claim and would be reported. This is a manual dispatch, so that
    // costs a reviewer a moment; the other error costs a merge collision.
    expect(evaluate(`m.assertsNone('none of the coach files, but package.json is shared')`))
      .toBe(true);
  });
});

describe('grading a declaration against the measurement', () => {
  const sharedBoard = [
    { number: 1, body: body('none'), files: ['apps/web/package.json', 'a.ts'] },
    { number: 2, body: body('apps/web/package.json'), files: ['apps/web/package.json', 'b.ts'] },
  ];

  it('fails a none-claim that measurement contradicts, naming the files', () => {
    const result = grade(sharedBoard);

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('#1 declares CONTESTED none');
    expect(result.failures[0]).toContain('apps/web/package.json');
  });

  it('does not fail the branch that declared the same overlap honestly', () => {
    // The positive control. #2 shares the identical file and says so, so a
    // checker that failed both would be measuring overlap, not declarations.
    //
    // Asserted on the SUBJECT of each failure, not on whether the string "#2"
    // appears anywhere in it: #1's failure names #2 as the branch it overlaps,
    // so a bare substring check passes for the wrong reason and would keep
    // passing if #2 started failing too.
    const subjects = grade(sharedBoard).failures
      .map((line: string) => /^#(\d+) declares/.exec(line)?.[1])
      .filter(Boolean);

    expect(subjects).toEqual(['1']);
    expect(grade(sharedBoard).notes.join('\n')).toContain('#2 declares contested surface');
  });

  it('passes a none-claim that measurement confirms', () => {
    const result = grade([
      { number: 1, body: body('none'), files: ['only-mine.ts'] },
      { number: 2, body: body('none'), files: ['only-theirs.ts'] },
    ]);

    expect(result).toMatchObject({ ok: true, failures: [] });
  });

  it('notes rather than fails a missing CONTESTED line', () => {
    // Dependabot opens pull requests with no brief header. Failing those would
    // red the board for a bot that cannot write one.
    const result = grade([
      { number: 1, body: 'no header at all', files: ['shared.ts'] },
      { number: 2, body: body('shared.ts'), files: ['shared.ts'] },
    ]);

    expect(result.ok).toBe(true);
    expect(result.notes.join('\n')).toContain('#1 has no CONTESTED line');
  });

  it('notes a declaration naming a surface nothing open touches any more', () => {
    // The staleness that runs the other way: the branch it named has merged.
    const result = grade([{ number: 1, body: body('scripts/gone.mjs'), files: ['mine.ts'] }]);

    expect(result.ok).toBe(true);
    expect(result.notes.join('\n')).toContain('stale');
  });

  it('never counts a pull request as contesting itself', () => {
    expect(grade([{ number: 1, body: body('none'), files: ['a.ts'] }])).toMatchObject({ ok: true });
  });
});

describe('the real board on 2026-08-29, as an end-to-end case', () => {
  // Reduced from the measured overlap of the 20 open pull requests: the
  // coach-development family all touch apps/web/package.json and
  // apply-migrations.yml, #814/#824/#843/#850/#866 declared none, and
  // #782/#784/#792 declared the same files honestly.
  const board = [
    { number: 814, body: body('none'), files: ['apps/web/package.json', '.github/workflows/apply-migrations.yml'] },
    { number: 824, body: body('none'), files: ['apps/web/package.json', '.github/workflows/apply-migrations.yml'] },
    { number: 862, body: body('none'), files: ['apps/web/src/server/pilot/alone.ts'] },
    { number: 782, body: body('apps/web/package.json and .github/workflows/apply-migrations.yml'), files: ['apps/web/package.json', '.github/workflows/apply-migrations.yml'] },
    { number: 752, body: 'dependabot body, no header', files: ['apps/web/package.json'] },
  ];

  it('finds exactly the branches whose none-claim is contradicted', () => {
    const result = grade(board);
    const flagged = result.failures.map((line: string) => line.match(/#(\d+)/)?.[1]).sort();

    expect(flagged).toEqual(['814', '824']);
  });

  it('leaves the correct none-claim alone', () => {
    // #862 shares nothing and says none. A checker that flagged it would be
    // unusable on a board where most branches legitimately share a file.
    expect(grade(board).failures.join('\n')).not.toContain('#862');
  });
});

describe('the check is reachable', () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/run-checks.yml'),
    'utf8',
  );

  it('exists where the workflow points', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('is offered as a dispatch option', () => {
    // checkDispatchCoverage.test.ts records the cost of the alternative: a
    // safeguarding sweep that could not be invoked by name from anywhere.
    expect(workflow).toMatch(/^ {10}- contested-overlap$/m);
  });

  it('is actually invoked by the job, not merely listed', () => {
    expect(workflow).toContain('node scripts/check-contested-overlap.mjs');
  });

  it('runs without a database target or an environment gate', () => {
    const job = workflow.slice(workflow.indexOf('contested-overlap:'));
    const nextJob = job.slice(1).search(/\n {2}[a-z-]+:\n/);
    const block = nextJob === -1 ? job : job.slice(0, nextJob);

    // It asks GitHub, not Postgres. Carrying `environment:` would park it on a
    // production protection rule for a question about this repository.
    expect(block).not.toContain('environment:');
    expect(block).toContain('pull-requests: read');
  });
});
