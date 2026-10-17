import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * ONE STATUS PER CAPABILITY, AND IT MATCHES THE CODE.
 *
 * Jason, 2026-10-16: "Fix capability-status truth: DONE, mapped,
 * claimed/no-code, DRAFT. These need to be unambiguous." Before this, a
 * module's Status cell held one of thirteen strings, and nothing ran on the
 * PR that changed one: a module file is documentation, and ci.yml's docs-only
 * fast path skips `npm test`, so capabilityEvidence.test.ts only ever ran on
 * the next unrelated code PR.
 *
 * THE CHECK lives in scripts/check-capability-status.mjs, one copy only, and
 * ci.yml runs it ahead of the docs-only fast path. Its header gives the four
 * statuses. This file proves it bites: it runs it on the real modules and on
 * one planted violation per rule, in a temp copy of the modules folder.
 */

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/check-capability-status.mjs');
const MODULES = path.join(REPO, 'docs/capabilities/modules');

function run(dir?: string): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, dir ? [SCRIPT, dir] : [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/* Real paths that exist on main, so a planted module fails for one reason only. */
const ROUTE = 'apps/web/app/api/pilot/incidents/route.ts';
const ROUTE_TEST = 'apps/web/app/api/pilot/incidents/route.test.ts';
const SERVER = 'apps/web/src/server/pilot/escalationLadder.ts';

function moduleText(status: string, code: string, tests: string): string {
  return [
    '# Module 999 -- planted',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Status | ${status} |`,
    `| Code | ${code} |`,
    `| Tests | ${tests} |`,
    '',
  ].join('\n');
}

/** A copy of the real modules plus one planted file, checked by the script. */
function withPlanted(name: string, text: string): { status: number; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'capability-status-'));
  try {
    for (const f of readdirSync(MODULES)) copyFileSync(path.join(MODULES, f), path.join(dir, f));
    writeFileSync(path.join(dir, name), text);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tick = (p: string) => `\`${p}\``;

describe('capability status check', () => {
  test('the real modules pass', () => {
    const result = run();
    expect(result.output).toMatch(/Capability status: \d+ modules; DONE \d+/);
    expect(result.status).toBe(0);
  });

  test('a well-formed planted DONE passes (the controls below fail for their one reason)', () => {
    const result = withPlanted('999-planted.md', moduleText('**DONE**', `${tick(ROUTE)}, ${tick(SERVER)}`, tick(ROUTE_TEST)));
    expect(result.status).toBe(0);
  });

  test.each([
    ['a status outside the four', moduleText('**DONE** (Wave 9)', tick(ROUTE), tick(ROUTE_TEST)), /Status must be exactly one of/],
    ['DONE with no test', moduleText('**DONE**', tick(ROUTE), 'none'), /DONE needs at least one test file/],
    ['DONE with no route or page', moduleText('**DONE**', tick(SERVER), tick(ROUTE_TEST)), /DONE needs a route\.ts or page\.tsx/],
    ['MAPPED with no code', moduleText('**MAPPED**', 'none', 'none'), /MAPPED needs at least one existing path/],
    ['DRAFT that cites code', moduleText('**DRAFT**', tick(SERVER), 'none'), /DRAFT means no code/],
    ['CLAIMED-NO-CODE outside the item-18 list', moduleText('**CLAIMED-NO-CODE**', 'none', 'none'), /only for the modules relabelled/],
    ['a cited path that does not exist', moduleText('**MAPPED**', tick('apps/web/src/server/pilot/doesNotExist.ts'), 'none'), /cites missing/],
    ['a test file in the Code row', moduleText('**MAPPED**', tick(ROUTE_TEST), 'none'), /cites a test file/],
    ['a non-test file in the Tests row', moduleText('**MAPPED**', tick(SERVER), tick(ROUTE)), /not a test file/],
    ['a Code row without a Tests row', moduleText('**MAPPED**', tick(SERVER), 'none').replace(/^\| Tests .*$/m, ''), /not the other/],
  ])('%s fails, naming the module', (_label, text, message) => {
    const result = withPlanted('999-planted.md', text);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(message);
    expect(result.output).toMatch(/999-planted\.md/);
  });

  test('an empty or missing folder fails rather than passing over nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'capability-status-empty-'));
    try {
      expect(run(dir).status).toBe(1);
      expect(run(path.join(dir, 'missing')).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
