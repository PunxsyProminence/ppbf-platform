/**
 * CYCLE TRACKING IS THE ATHLETE'S ALONE, and this file is what makes that more than a comment.
 *
 * Jason chose cycle tracking "C: Now" (2026-10-18). It is a child's health data, so it is opt-in,
 * readable only by that athlete, never shown to coaches, parents, staff or the gym TV, never used
 * to change training, never sent to SHADOW, and deleted with the athlete. The screen tells the
 * athlete "Only you can see this in the app". That sentence stays true only while no code other
 * than the athlete's own path can reach the rows, so this pins the shape:
 *
 *   1. The tables (pilot.athlete_cycle_tracking, pilot.athlete_cycle_entries) are named only in
 *      the files listed below: the migration that creates them, its runner and suite, the
 *      privacy denylist, and the athlete-only module and route. A coach read, a parent hub, an
 *      export, a research or de-identification job, a SHADOW context builder, a wall or TV query
 *      or another migration (a view, a join) that names them fails here.
 *   2. The module that reads them (src/server/pilot/athleteCycle.ts) is imported only by the
 *      athlete's own route, app/api/pilot/athlete/cycle/route.ts exactly (not a sibling route), and
 *      by tests.
 *
 * Widening either list is a change somebody makes on purpose, in review, and it needs a separate
 * ruling from Jason. Not caught: a table name assembled at run time.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCANNED_ROOTS = ['apps', 'packages', 'scripts', 'infra', '.github'];
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'coverage', 'dist', 'build', 'out', 'test-results', 'playwright-report']);
const SOURCE = /\.(?:[cm]?[jt]sx?|sql|ps1|py|sh|ya?ml)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const CYCLE_TABLE = /athlete_cycle_(?:tracking|entries)\b|['"`]pilot\.athlete_cycle['"`]/;
const MODULE = String.raw`[^'"]*\/athleteCycle(?:\.[cm]?[jt]sx?)?['"]`;
const CYCLE_MODULE_IMPORT = new RegExp(String.raw`from\s+['"]${MODULE}|import\(\s*['"]${MODULE}\s*\)|require\(\s*['"]${MODULE}\s*\)`);

/** The only files that may name the cycle tables. */
const MAY_NAME_THE_TABLES = new Set([
  'infra/azure/pilot_slice_postgres_athlete_self_report_measures_migration.sql',
  'apps/web/scripts/pilot-apply-athlete-self-report-measures-migration.mjs',
  'apps/web/src/server/pilot/athleteSelfReportMeasures.pg.test.ts',
  // The public-surface denylist names them so that no wall, TV or public read may.
  'apps/web/src/server/pilot/privacyTiers.ts',
  'apps/web/src/server/pilot/privacyTiers.test.ts',
  'apps/web/src/server/pilot/cycleTrackingAthleteOnly.test.ts',
  // The athlete-only module and its suite (lane L58 PR-4).
  'apps/web/src/server/pilot/athleteCycle.ts',
  'apps/web/src/server/pilot/athleteCycle.pg.test.ts',
  // Pins the one ruled DELETE the deletion paths issue (Jason: "A: Delete at once").
  'apps/web/src/server/pilot/dataDeletion.test.ts',
]);

/** The athlete's own cycle route; nothing else may import the module (not even a sibling route)... */
const ATHLETE_CYCLE_ROUTE = 'apps/web/app/api/pilot/athlete/cycle/route.ts';
/** ...except the athlete deletion paths, and only for the one delete function (Jason: "A: Delete at once"). */
const DELETION_PATHS = 'apps/web/src/server/pilot/dataDeletion.ts';
const DELETE_ONLY_IMPORT = /import\s*\{\s*deleteCycleTrackingForDeletedAthletes\s*\}\s*from\s*'\.\/athleteCycle';/;

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(full));
    else if (SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

const files = SCANNED_ROOTS.flatMap((root) => sourcesUnder(path.join(REPO_ROOT, root)))
  .map((full) => ({ full, relative: path.relative(REPO_ROOT, full).split(path.sep).join('/') }));

describe('cycle tracking is reachable only through the athlete', () => {
  test('the scan reads the repository it claims to (a scan of nothing would pass)', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files.some((file) => file.relative === 'infra/azure/pilot_slice_postgres_athlete_self_report_measures_migration.sql')).toBe(true);
  });

  test('only the listed files name the cycle tables', () => {
    const naming = files
      .filter((file) => CYCLE_TABLE.test(fs.readFileSync(file.full, 'utf8')))
      .map((file) => file.relative)
      .filter((relative) => !MAY_NAME_THE_TABLES.has(relative));
    expect(naming).toEqual([]);
  });

  test("only the athlete's own cycle route (and tests) import the cycle module", () => {
    const importing = files
      .filter((file) => !TEST.test(file.relative))
      .filter((file) => file.relative !== ATHLETE_CYCLE_ROUTE && file.relative !== DELETION_PATHS)
      .filter((file) => CYCLE_MODULE_IMPORT.test(fs.readFileSync(file.full, 'utf8')))
      .map((file) => file.relative);
    expect(importing).toEqual([]);
  });

  test('the deletion paths import only the delete function, and both soft-delete paths call it', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, DELETION_PATHS), 'utf8');
    const imports = source.match(new RegExp(CYCLE_MODULE_IMPORT.source, 'g')) ?? [];
    expect(imports).toHaveLength(1);
    expect(source).toMatch(DELETE_ONLY_IMPORT);
    expect(source.match(/await deleteCycleTrackingForDeletedAthletes\(/g)).toHaveLength(2);
  });

  test('the patterns catch what they are meant to', () => {
    // Negative controls: without these the two tests above could pass on patterns that match nothing.
    expect(CYCLE_TABLE.test('select * from pilot.athlete_cycle_entries')).toBe(true);
    expect(CYCLE_TABLE.test('join pilot.athlete_cycle_tracking t on')).toBe(true);
    expect(CYCLE_TABLE.test("'pilot.athlete_cycle',")).toBe(true);
    expect(CYCLE_TABLE.test('pilot.athlete_check_ins')).toBe(false);
    expect(CYCLE_MODULE_IMPORT.test("import { listCycleEntries } from '@/src/server/pilot/athleteCycle';")).toBe(true);
    expect(CYCLE_MODULE_IMPORT.test("import x from './athleteCycle'")).toBe(true);
    expect(CYCLE_MODULE_IMPORT.test("await import('../pilot/athleteCycle')")).toBe(true);
    expect(CYCLE_MODULE_IMPORT.test("import x from './athleteCycle.ts'")).toBe(true);
    expect(CYCLE_MODULE_IMPORT.test("require('./athleteCycle.js')")).toBe(true);
    expect(CYCLE_MODULE_IMPORT.test("import x from './athleteCycleView'")).toBe(false);
    expect(CYCLE_MODULE_IMPORT.test("import { checkIn } from './athleteCheckIns';")).toBe(false);
  });
});
