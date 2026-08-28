import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The evidence-applicability contract has to be REACHABLE and CONSISTENT.
 *
 * WHY THIS EXISTS. A standard nobody encounters is not a standard, and this
 * repository has the receipts: `verify-evidence-tier-corpus.mjs` existed for
 * weeks and ran only when a human remembered to type it, and
 * `pilot-check-videos-missing-consent.mjs` -- a safeguarding sweep for minors --
 * could not be invoked by name from anywhere at all. Both were real files doing
 * real work that nothing dispatched. A document is easier to strand than a
 * script, not harder.
 *
 * So the first half of this suite asserts the contract is named on the paths a
 * lane actually walks: the kernel's read path, guardrails §1, the pull request
 * template, and the workflow step that runs its checker.
 *
 * The second half is evidence-corpus.yml's two-implementation shape. The
 * checker carries its OWN copy of the vocabulary -- deliberately, so it runs
 * with no TypeScript build -- and a copy is a thing that drifts. The document
 * could gain a rung the checker rejects, or the checker gain one the document
 * never taught, and each would look correct read alone. Both are pinned to each
 * other here, and the document's own worked records are graded by the checker
 * that grades a pull request body, so an example that would fail CI cannot sit
 * in the standard teaching people to write it.
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const contractPath = path.join(repositoryRoot, 'docs/current/EVIDENCE_APPLICABILITY.md');
const CONTRACT_REF = 'docs/current/EVIDENCE_APPLICABILITY.md';

const read = (relative: string) =>
  fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const contract = fs.readFileSync(contractPath, 'utf8');

// The checker is ESM consumed by a workflow step; the default jest runner has
// no ESM loader. Same one-child-process pattern as its own suite.
const moduleUrl = pathToFileURL(
  path.join(repositoryRoot, 'apps/web/scripts/check-evidence-applicability.mjs'),
).href;

function fromChecker(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(await (${expression}) ?? null));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

/** The text between one `## `/`### ` heading and the next heading of any depth. */
function section(heading: string): string {
  const start = contract.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = contract.slice(start + heading.length);
  const end = rest.search(/\n#{2,6} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every `SCREAMING_SNAKE` token inside backticks in a chunk of the contract. */
function backtickedTokens(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/`([A-Z][A-Z_]*)`/g)].map((match) => match[1]),
  );
}

describe('the contract is reachable from the paths a lane walks', () => {
  it('exists where every reference points', () => {
    expect(fs.existsSync(contractPath)).toBe(true);
  });

  it('is named in the kernel read path, which is step one of the startup contract', () => {
    const kernel = read('AGENT_KERNEL.md');
    const readPath = kernel.slice(
      kernel.indexOf('## Read path'),
      kernel.indexOf('## Working channel'),
    );

    expect(readPath).toContain(CONTRACT_REF);
  });

  it('carries the one rule inline in the kernel, for a lane that never opens it', () => {
    const rule = 'A green result is evidence only for the property and the execution path';

    expect(read('AGENT_KERNEL.md')).toContain(rule);
    expect(contract).toContain(rule);
  });

  it('is named in guardrails §1, where the evidence rules already live', () => {
    const guardrails = read('docs/AI_CONTRIBUTOR_GUARDRAILS.md');
    const claimsSection = guardrails.slice(
      guardrails.indexOf('## 1. Claims require evidence'),
      guardrails.indexOf('## 2. '),
    );

    expect(claimsSection).toContain(CONTRACT_REF);
  });

  it('is named in the pull request template, which is where an author writes the claim', () => {
    expect(read('.github/pull_request_template.md')).toContain(CONTRACT_REF);
  });

  it('has its checker actually dispatched by a workflow, not merely present on disk', () => {
    // The lesson from checkDispatchCoverage.test.ts: a check nobody invokes is
    // a check that does not exist.
    expect(read('.github/workflows/migration-declaration.yml'))
      .toContain('node apps/web/scripts/check-evidence-applicability.mjs');
  });
});

describe('the contract and its checker cannot drift apart', () => {
  it('publishes exactly the evidence ladder the checker enforces', () => {
    const published = backtickedTokens(section('### The ladder'));

    expect([...published].sort()).toEqual([...fromChecker('m.EVIDENCE_LEVELS')].sort());
  });

  it('publishes the ladder in the checker order, weakest first', () => {
    const ladder: string[] = fromChecker('m.EVIDENCE_LEVELS');
    const text = section('### The ladder');
    const positions = ladder.map((level) => text.indexOf(`\`${level}\``));

    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('publishes exactly the verdict vocabulary the checker enforces', () => {
    const published = backtickedTokens(section('## The record'));
    const verdicts: string[] = fromChecker('m.VERDICTS');

    // Both directions: every verdict is published, and the section quotes no
    // screaming-snake token that is not one -- so a fifth verdict cannot be
    // introduced in prose without the checker learning it.
    expect([...published].sort()).toEqual([...verdicts].sort());
  });

  it('names every field the checker requires, in the checker order', () => {
    const bulleted = [...section('## The record').matchAll(/^- \*\*([A-Z][A-Z ]*)\*\*/gm)]
      .map((match) => match[1]);

    expect(bulleted).toEqual(fromChecker('m.REQUIRED_FIELDS'));
  });

  it('names the environment-specific levels as the ones needing an environment', () => {
    const environmentLevels: string[] = fromChecker('m.ENVIRONMENT_LEVELS');
    const sentence = section('### The ladder');

    for (const level of environmentLevels) {
      expect(sentence).toMatch(
        new RegExp(`\`${level}\`[\\s\\S]*?must\\s+name\\s+the\\s+environment`),
      );
    }
  });
});

describe('the contract grades its own worked records', () => {
  it('carries worked records rather than a blank template', () => {
    // A blank template teaches the shape and nothing about the standard. Two,
    // because one of them has to be the UNVERIFIED case.
    const records = fromChecker(
      `m.parseRecords(${JSON.stringify(contract)})`,
    ) as { fields: Record<string, string> }[];

    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records.map((record) => record.fields.VERDICT)).toContain('UNVERIFIED');
  });

  it('holds no record that the checker would fail in CI', () => {
    const result = fromChecker(`m.evaluate(${JSON.stringify(contract)})`);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('says in the document itself that a complete record is not a verified claim', () => {
    // The one sentence this whole contract fails without. A structurally
    // complete packet called "verified" is the defect wearing the fix's badge.
    expect(contract).toContain(
      'A structurally complete record is not a verified claim',
    );
  });
});
