import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// run-migration-suites.mjs states that its equivalence with what actually runs
// "is asserted continuously by migrationRunnerCoverage.test.ts". That file did
// not exist. The claim was true of nothing for as long as it was written down.
//
// It matters because TWO places decide which migration suites run, and they
// decided it by different means:
//
//   npm run test:migrations            -> run-migration-suites.mjs, by discovery
//   pre-release-migrations.yml         -> its own inline parser, by regex
//
// #722 replaced the `&&` chain with the discovery runner and did not touch the
// workflow. The workflow kept matching /npm run (test:migrations:...)/ against
// a value that had become `node scripts/run-migration-suites.mjs`, matched
// zero, threw, and killed the job under `set -euo pipefail`.
//
// Nothing reported it, because the failure was in the step that BUILDS the
// list rather than in a suite. Scheduled runs 1-7 passed; run 8 -- the first
// after #722 -- failed, with "Run every migration suite" skipped. The nightly
// readiness gate verified nothing.
//
// The repair is that the workflow imports the runner's own function instead of
// carrying a second parser. This file pins that arrangement: one derivation,
// imported in both places, with a floor neither can silently fall through.

const PILOT_DIR = __dirname;
const REPO_ROOT = path.resolve(PILOT_DIR, '../../../../..');
const RUNNER = path.resolve(PILOT_DIR, '../../../scripts/run-migration-suites.mjs');
const WORKFLOW = path.join(REPO_ROOT, '.github/workflows/pre-release-migrations.yml');
const PACKAGE_JSON = path.resolve(PILOT_DIR, '../../../package.json');

// Normalized because a trailing \r silently defeats any regex anchored with $.
const WORKFLOW_SOURCE = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const RUNNER_SOURCE = fs.readFileSync(RUNNER, 'utf8');

/**
 * The runner is ESM consumed by node; ts-jest runs CommonJS with no ESM loader
 * (`npm test` passes no --experimental-vm-modules). Evaluated in one real node
 * child process, the pattern researchImportScope.test.ts already uses.
 */
/**
 * Only the executable body of the resolve step -- the heredoc node runs.
 *
 * Assertions about what the step DOES must not be satisfiable by prose. The
 * step's comments necessarily describe the old broken shape and name the
 * function it now imports, so a step-wide search matches either way.
 */
function executableResolveScript(): string {
  const start = WORKFLOW_SOURCE.indexOf('node --input-type=module');
  const end = WORKFLOW_SOURCE.indexOf('name: Run every migration suite');
  const script = WORKFLOW_SOURCE.slice(start, end);
  return script
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

function discoveredSuites(): string[] {
  const moduleUrl = pathToFileURL(RUNNER).href;
  const script = `
    import fs from 'node:fs';
    import { discoverSuiteScripts } from ${JSON.stringify(moduleUrl)};
    const { scripts } = JSON.parse(fs.readFileSync(${JSON.stringify(PACKAGE_JSON)}, 'utf8'));
    process.stdout.write(JSON.stringify(discoverSuiteScripts(scripts)));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

describe('the nightly gate and the runner resolve the same suites', () => {
  it('reads a workflow and a runner that exist', () => {
    // A broken path would make every assertion below vacuously pass.
    expect(WORKFLOW_SOURCE).toContain('name: pre-release-migrations');
    expect(RUNNER_SOURCE).toContain('export function discoverSuiteScripts');
  });

  it('the workflow IMPORTS the runner derivation rather than carrying its own', () => {
    // The whole defect was a second implementation of one question. A workflow
    // that re-derives the list can be correct today and wrong after any change
    // to the manifest shape -- which is exactly what happened.
    //
    // Scoped to the EXECUTABLE heredoc, not the whole step. Mutation testing
    // caught this: deleting the import while leaving the comment that explains
    // it still satisfied a step-wide substring search, so the guard passed over
    // the exact regression it exists to catch. A comment is not an import.
    expect(executableResolveScript()).toMatch(
      /import\s*\{\s*discoverSuiteScripts\s*\}\s*from\s*'[^']*run-migration-suites\.mjs'/,
    );
    expect(executableResolveScript()).toContain('discoverSuiteScripts(scripts)');
  });

  it('the workflow no longer parses the chain format that stopped existing', () => {
    // The specific regression. #722 made `test:migrations` a single command;
    // any step still hunting `npm run test:migrations:*` inside it resolves
    // zero and dies. Scoped to the executable step so this file may describe
    // the old shape in its own comments.
    const resolveStep = WORKFLOW_SOURCE.slice(
      WORKFLOW_SOURCE.indexOf('node --input-type=module'),
      WORKFLOW_SOURCE.indexOf('name: Run every migration suite'),
    );

    expect(resolveStep).not.toMatch(/matchAll\(\/npm run/);
  });

  it('test:migrations really is the discovery runner the workflow imports', () => {
    // The coupling the workflow now depends on. If test:migrations went back to
    // being a chain, importing discoverSuiteScripts would still resolve every
    // registered suite -- but the two would no longer be the same question, and
    // this suite should be revisited rather than quietly kept green.
    const { scripts } = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    expect(scripts['test:migrations']).toBe('node scripts/run-migration-suites.mjs');
  });

  it('discovery returns the whole suite set, not a truncated one', () => {
    const suites = discoveredSuites();

    // The floor exists because a discovery that returns nothing runs nothing
    // and exits clean -- the failure mode a chain cannot have. Both the runner
    // and the workflow refuse below 50, so the real count must clear it by a
    // margin rather than sit on it.
    expect(suites.length).toBeGreaterThan(100);
    expect(suites.every((name) => /^test:migrations:[a-z0-9-]+$/.test(name))).toBe(true);
  });

  it('both places refuse a suspiciously small discovery instead of trusting it', () => {
    // Without this, narrowing either floor to zero would leave every other
    // assertion here passing while the gate silently guarded nothing.
    expect(RUNNER_SOURCE).toMatch(/suites\.length < 50/);

    const resolveStep = WORKFLOW_SOURCE.slice(
      WORKFLOW_SOURCE.indexOf('node --input-type=module'),
      WORKFLOW_SOURCE.indexOf('name: Run every migration suite'),
    );
    expect(resolveStep).toMatch(/suites\.length < 50/);
  });

  it('every discovered suite is a script that actually exists', () => {
    // Discovery reads keys off the manifest, so this cannot fail by
    // construction today -- it fails if the derivation is ever rewritten to
    // synthesize names rather than read them.
    const { scripts } = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    const missing = discoveredSuites().filter((name) => !scripts[name]);
    expect(missing).toEqual([]);
  });
});
