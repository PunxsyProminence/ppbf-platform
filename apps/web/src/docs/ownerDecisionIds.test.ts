import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * AN OWNER DECISION ID NAMES ONE DECISION.
 *
 * docs/current/OWNER_DECISIONS.md is where Jason's decisions are recorded
 * (OD-2026-09-28-003), and other documents, tests and PRs cite them by id --
 * "OD-2026-09-28-010 item 8". An id that heads two entries makes every such
 * citation ambiguous, and nothing reading the citation can tell.
 *
 * It has happened: #986 and #975 each created an `OD-2026-09-26-001`, because
 * each took "the next free number" from its own branch. #975's entry became
 * -002, and #989 had to repoint two code comments that by then cited a ruling
 * about visual design where they meant the near-miss audience gate.
 *
 * THE CHECK lives in scripts/check-owner-decision-ids.mjs, one copy only. It
 * refuses a malformed "## OD-" heading (which would otherwise slip past the
 * uniqueness check) and any id that heads more than one entry. It does not
 * check ordering, dates, or citations elsewhere.
 *
 * WHERE IT RUNS. ci.yml runs the script on every change, ahead of the
 * docs-only fast path, because a new entry is usually a docs-only change and
 * that path skips `npm test`. This file proves the script bites: it runs it on
 * the real file and on planted collisions in a temp directory.
 */

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/check-owner-decision-ids.mjs');
const DECISIONS_FILE = path.join(REPO, 'docs/current/OWNER_DECISIONS.md');

function run(file?: string): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, file ? [SCRIPT, file] : [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/* The real file's entries, so planted samples clear the script's floor. */
const realEntries = readFileSync(DECISIONS_FILE, 'utf8');

function withSample(extra: string): { status: number; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-ids-'));
  try {
    const file = path.join(dir, 'OWNER_DECISIONS.md');
    writeFileSync(file, `${realEntries}\n${extra}\n`);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('owner decision ids', () => {
  test('the real decisions file passes', () => {
    const result = run();
    expect(result.output).toMatch(/Owner decision ids: \d+ entries/);
    expect(result.status).toBe(0);
  });

  test('a repeated id fails, naming the id', () => {
    const result = withSample('## OD-2026-09-28-001 -- a second entry that took the same id');
    expect(result.status).toBe(1);
    expect(result.output).toContain('OD-2026-09-28-001 heads more than one entry');
  });

  test('a malformed id heading fails', () => {
    const result = withSample('## OD-2026-9-28-3 -- malformed');
    expect(result.status).toBe(1);
    expect(result.output).toContain('malformed id heading');
  });

  test('a sub-heading that mentions an id is not an entry', () => {
    const result = withSample('### OD-2026-09-28-001 -- a sub-heading, not an entry');
    expect(result.status).toBe(0);
  });

  test('an empty or missing file fails rather than passing on nothing', () => {
    expect(run(path.join(tmpdir(), 'no-such-dir-od-ids', 'OWNER_DECISIONS.md')).status).toBe(1);
    const dir = mkdtempSync(path.join(tmpdir(), 'od-ids-'));
    try {
      const empty = path.join(dir, 'OWNER_DECISIONS.md');
      writeFileSync(empty, '');
      expect(run(empty).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
