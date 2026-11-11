import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * THE INDEX OF RULINGS AT THE TOP OF docs/current/OWNER_DECISIONS.md IS GENERATED.
 *
 * OD-2026-11-11-001 ("G1 A"): one row per `## OD-` entry, so a session can find
 * the rulings without reading ~190,000 words. scripts/owner-decisions-index.mjs
 * writes it (--write) and checks it (--check, run by ci.yml ahead of the
 * docs-only fast path). Status is read ONLY from a fixed-form dated Status line;
 * prose such as "superseded" in an entry never sets one. This file proves the
 * script bites: it runs it on the real file and on planted cases in a temp dir.
 */

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/owner-decisions-index.mjs');
const DECISIONS_FILE = path.join(REPO, 'docs/current/OWNER_DECISIONS.md');

type Result = { status: number; output: string };

function run(mode: '--check' | '--write', file?: string): Result {
  try {
    const stdout = execFileSync(process.execPath, file ? [SCRIPT, mode, file] : [SCRIPT, mode], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const real = readFileSync(DECISIONS_FILE, 'utf8');
const NEW_ENTRY = [
  '## OD-2099-01-01-001 -- A planted older entry: "planted words"',
  '',
  '**Provenance: PRIMARY**',
  '',
  'Body.',
  '',
  '## OD-2099-01-02-001 -- A planted newer entry',
  '',
  '**Provenance: DERIVED**',
  '',
  '**Not ruled here:** nothing.',
  '',
].join('\n');

/** Plants `extra` after the real entries, writes the index, then lets `after` alter the file. */
function withFile<T>(extra: string, fn: (file: string, text: () => string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-index-'));
  try {
    const file = path.join(dir, 'OWNER_DECISIONS.md');
    writeFileSync(file, `${real}\n${extra}\n`);
    return fn(file, () => readFileSync(file, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('owner decisions index', () => {
  test('the real decisions file carries a current index with one row per entry', () => {
    const result = run('--check');
    expect(result.output).toMatch(/Owner decisions index: \d+ rows, current/);
    expect(result.status).toBe(0);
    const entries = real.split('\n').filter((l) => /^## OD-/.test(l)).length;
    const block = real.slice(real.indexOf('<!-- owner-decisions-index:start -->'), real.indexOf('<!-- owner-decisions-index:end -->'));
    const rows = block.split('\n').filter((l) => /^\| OD-\d{4}-\d{2}-\d{2}-\d{3} \|/.test(l)).length;
    expect(rows).toBe(entries);
  });

  test('no index line starts with "## OD-" (the id check reads those as entries)', () => {
    const start = real.indexOf('<!-- owner-decisions-index:start -->');
    const end = real.indexOf('<!-- owner-decisions-index:end -->');
    expect(start).toBeGreaterThan(-1);
    expect(real.slice(start, end).split('\n').some((l) => l.startsWith('## OD-'))).toBe(false);
  });

  test('a new entry with no row fails --check, and --write fixes it', () => {
    withFile('', (file) => {
      expect(run('--write', file).status).toBe(0);
      expect(run('--check', file).status).toBe(0);
    });
    withFile('', (file, text) => {
      run('--write', file);
      writeFileSync(file, `${text()}\n${NEW_ENTRY}\n`);
      const failed = run('--check', file);
      expect(failed.status).toBe(1);
      expect(failed.output).toContain('owner-decisions-index.mjs --write');
      expect(run('--write', file).status).toBe(0);
      expect(run('--check', file).status).toBe(0);
      expect(text()).toMatch(/\| OD-2099-01-02-001 \| 2099-01-02 \| A planted newer entry \| DERIVED \| {2}\| yes \|/);
      expect(text()).toContain('| OD-2099-01-01-001 | 2099-01-01 | A planted older entry | PRIMARY |');
    });
  });

  test('a stale row fails --check', () => {
    withFile('', (file, text) => {
      run('--write', file);
      writeFileSync(file, text().replace(/^(\| OD-2026-11-10-002 \|.*)$/m, '$1 stale'));
      expect(run('--check', file).status).toBe(1);
    });
  });

  test('a missing row fails --check', () => {
    withFile('', (file, text) => {
      run('--write', file);
      writeFileSync(file, text().replace(/^\| OD-2026-11-10-002 \|.*\n/m, ''));
      expect(run('--check', file).status).toBe(1);
    });
  });

  test('a fixed-form replaced line sets the status', () => {
    const older = NEW_ENTRY.replace(
      'Body.',
      'Body.\n\n**Status, 2099-01-03:** replaced by OD-2099-01-02-001. The newer entry says: "this replaces it".',
    );
    withFile(older, (file, text) => {
      expect(run('--write', file).status).toBe(0);
      expect(text()).toMatch(/\| OD-2099-01-01-001 \|.*\| replaced by OD-2099-01-02-001 \(2099-01-03\) \|/);
    });
  });

  test('a fixed-form partly replaced line names its part', () => {
    const older = NEW_ENTRY.replace(
      'Body.',
      'Body.\n\n**Status, 2099-01-03:** partly replaced by OD-2099-01-02-001 (the hold on item 2). "quote"',
    );
    withFile(older, (file, text) => {
      expect(run('--write', file).status).toBe(0);
      expect(text()).toContain('partly replaced by OD-2099-01-02-001 (the hold on item 2) (2099-01-03)');
    });
  });

  test('two fixed-form lines both show, oldest first', () => {
    const older = NEW_ENTRY.replace(
      'Body.',
      'Body.\n\n**Status, 2099-01-03:** partly replaced by OD-2099-01-02-001 (ruling 1). "a"\n\n**Status, 2099-01-04:** partly replaced by OD-2099-01-02-001 (ruling 2). "b"',
    );
    withFile(older, (file, text) => {
      expect(run('--write', file).status).toBe(0);
      expect(text()).toContain('(ruling 1) (2099-01-03); partly replaced by OD-2099-01-02-001 (ruling 2) (2099-01-04)');
    });
  });

  test('a free-text "superseded" sentence does NOT set a status', () => {
    const older = NEW_ENTRY.replace(
      'Body.',
      'Body.\n\nThis was superseded by OD-2099-01-02-001.\n\n**Status:** replaced by OD-2099-01-02-001 (no date, not the fixed form).\n\n**Status (2099-01-03):** superseded by OD-2099-01-02-001.',
    );
    withFile(older, (file, text) => {
      expect(run('--write', file).status).toBe(0);
      expect(text()).toMatch(/\| OD-2099-01-01-001 \| 2099-01-01 \| A planted older entry \| PRIMARY \| {2}\| {2}\|/);
    });
  });

  test('a replaced line naming an id that heads no entry fails', () => {
    const older = NEW_ENTRY.replace('Body.', 'Body.\n\n**Status, 2099-01-03:** replaced by OD-2099-12-31-009. "x"');
    withFile(older, (file) => {
      const result = run('--write', file);
      expect(result.status).toBe(1);
      expect(result.output).toContain('OD-2099-12-31-009, which heads no entry');
    });
  });

  test('an empty or missing file fails rather than passing on nothing', () => {
    expect(run('--check', path.join(tmpdir(), 'no-such-dir-od-index', 'OWNER_DECISIONS.md')).status).toBe(1);
  });
});
