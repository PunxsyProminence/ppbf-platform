// Convention gate for the "on the floor now" counts (lane W4-3, FN-4a; GO on #2192, 7206014991).
//
// Two promises, held here as source checks:
//
// 1. THE COUNT IS REGISTER-ONLY AND THE PLATFORM OWNER STAYS OFF THE RUN TABLES. floorCount.ts, the
//    count the board's, the platform owner's and the staff-role and volunteer homes read, and every
//    /api/pilot/platform/ route, reach none of the session-run modules (not directly, not through
//    anything they import), name no run table in their own text, and run no idle close. The count
//    reads present register marks only (flag 12; QC A), and OD-2026-10-07-011 ruling 2 took the
//    platform owner off the session-script runs (FN-0 flag 6).
// 2. THE CLASSES LINE'S ROUTE ADMITS EXACTLY ITS SIX ROLES. GET only; board, staff, volunteer, coach,
//    organization admin and admin; the platform owner, parents and athletes refused (approved by name
//    in the GO). Its answers' fields are asserted in its own route test.
//
// 3. ONLY THE "ON THE FLOOR NOW" READS USE THE COUNT: the classes line route and, for the platform
//    owner's floored total (FN-4c), the platform gym summary, which takes only the total and the floor.
//    No attendance figure, report or export may use floorCount.ts (App Overwatch's answer A,
//    7206212516): every source file that names it is pinned.
//
// WHAT IT IS AND IS NOT. A source check: it proves which files these files reach and which names their
// text, and every reached file's text, holds; not what any of them returns at run time. The module walk
// follows relative and "@/" imports the way tsconfig resolves them ("@/" is src/ first, then the app
// root), fails on one it cannot resolve, and refuses an import built from a template string. Package
// imports are not followed; a table name assembled at run time from pieces is not caught.

import fs from 'node:fs';
import path from 'node:path';

const WEB_DIR = path.resolve(__dirname, '../../..');
const FLOOR_COUNT = 'src/server/pilot/floorCount.ts';
const PLATFORM_DIR = path.join(WEB_DIR, 'app', 'api', 'pilot', 'platform');
const CLASSES_ROUTE = 'app/api/pilot/on-the-floor/classes/route.ts';
const TV_MODULE = 'src/server/pilot/gymTvs.ts';

/** The session-run modules: the run itself, its marks, the TV's session read, the round clock, and the presence line. */
const RUN_MODULE = /\/(sessionScriptRuns|sessionRunAthletes|sessionRunClass|gymTvs|roundTimers|onTheFloor)\.tsx?$/;
const RUN_TABLE = /session_run_athletes|session_script_runs|session_run_|round_timers/;
const IDLE_CLOSE = /\b(closeIdleSessionRuns|sweepIdleRuns)\b/;
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const TEMPLATE_IMPORT = /\b(?:import|require)\s*\(\s*`/;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function read(relative: string): string {
  return fs.readFileSync(path.join(WEB_DIR, relative), 'utf8');
}

/** Every non-test source file under `dir`, relative to the app. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return SOURCE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path.relative(WEB_DIR, full)] : [];
  });
}

function existingFile(candidate: string): boolean {
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
}

/**
 * The file a relative or "@/" specifier names, as tsconfig resolves it ("@/*" is "./src/*" then "./*",
 * tsconfig.json paths; jest.config.js the same). null for a package. undefined when it names nothing.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null | undefined {
  let bases: string[];
  if (specifier.startsWith('@/')) {
    const rest = specifier.slice(2);
    bases = [path.join(WEB_DIR, 'src', rest), path.join(WEB_DIR, rest)];
  } else if (specifier.startsWith('.')) {
    bases = [path.resolve(path.dirname(fromFile), specifier)];
  } else {
    return null;
  }
  for (const base of bases) {
    const candidates = [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'].map((ext) => base + ext),
      ...['.ts', '.tsx', '.js'].map((ext) => path.join(base, `index${ext}`))];
    const found = candidates.find(existingFile);
    if (found) return found;
  }
  return undefined;
}

interface Reach {
  readonly files: string[];
  readonly unresolved: string[];
}

/** Every repository file a file reaches through its relative and "@/" imports, itself included. */
function reachable(relative: string): Reach {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const todo = [path.join(WEB_DIR, relative)];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!SOURCE.test(file)) continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const next = resolveSpecifier(file, match[1]);
      if (next === undefined) unresolved.push(`${path.relative(WEB_DIR, file)} -> ${match[1]}`);
      else if (next && !seen.has(next)) todo.push(next);
    }
  }
  return { files: [...seen].map((file) => path.relative(WEB_DIR, file)).sort(), unresolved };
}

const PLATFORM_FILES = sourceFiles(PLATFORM_DIR).sort();
const SCOPED = [FLOOR_COUNT, ...PLATFORM_FILES];

describe('the floor count is register-only, and the platform owner stays off the run tables', () => {
  it('finds the files it guards', () => {
    expect(fs.existsSync(path.join(WEB_DIR, FLOOR_COUNT))).toBe(true);
    expect(PLATFORM_FILES).toContain('app/api/pilot/platform/gym-summary/route.ts');
    expect(PLATFORM_FILES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(SCOPED)('%s resolves every import it makes, and builds none from a template', (file) => {
    const { files, unresolved } = reachable(file);
    expect(files.length).toBeGreaterThan(1);
    expect({ file, unresolved }).toEqual({ file, unresolved: [] });
    expect({ file, templateImports: files.filter((each) => SOURCE.test(each) && TEMPLATE_IMPORT.test(read(each))) })
      .toEqual({ file, templateImports: [] });
  });

  it.each(SCOPED)('%s reaches no session-run module, directly or through its imports', (file) => {
    const { files } = reachable(file);
    expect({ file, runModules: files.filter((each) => RUN_MODULE.test(`/${each}`)) }).toEqual({ file, runModules: [] });
  });

  it.each(SCOPED)('%s, and every file it reaches, names no run table and runs no idle close', (file) => {
    const { files } = reachable(file);
    const named = files.filter((each) => SOURCE.test(each)).filter((each) => {
      const text = read(each);
      return RUN_TABLE.test(text) || IDLE_CLOSE.test(text);
    });
    expect({ file, named }).toEqual({ file, named: [] });
  });

  it('controls: each check catches what it is for', () => {
    // The walk follows the "@/src/..." form and finds a run module where one is imported.
    expect(reachable(CLASSES_ROUTE).files.filter((each) => RUN_MODULE.test(`/${each}`))).toContain(TV_MODULE);
    // The "@/server/..." form resolves into src/, as tsconfig does, and a missing file is reported.
    expect(resolveSpecifier(path.join(WEB_DIR, CLASSES_ROUTE), '@/server/pilot/gymTvs')).toBe(path.join(WEB_DIR, TV_MODULE));
    expect(resolveSpecifier(path.join(WEB_DIR, CLASSES_ROUTE), '@/server/pilot/noSuchModule')).toBeUndefined();
    // The text checks catch the TV module, which names a run table and runs the idle close.
    expect(RUN_TABLE.test(read(TV_MODULE))).toBe(true);
    expect(IDLE_CLOSE.test(read(TV_MODULE))).toBe(true);
    expect(TEMPLATE_IMPORT.test('const m = await import(`./${name}`);')).toBe(true);
  });

  it('floorCount.ts reads the register and holds the board floor', () => {
    const text = read(FLOOR_COUNT);
    expect(text).toMatch(/from pilot\.scheduler_attendance sa/);
    expect(text).toMatch(/import \{ BOARD_MINIMUM_COHORT_SIZE \} from '\.\/boardSummary';/);
    expect(text).toMatch(/c\.status <> 'cancelled'/);
  });
});

describe('only the on-the-floor reads use the floor count (App Overwatch, 7206212516)', () => {
  // No attendance figure, report or export may use floorCount.ts: every non-test source file that names
  // it at all, by any import form or none, is pinned, and a new one fails here until App Overwatch
  // approves it by name. scripts/ (the app's and the repository's) holds this repo's exports.
  // FN-4c adds the platform owner's gym summary, named in the GO's approved list (7206014991).
  const ALLOWED_NAMERS = [CLASSES_ROUTE, 'app/api/pilot/platform/gym-summary/route.ts'].sort();
  const REPO_SCRIPTS = path.resolve(WEB_DIR, '..', '..', 'scripts');

  it('is named by the classes line route and the platform gym summary, and no other source file', () => {
    const roots = ['app', 'components', 'lib', 'src', 'scripts'].map((dir) => path.join(WEB_DIR, dir)).concat(REPO_SCRIPTS);
    const namers = roots
      .filter((dir) => fs.existsSync(dir))
      .flatMap((dir) => sourceFiles(dir))
      .filter((file) => file !== FLOOR_COUNT)
      .filter((file) => /floorCount/.test(fs.readFileSync(path.join(WEB_DIR, file), 'utf8')))
      .sort();
    expect(namers).toEqual(ALLOWED_NAMERS);
  });

  // The platform owner gets only the floored total (QC A; flag 6): never a class, title, time or room.
  it('the platform gym summary takes only the total and the floor from it, and no platform file names the classes read', () => {
    const summary = 'app/api/pilot/platform/gym-summary/route.ts';
    expect(read(summary)).toContain("import { floored, registerTotalToday } from '@/src/server/pilot/floorCount';");
    expect(read(summary).match(/@\/src\/server\/pilot\/floorCount'/g)).toHaveLength(1);
    expect(PLATFORM_FILES.filter((file) => /classesRunningNow|ClassRunningNow/.test(read(file)))).toEqual([]);
  });

  it('control: the classes line route imports it, by the "@/src" form', () => {
    expect(Array.from(read(CLASSES_ROUTE).matchAll(SPECIFIER), (m) => resolveSpecifier(path.join(WEB_DIR, CLASSES_ROUTE), m[1])))
      .toContain(path.join(WEB_DIR, FLOOR_COUNT));
  });
});

describe('the classes line route admits exactly its six roles', () => {
  const text = read(CLASSES_ROUTE);

  it('declares the six roles, and only GET', () => {
    expect(text).toContain(
      "const CLASSES_LINE_READ_ROLES = ['board', 'staff', 'volunteer', 'coach', 'organization_admin', 'admin'] as const;",
    );
    const handlers = Array.from(text.matchAll(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/gm), (m) => m[1]);
    expect(handlers).toEqual(['GET']);
  });

  it('resolves the session, then gates on those roles, before anything else', () => {
    expect(text).toMatch(
      /const principal = await requirePrincipal\(request\);\n\s*requireRole\(principal, \[\.\.\.CLASSES_LINE_READ_ROLES\]\);\n\s*if \(request\.nextUrl\.searchParams\.size > 0\) \{/,
    );
    expect(text.match(/requireRole\(/g)).toHaveLength(1);
  });

  it('takes the gym from the session, never the request', () => {
    expect(text).toContain('const organizationId = principal.organizationId;');
    expect(text).not.toMatch(/searchParams\.get\(|request\.json\(|organization_id/);
  });

  it('reads at the current moment: the round read\'s now drives the idle close, which writes', () => {
    expect(text).toContain('const now = new Date();');
    expect(text.match(/new Date\(/g)).toHaveLength(1);
    expect(text).toContain('listLiveTvRounds(organizationId, now)');
  });
});
