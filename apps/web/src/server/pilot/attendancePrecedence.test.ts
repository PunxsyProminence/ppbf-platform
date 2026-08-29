import fs from 'node:fs';
import path from 'node:path';

/**
 * CT-13 GUARD. The property here is not enforceable by types and fails
 * silently, which is why it is a test.
 *
 * Three attendance-shaped tables exist at three different grains:
 * pilot.attendance (athlete-day, unconstrained, legacy),
 * pilot.scheduler_attendance (athlete-CLASS), and pilot.activity_log
 * (person-occurrence). An athlete at two classes on Tuesday is two rows in one
 * and one row in the others.
 *
 * A well-meant `union all` across two of them to "get the full picture"
 * type-checks, passes review, and produces a participation figure inflated by
 * however many athletes attend more than one class a day. Nothing about it
 * looks wrong -- it looks thorough. Then it goes in a grant report.
 *
 * So this asserts against the SOURCE:
 *
 *   1. No single SQL statement may name more than one attendance relation.
 *   2. Only files that already read a legacy table may read one. Anything new
 *      goes through pilot.attendance_reconciled.
 *   3. The migration keeps the promises its own header makes: it declares the
 *      view, and it does NOT retrofit a unique constraint onto pilot.attendance
 *      (which would fail against real duplicate rows, and could only be made to
 *      pass by deleting records about real children).
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const appRoot = path.join(repositoryRoot, 'apps/web');
const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_attendance_precedence_migration.sql',
);

/**
 * Matchers are anchored so the names cannot shadow each other:
 * `pilot.attendance` is a prefix of `pilot.attendance_reconciled`, and matching
 * it loosely would report the view itself as a legacy read on every line.
 */
const RELATION_MATCHERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'pilot.attendance', pattern: /pilot\.attendance(?![\w_])/ },
  { name: 'pilot.scheduler_attendance', pattern: /pilot\.scheduler_attendance(?![\w_])/ },
  { name: 'pilot.activity_log', pattern: /pilot\.activity_log(?![\w_])/ },
];

/** The reconciled view. Reading this is always allowed -- it is the fix. */
const VIEW_PATTERN = /pilot\.attendance_reconciled(?![\w_])/;

/** What separates a query from a string that merely holds a table name. */
const SQL_KEYWORD = /\b(select|from|join|union|insert\s+into|update|delete\s+from)\b/i;

/**
 * Files that already read a legacy attendance table, each for a reason that
 * predates CT-13 and is documented in docs/current/ATTENDANCE_PRECEDENCE.md.
 * They are grandfathered, NOT endorsed: each keeps its own single source and
 * its own current numbers, and none of them crosses sources.
 *
 * Adding a file here should be a deliberate act with a reason. The default for
 * new work is pilot.attendance_reconciled.
 */
const LEGACY_READERS = new Set<string>([
  // Sole writer + reader of pilot.attendance: the intake case flow.
  // domain-upsert and review-action reach it through intake.ts's
  // createAttendance rather than their own SQL, so they are not listed here.
  'src/server/pilot/intake.ts',
  'app/api/pilot/intake/domain-get/route.ts',
  // Reads pilot.attendance for one coach-facing figure. See the open question
  // in docs/current/ATTENDANCE_PRECEDENCE.md about moving it to the view.
  'src/server/pilot/passbook.ts',
  // The scheduler owns pilot.scheduler_attendance: writer, and the read-side
  // rollups that answer class-attendance questions rather than day questions.
  'src/server/pilot/schedulerDb.ts',
  'src/server/pilot/attendanceReporting.ts',
  'src/server/pilot/wallDisplayDb.ts',
  'app/api/pilot/admin/export/roster/route.ts',
  // Writer of pilot.activity_log.
  'src/server/pilot/activityLog.ts',
  // Reads activity_log's boxing rows only, deliberately, and labels the result
  // "training days" rather than "attendance %" so it cannot be read as a rate.
  'src/server/pilot/performanceAnalytics.ts',
  // `select 1 from pilot.activity_log` -- an existence check that a cited
  // activity really happened, not a participation count.
  'src/server/pilot/interventionEvidence.ts',
  /* Reads one athlete's own boxing_training rows inside one development
     block's window, as one of six independent evidence sources, and reports
     how many entries are ON RECORD. Single source, never joined or unioned to
     scheduler_attendance or attendance, and no rate is derived: there is no
     denominator anywhere in that module, which is the property its own header
     and its tests exist to hold. It reads the raw table rather than the view
     because the question is not participation -- attendance_reconciled
     collapses to one row per athlete-day and carries neither
     what_was_worked_on nor activity_type, and the coach's own words about
     what a session worked on are the point of the read. Filtered to
     activity_domain = 'boxing_training' for the same reason the view's rank-1
     branch is: schoolwork and community-service hours are real, and they are
     not evidence about a training plan. */
  'src/server/pilot/blockReview.ts',
]);

const SCANNED_DIRECTORIES = ['app', 'components', 'src'];

function sourceFilesUnder(directory: string): string[] {
  const absolute = path.join(appRoot, directory);
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = path.join(current, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      found.push(path.relative(appRoot, full).split(path.sep).join('/'));
    }
  };

  walk(absolute);
  return found;
}

/**
 * Every string literal in a file -- backtick, single- and double-quoted alike.
 * Most queries here are template literals, but not all: the intake domain-get
 * route holds its whole query in a single-quoted string, and a scanner that
 * only read backticks would silently miss it and report a false all-clear.
 *
 * Comments are stripped first. Several modules name all three tables in their
 * headers precisely to explain why they only read one, and counting prose as a
 * query would fail the honest files while missing the dishonest ones.
 */
function sqlLiterals(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const literals: string[] = [];
  const pattern = /`([^`]*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  for (const match of withoutComments.matchAll(pattern)) {
    literals.push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  // A literal only counts as a query if it actually reads like one. Broadening
  // the scan to single quotes otherwise catches bare table-NAME strings, and
  // there is a legitimate one: privacyTiers.ts lists all three tables in
  // PUBLIC_RANKING_FORBIDDEN_TABLES, which is a prohibition on ranking, not a
  // query summing them. Any real cross-source read carries `from`/`join`/
  // `union`, so nothing this guard exists to catch escapes through here.
  return literals.filter((literal) => SQL_KEYWORD.test(literal));
}

function relationsIn(text: string): string[] {
  return RELATION_MATCHERS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

const allFiles = SCANNED_DIRECTORIES.flatMap(sourceFilesUnder);

describe('CT-13: attendance sources are never summed', () => {
  // The scan itself is what could rot. A glob that stopped matching would make
  // every assertion below vacuously true.
  test('the scan walks a real number of source files', () => {
    expect(allFiles.length).toBeGreaterThan(100);
    expect(allFiles).toContain('src/server/pilot/attendancePrecedence.ts');
  });

  test('no single SQL statement names more than one attendance table', () => {
    const offenders: string[] = [];

    for (const file of allFiles) {
      const source = fs.readFileSync(path.join(appRoot, file), 'utf8');
      for (const literal of sqlLiterals(source)) {
        const relations = relationsIn(literal);
        if (relations.length > 1) {
          offenders.push(`${file}: ${relations.join(' + ')}`);
        }
      }
    }

    // Each entry is a query joining or unioning two different attendance
    // grains -- the exact shape that inflates a participation figure.
    expect(offenders).toEqual([]);
  });

  test('only grandfathered files read a legacy attendance table directly', () => {
    const unexpected: string[] = [];

    for (const file of allFiles) {
      if (LEGACY_READERS.has(file)) continue;
      const source = fs.readFileSync(path.join(appRoot, file), 'utf8');
      for (const literal of sqlLiterals(source)) {
        const relations = relationsIn(literal);
        if (relations.length > 0) {
          unexpected.push(`${file}: ${relations.join(', ')}`);
          break;
        }
      }
    }

    // A new reader belongs on pilot.attendance_reconciled. If it genuinely
    // needs a raw table, add it to LEGACY_READERS with a reason.
    expect(unexpected).toEqual([]);
  });

  test('the grandfathered list has no stale entries', () => {
    const stale = [...LEGACY_READERS].filter((file) => {
      const full = path.join(appRoot, file);
      if (!fs.existsSync(full)) return true;
      const source = fs.readFileSync(full, 'utf8');
      return !sqlLiterals(source).some((literal) => relationsIn(literal).length > 0);
    });

    // A file that was converted to the view (or deleted) must come off the
    // list, so its length always reflects the real remaining work.
    expect(stale).toEqual([]);
  });

  test('the module that owns participation figures reads only the view', () => {
    const source = fs.readFileSync(
      path.join(appRoot, 'src/server/pilot/attendancePrecedence.ts'),
      'utf8',
    );
    const literals = sqlLiterals(source);

    expect(literals.some((literal) => VIEW_PATTERN.test(literal))).toBe(true);
    for (const literal of literals) {
      expect(relationsIn(literal)).toEqual([]);
    }
  });
});

describe('CT-13: the migration keeps its own promises', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  test('declares the reconciliation view', () => {
    expect(migration).toMatch(/create\s+or\s+replace\s+view\s+pilot\.attendance_reconciled/i);
  });

  test('does not drop or truncate either legacy table', () => {
    // Both hold real records. The fix is declared precedence, not deletion.
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete\s+from/i);
  });

  test('does not retrofit a unique constraint onto pilot.attendance', () => {
    // Deliberate: pilot.attendance may already hold duplicate athlete-days, so
    // a unique index fails at apply time against real data and could only be
    // made to pass by deleting rows about real children. The view
    // de-duplicates on read instead.
    expect(migration).not.toMatch(/create\s+unique\s+index[\s\S]*?pilot\.attendance(?![\w_])/i);
    expect(migration).not.toMatch(/alter\s+table\s+pilot\.attendance(?![\w_])/i);
  });

  test('resolves the scheduler day in the gym timezone, not UTC', () => {
    // scheduler_classes.start_at is timestamptz. Taking ::date in UTC pushes
    // every class starting after 8pm ET onto the next calendar day.
    expect(migration).toMatch(/at\s+time\s+zone\s+'America\/New_York'/i);
  });
});
