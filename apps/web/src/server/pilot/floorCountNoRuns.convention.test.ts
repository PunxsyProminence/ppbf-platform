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
// WHAT IT IS AND IS NOT. A source check: it proves which modules these files import and which names
// their text holds, not what any of them returns at run time. The module walk follows relative and
// "@/" imports, not packages; a table name assembled at run time is not caught.

import fs from 'node:fs';
import path from 'node:path';

const WEB_DIR = path.resolve(__dirname, '../../..');
const FLOOR_COUNT = 'src/server/pilot/floorCount.ts';
const PLATFORM_DIR = path.join(WEB_DIR, 'app', 'api', 'pilot', 'platform');
const CLASSES_ROUTE = 'app/api/pilot/on-the-floor/classes/route.ts';

/** The session-run modules: the run itself, its marks, the TV's session read, the round clock, and the presence line. */
const RUN_MODULE = /\/(sessionScriptRuns|sessionRunAthletes|sessionRunClass|gymTvs|roundTimers|onTheFloor)\.tsx?$/;
const RUN_TABLE = /session_run_athletes|session_script_runs|session_run_|round_timers/;
const IDLE_CLOSE = /\b(closeIdleSessionRuns|sweepIdleRuns)\b/;
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function read(relative: string): string {
  return fs.readFileSync(path.join(WEB_DIR, relative), 'utf8');
}

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [path.relative(WEB_DIR, full)] : [];
  });
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(WEB_DIR, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  const candidates = ['.ts', '.tsx', '.js', '.mjs'].map((ext) => base + ext)
    .concat(['.ts', '.tsx', '.js'].map((ext) => path.join(base, `index${ext}`)));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

/** Every repository file a file reaches through its relative and "@/" imports, itself included. */
function reachable(relative: string): string[] {
  const seen = new Set<string>();
  const todo = [path.join(WEB_DIR, relative)];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const next = resolveSpecifier(file, match[1]);
      if (next && !seen.has(next)) todo.push(next);
    }
  }
  return [...seen].map((file) => path.relative(WEB_DIR, file)).sort();
}

const PLATFORM_ROUTES = routeFiles(PLATFORM_DIR).sort();
const SCOPED = [FLOOR_COUNT, ...PLATFORM_ROUTES];

describe('the floor count is register-only, and the platform owner stays off the run tables', () => {
  it('finds the files it guards', () => {
    expect(fs.existsSync(path.join(WEB_DIR, FLOOR_COUNT))).toBe(true);
    expect(PLATFORM_ROUTES).toContain('app/api/pilot/platform/gym-summary/route.ts');
    expect(PLATFORM_ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(SCOPED)('%s reaches no session-run module, directly or through its imports', (file) => {
    const reached = reachable(file);
    expect(reached.length).toBeGreaterThan(1);
    expect({ file, runModules: reached.filter((each) => RUN_MODULE.test(`/${each}`)) }).toEqual({ file, runModules: [] });
  });

  it.each(SCOPED)('%s names no run table and runs no idle close', (file) => {
    const text = read(file);
    expect({ file, runTable: RUN_TABLE.test(text), idleClose: IDLE_CLOSE.test(text) })
      .toEqual({ file, runTable: false, idleClose: false });
  });

  it('the module walk itself finds a run module where one is imported (control)', () => {
    expect(reachable(CLASSES_ROUTE).filter((each) => RUN_MODULE.test(`/${each}`))).toContain('src/server/pilot/gymTvs.ts');
  });

  it('floorCount.ts reads the register and holds the board floor', () => {
    const text = read(FLOOR_COUNT);
    expect(text).toMatch(/from pilot\.scheduler_attendance sa/);
    expect(text).toMatch(/import \{ BOARD_MINIMUM_COHORT_SIZE \} from '\.\/boardSummary';/);
    expect(text).toMatch(/c\.status <> 'cancelled'/);
  });
});

describe('only the classes line reads the floor count (App Overwatch, 7206212516)', () => {
  // No attendance figure, report or export may use floorCount.ts: its importers are pinned, and a
  // new one fails here until App Overwatch approves it by name.
  const ALLOWED_IMPORTERS = [CLASSES_ROUTE];

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)
        ? [path.relative(WEB_DIR, full)]
        : [];
    });
  }

  it('is imported by the classes line route and nothing else', () => {
    const importers = ['app', 'components', 'lib', 'src']
      .filter((dir) => fs.existsSync(path.join(WEB_DIR, dir)))
      .flatMap((dir) => sourceFiles(path.join(WEB_DIR, dir)))
      .filter((file) => file !== FLOOR_COUNT)
      .filter((file) => Array.from(read(file).matchAll(SPECIFIER), (m) => m[1])
        .some((specifier) => resolveSpecifier(path.join(WEB_DIR, file), specifier) === path.join(WEB_DIR, FLOOR_COUNT)))
      .sort();
    expect(importers).toEqual(ALLOWED_IMPORTERS);
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
});
