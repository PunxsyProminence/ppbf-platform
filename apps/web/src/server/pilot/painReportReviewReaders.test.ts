import fs from 'node:fs';
import path from 'node:path';

/**
 * DR-25 reader guard (Overwatch GO on PR #2133: "Every PR shows a diff check that no reader was
 * added: the near-misses route and the SHADOW feed select no new column").
 *
 * The pain report note and its review live on pilot.shadow_near_misses
 * (pilot_slice_postgres_pain_report_review_migration.sql). They are a minor's health information,
 * and the ruled readers are exactly the coach pain list's: coach, organization_admin and admin,
 * per athlete. So:
 *   - every non-test file in the repository that names the table, code or SQL, is pinned below:
 *     a new reader, view or function is a new file in this list, in the diff, where review sees it;
 *   - only the files in NOTE_AND_REVIEW_FILES may name the new columns at all;
 *   - no SQL statement that names the table reads a whole row: `select *`, `alias.*`,
 *     `returning *`, `to_jsonb(alias)` and the like carry a new column to a reader without naming it;
 *   - the near-misses reader (shadowNearMisses.ts) and the SHADOW feed (shadowReadModels.ts),
 *     which athletes and parents reach, name none of the new columns.
 * BLIND SPOTS: a table name assembled at run time (`pilot.${name}`, held in a constant, or joined
 * from two strings with +) is not seen by the whole-row check; the pinned file list is the
 * backstop: such a file still has to be written, and none of the pinned ones does it. A whole row
 * named later in a select list (`select n.id, n from ...`) is not told apart from a column name
 * without parsing SQL. The scanner reads a regex literal as code, so a regex containing a quote, a
 * backtick, `//` or `/*` can hide the rest of its line; none of the pinned files has one.
 */

const repoRoot = path.resolve(__dirname, '../../../../..');

/** Every non-test file naming pilot.shadow_near_misses outside a comment, as of this PR. */
const NEAR_MISS_FILES: readonly string[] = [
  'apps/web/app/api/pilot/coach/pain-reports/[nearMissId]/note/route.ts',
  'apps/web/app/api/pilot/coach/pain-reports/[nearMissId]/review/route.ts',
  'apps/web/app/api/pilot/coach/pain-reports/route.ts',
  'apps/web/app/api/pilot/shadow/near-misses/route.ts',
  'apps/web/scripts/pilot-apply-pain-report-review-migration.mjs',
  'apps/web/scripts/pilot-apply-shadow-decision-loop-migration.mjs',
  'apps/web/scripts/pilot-apply-shadow-runtime-migration.mjs',
  'apps/web/scripts/pilot-cleanup-deleted-data.mjs',
  'apps/web/src/server/pilot/athleteInjuries.ts',
  'apps/web/src/server/pilot/escalationLadder.ts',
  'apps/web/src/server/pilot/formulas/painReportAlert.ts',
  'apps/web/src/server/pilot/painReportNotes.ts',
  'apps/web/src/server/pilot/privacyTiers.ts',
  'apps/web/src/server/pilot/shadowNearMisses.ts',
  'infra/azure/pilot_slice_postgres_athlete_injuries_migration.sql',
  'infra/azure/pilot_slice_postgres_pain_report_review_migration.sql',
  'infra/azure/pilot_slice_postgres_shadow_decision_loop_migration.sql',
];

/**
 * Files allowed to name the new columns: the migration and its runner (PR 1); the note's writer,
 * the review write and the coach pain list's read (painReportNotes.ts, painReportAlert.ts); and
 * the purge's name scrub (pilot-cleanup-deleted-data.mjs; Overwatch Q6 A on #2135) (PR 2).
 */
const NOTE_AND_REVIEW_FILES: readonly string[] = [
  'apps/web/scripts/pilot-apply-pain-report-review-migration.mjs',
  'apps/web/scripts/pilot-cleanup-deleted-data.mjs',
  'apps/web/src/server/pilot/formulas/painReportAlert.ts',
  'apps/web/src/server/pilot/painReportNotes.ts',
  'infra/azure/pilot_slice_postgres_pain_report_review_migration.sql',
];

const TABLE = /\bshadow_near_misses\b|"shadow_near_misses"/;
const NOTE_COLUMN = /\b(athlete_note|athlete_note_admin_only|athleteNote|athleteNoteAdminOnly)\b/;
/** reviewed_at and reviewed_by_account_id are common names; they matter where the near-miss table is named. */
const REVIEW_COLUMN = /\b(reviewed_by_account_id|reviewed_at)\b/;

/** Whole-row reads: each carries a new column to its reader without naming it. */
const WHOLE_ROW: readonly RegExp[] = [
  /select\s+(?:distinct\s+(?:on\s*\([^)]*\)\s*)?)?\*/i,
  /\b[a-z_]\w*\.\*(?![\w)])/i,
  /returning\s+\*/i,
  /\b(?:to_jsonb?|row_to_json|jsonb?_agg|jsonb?_populate_record|hstore)\s*\(\s*[a-z_]\w*\s*\)/i,
  // `select n from pilot.shadow_near_misses n`, also through a join: the selected name is the
  // near-miss table's own alias.
  /select\s+([a-z_]\w*)\s+from\s+[\s\S]*?pilot\."?shadow_near_misses"?\s+(?:as\s+)?\1\b/i,
  // `select shadow_near_misses from pilot.shadow_near_misses`: the whole row by the table's name.
  /select\s+"?shadow_near_misses"?\s+from\b/i,
];

const SKIP_DIRECTORIES = new Set(['node_modules', '.next', '.git', 'docs', 'coverage', 'dist', 'build']);
const SOURCE = /\.(ts|tsx|mjs|js|cjs|sql)$/;
const TEST = /\.(test|spec)\.(ts|tsx|js|mjs)$/;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * One pass over a JavaScript or TypeScript source that knows where strings are: comments are
 * dropped (so a file that only mentions the table in prose is not a reader, and a `/*` inside a
 * string such as 'src/*' does not swallow the code after it), and every string literal -- single
 * quoted, double quoted or template -- is collected, because one-line SQL is written in all three.
 * Template `${...}` parts stay inside their literal; a regex literal is read as code.
 */
function scan(source: string): { code: string; strings: string[] } {
  let code = '';
  const strings: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        if (source[end] === '\\') end += 1;
        else if (char !== '`' && source[end] === '\n') break;
        end += 1;
      }
      const literal = source.slice(index, end + 1);
      strings.push(literal);
      code += literal;
      index = end + 1;
      continue;
    }
    code += char;
    index += 1;
  }
  return { code, strings };
}

/** Comments removed, and the SQL statements in the file: split on `;` for .sql, every string literal otherwise. */
function read(source: string, file: string): { code: string; statements: string[] } {
  if (file.endsWith('.sql')) {
    const code = source.replace(/--.*$/gm, '');
    return { code, statements: code.split(';') };
  }
  const { code, strings } = scan(source);
  return { code, statements: strings };
}

const relative = (file: string) => path.relative(repoRoot, file).split(path.sep).join('/');
const files = sourceFiles(repoRoot).map((file) => ({
  file: relative(file),
  ...read(fs.readFileSync(file, 'utf8'), file),
}));
const naming = files.filter(({ code }) => TABLE.test(code));

describe('pain report note and review: no new reader (DR-25)', () => {
  test('every file that names the near-miss table is pinned', () => {
    expect(naming.map(({ file }) => file).sort()).toEqual([...NEAR_MISS_FILES].sort());
  });

  test('only the allowed files name the note columns', () => {
    const noting = files.filter(({ code }) => NOTE_COLUMN.test(code)).map(({ file }) => file);
    expect(noting.sort()).toEqual([...NOTE_AND_REVIEW_FILES].sort());
  });

  test('only the allowed files name the review columns beside the near-miss table', () => {
    const reviewing = naming.filter(({ code }) => REVIEW_COLUMN.test(code)).map(({ file }) => file);
    expect(reviewing.filter((file) => !NOTE_AND_REVIEW_FILES.includes(file))).toEqual([]);
  });

  test('no statement that names the near-miss table reads a whole row', () => {
    const offending: string[] = [];
    for (const { file, statements } of naming) {
      for (const statement of statements) {
        if (!TABLE.test(statement)) continue;
        for (const pattern of WHOLE_ROW) {
          if (pattern.test(statement)) offending.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  test('the pain-report trigger is one stored value in the alert and in the review write', () => {
    const literal = "'athlete_pain_report'";
    const alert = fs.readFileSync(path.join(repoRoot, 'apps/web/src/server/pilot/formulas/painReportAlert.ts'), 'utf8');
    const notes = fs.readFileSync(path.join(repoRoot, 'apps/web/src/server/pilot/painReportNotes.ts'), 'utf8');
    expect(alert).toContain(`const PAIN_REPORT_TRIGGER = ${literal};`);
    expect(notes).toContain(`export const PAIN_REPORT_NEAR_MISS_TRIGGER = ${literal};`);
  });

  test('the near-misses reader and the SHADOW feed name none of the new columns', () => {
    for (const file of ['apps/web/src/server/pilot/shadowNearMisses.ts', 'apps/web/src/server/pilot/shadowReadModels.ts']) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source).not.toMatch(NOTE_COLUMN);
      expect(source).not.toMatch(/reviewed_by_account_id/);
    }
  });

  test('the whole-row patterns catch the reads they are for, and not an explicit column list', () => {
    const caught = (statement: string) => WHOLE_ROW.some((pattern) => pattern.test(statement));
    for (const statement of [
      'select * from pilot.shadow_near_misses where organization_id = $1',
      'select distinct on (athlete_id) * from pilot.shadow_near_misses',
      'select n.near_miss_id, n.* from pilot.shadow_near_misses n',
      'select * from pilot.athletes a join pilot.shadow_near_misses n on true',
      'update pilot.shadow_near_misses set reviewed_at = now() returning *',
      'select to_jsonb(n) from pilot.shadow_near_misses n',
      'select row_to_json(n) from pilot.shadow_near_misses n',
      'select jsonb_agg(n) from pilot.shadow_near_misses n',
      'select n from pilot.shadow_near_misses n',
      'select n from pilot.athletes a join pilot.shadow_near_misses n on true',
      'select shadow_near_misses from pilot.shadow_near_misses',
    ]) {
      expect([statement, caught(statement)]).toEqual([statement, true]);
    }
    expect(caught('select near_miss_id, severity, count(*) from pilot.shadow_near_misses group by 1, 2')).toBe(false);
    expect(caught("select 1 from pilot.shadow_near_misses where metadata->>'trigger' = $1")).toBe(false);
    expect(caught('select near_miss_id from pilot.shadow_near_misses where organization_id = $1')).toBe(false);
  });

  test('the scanner reads SQL in every kind of string, and a /* inside a string is not a comment', () => {
    const source = [
      "const glob = 'src/*';",
      "await client.query('update pilot.shadow_near_misses set reviewed_at = now() returning *', [id]);",
      'await query("select * from pilot.shadow_near_misses where organization_id = $1", [org]);',
      'await query(`select near_miss_id from pilot.shadow_near_misses`);',
      '/* a closing comment */',
      '// select * from pilot.shadow_near_misses (prose)',
    ].join('\n');
    const { code, statements } = read(source, 'probe.ts');
    expect(code).toContain('returning *');
    expect(code).not.toContain('(prose)');
    expect(code).not.toContain('a closing comment');
    const whole = statements.filter((statement) => TABLE.test(statement) && WHOLE_ROW.some((pattern) => pattern.test(statement)));
    expect(whole).toHaveLength(2);
  });
});
