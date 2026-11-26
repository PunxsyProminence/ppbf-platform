import fs from 'node:fs';
import path from 'node:path';

/**
 * WHO READS A FAMILY THREAD (W4 item 4, lane W4-4). A guardian's message to the coach about their
 * own child, and the staff replies under it, live in pilot.family_thread_posts and
 * pilot.family_thread_reads (migration family-threads). The ruled readers are the guardian who
 * opened the thread (OD-2026-10-12-024: never the other guardian) and the gym's staff
 * (Overwatch Q3 A on #2161); the athlete reads none of it. So:
 *   - every non-test file in the repository that names either table is pinned below: a new reader,
 *     view or function is a new entry in this list, in the diff, where review sees it;
 *   - every file that imports the store (familyThreads.ts) is pinned too: a new route or screen
 *     that reaches the data does so in the diff;
 *   - none of those files reads a whole row (`select *`, `alias.*`, `returning *`, row-to-JSON),
 *     which would carry a column to a reader without naming it.
 * BLIND SPOT: a table name assembled at run time is not seen by the scan; the pinned lists are the
 * backstop, since such a file must still be written and none of the pinned ones does it.
 */

const repoRoot = path.resolve(__dirname, '../../../../..');

/** Every non-test file naming either table, as of this PR. */
const TABLE_FILES: readonly string[] = [
  // EM-IX-2 (lane W4-1, OVERWATCH 7188512792 on #2217): an index on created_at and its runner's
  // readiness check, which reads the catalog only; they read no row.
  'apps/web/scripts/pilot-apply-email-alert-sweep-indexes-2-migration.mjs',
  'apps/web/scripts/pilot-apply-family-threads-migration.mjs',
  // EM-4c (lane W4-1, OVERWATCH 7188512792 on #2217): the guardian_message email source reads a
  // post's gym, athlete, author role, id and time, and whether a staff member has a read row; never the text.
  'apps/web/src/server/pilot/emailAlertEvents.ts',
  'apps/web/src/server/pilot/familyThreads.ts',
  'infra/azure/pilot_slice_postgres_email_alert_sweep_indexes_2_migration.sql',
  'infra/azure/pilot_slice_postgres_family_threads_migration.sql',
];

/** Every non-test file importing the store, as of this PR: the guardian routes (PM-1b), the staff routes (PM-1c) and the unread count (PM-2). */
const STORE_IMPORTERS: readonly string[] = [
  'apps/web/app/api/pilot/coach/family-thread-reads/route.ts',
  'apps/web/app/api/pilot/coach/family-threads/route.ts',
  'apps/web/app/api/pilot/coach/family-threads/unread/route.ts',
  'apps/web/app/api/pilot/parent/family-thread-reads/route.ts',
  'apps/web/app/api/pilot/parent/family-threads/route.ts',
];

const TABLE = /\bfamily_thread_(?:posts|reads)\b/;
const STORE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:@\/src\/server\/pilot\/|\.{1,2}\/(?:[\w.-]+\/)*)familyThreads['"]/;
const WHOLE_ROW: readonly RegExp[] = [
  /select\s+(?:distinct\s+)?\*/i,
  /\b[a-z_]\w*\.\*(?![\w)])/i,
  /returning\s+\*/i,
  /\b(?:to_jsonb?|row_to_json|jsonb?_agg|jsonb?_populate_record)\s*\(\s*[a-z_]\w*\s*\)/i,
];

const SCAN_ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/src', 'apps/web/scripts', 'apps/web/lib', 'apps/web/types', 'apps/research-bridge', 'packages', 'infra', 'scripts'];
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|sql)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|[\\/](?:__tests__|e2e)[\\/]/;

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (CODE_FILE.test(entry.name) && !TEST_FILE.test(full)) out.push(full);
  }
}

function nonTestFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(repoRoot, root), files);
  return files.map((file) => path.relative(repoRoot, file).split(path.sep).join('/')).sort();
}

/** The text with line and block comments removed, so a comment that names a table is not a reader. */
function code(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/^\s*--.*$/gm, '')
    .replace(/\s--\s.*$/gm, '');
}

describe('family threads: every reader is in the diff (W4 item 4)', () => {
  const files = nonTestFiles();

  test('the non-test files that name the tables are exactly the pinned ones', () => {
    expect(files.filter((file) => TABLE.test(code(file)))).toEqual([...TABLE_FILES].sort());
  });

  test('the non-test files that import the store are exactly the pinned ones', () => {
    expect(files.filter((file) => STORE_IMPORT.test(fs.readFileSync(path.join(repoRoot, file), 'utf8'))))
      .toEqual([...STORE_IMPORTERS].sort());
  });

  test('no pinned file reads a whole row', () => {
    const found: string[] = [];
    for (const file of [...TABLE_FILES, ...STORE_IMPORTERS]) {
      const text = code(file);
      for (const pattern of WHOLE_ROW) {
        const match = pattern.exec(text);
        if (match) found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  test('the scan sees what it is meant to see', () => {
    // Negative controls: the patterns match the shapes they exist to catch, so an empty result
    // above is not an empty scanner.
    expect(TABLE.test('select post_id from pilot.family_thread_posts')).toBe(true);
    expect(TABLE.test('-- nothing here')).toBe(false);
    expect(STORE_IMPORT.test("import { x } from '@/src/server/pilot/familyThreads';")).toBe(true);
    expect(STORE_IMPORT.test("import { x } from './familyThreads';")).toBe(true);
    expect(STORE_IMPORT.test("await import('@/src/server/pilot/familyThreads')")).toBe(true);
    expect(STORE_IMPORT.test("require('./familyThreads')")).toBe(true);
    for (const sample of ['select * from t', 'select p.* from t p', 'insert into t values (1) returning *', 'select to_jsonb(p) from t p']) {
      expect(WHOLE_ROW.some((pattern) => pattern.test(sample))).toBe(true);
    }
    expect(code('apps/web/src/server/pilot/familyThreads.ts')).not.toMatch(/WHO, ON EVERY CALL/);
    expect(files.length).toBeGreaterThan(500);
  });
});
