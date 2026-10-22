// Convention gate for audit finding F-067: who was in a session, and a staff
// note on an athlete in a session run, are STAFF ONLY. No athlete, parent,
// board, platform-owner or public route may reach them (OD-2026-10-10-003 items
// 3 and 4; OD-2026-10-11-007).
//
// The role gates themselves are exercised in the three routes' own suites, and
// the reads' filters on real rows in sessionRunAthletes.pg.test.ts. What this
// file adds is the sweep those cannot make: it reads every source file under
// app/, components/, lib/ and src/ from disk, so a NEW route, page or module
// that starts reading these records fails here until someone decides, on
// purpose, that it may.
//
// WHAT IT IS AND IS NOT. It is a source check: it proves which files name these
// records, not what any of them returns. It catches a new file that imports the
// presence module, calls one of the reads or writers by name, or names either
// table in its own SQL. It does NOT catch a new export added to a file already
// on the lists below and then called from somewhere else under a different
// name, nor a table name assembled from pieces at run time. Review reads the
// diff of the listed files; this gate watches everything outside them.

import fs from 'node:fs';
import path from 'node:path';

const WEB_DIR = path.resolve(__dirname, '../../..');
const API_DIR = path.join(WEB_DIR, 'app', 'api');
const PILOT_DIR = __dirname;

function filesUnder(dir: string, keep: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, keep));
    else if (keep(full)) found.push(full);
  }
  return found;
}

const relative = (file: string) => path.relative(WEB_DIR, file).split(path.sep).join('/');
const source = (file: string) => fs.readFileSync(file, 'utf8');
const isSource = (file: string) => /\.(ts|tsx|mts|mjs|js)$/.test(file) && !/\.test\.[a-z]+$/.test(file);

// Every shipped source file: routes, pages, components, server modules.
const ALL_SOURCE = ['app', 'components', 'lib', 'src'].flatMap((dir) => filesUnder(path.join(WEB_DIR, dir), isSource));

/** What reaches the records: the presence module (either quote style), and each read or writer by name. */
const REACHES =
  /sessionRunAthletes['"]|\b(setRunAthletePresent|listPresentAthletes|staffPermittedAthleteIds|staffPermittedAthletes|listRunStaffNotes|createRunStaffNote|listSettledRunsForOrganization|isSessionRunningForAthleteToday)\b/;

/** Either table, named in a file's own text (inline SQL included). */
const NAMES_A_TABLE = /session_run_athletes|session_staff_notes/;

// The only routes that may. Each is gated to coach, organization_admin and admin.
const STAFF_ROUTES = [
  'app/api/pilot/coach/session-staff-notes/route.ts',
  'app/api/pilot/session-scripts/runs/[runId]/athletes/route.ts',
  'app/api/pilot/session-scripts/runs/route.ts',
];

// The session-note read (F-067): sessionNotes.ts defines isSessionRunningForAthleteToday, a yes/no
// of whether this athlete is in a live run (or nobody is marked in it), and the staff-only
// session-note route is its one caller. Listed apart from STAFF_ROUTES because the route gates on
// its own SESSION_NOTE_READ_ROLES, pinned below to the same three staff roles.
const SESSION_NOTE_READERS = [
  'app/api/pilot/coach/athlete-session-note/route.ts',
  'src/server/pilot/sessionNotes.ts',
];

// The modules that define the reads and writers. privacyTiers.ts names them to forbid them on public surfaces.
const DEFINING_MODULES = [
  'src/server/pilot/privacyTiers.ts',
  'src/server/pilot/sessionRunAthletes.ts',
  'src/server/pilot/sessionScriptRuns.ts',
  'src/server/pilot/sessionStaffNotes.ts',
];

// The only files whose own text names either table. sessionNotes.ts asks one
// yes/no of session_run_athletes for the staff-only session-note route
// (isSessionRunningForAthleteToday, F-067): is this athlete in a live run, or
// is nobody marked in it. It returns no name, no run and no mark.
// behaviourObservations.ts asks one yes/no of session_run_athletes before a
// coach's behaviour report is filed under a run (Jason 2026-10-18, "A: Strict
// (Rec.)"): is this athlete marked present on it. It returns nothing from the
// table; its only callers are the coach routes behaviour-observations and
// behaviour-keys, gated to coach, organization_admin and admin.
// sessionRunClass.ts (D4) sets one mark's register pointer after a tap on a
// session tied to a class wrote the register; it reads nothing back from the
// table, and its only caller is setRunAthletePresent.
const TABLE_FILES = [
  'src/server/pilot/behaviourObservations.ts',
  'src/server/pilot/privacyTiers.ts',
  'src/server/pilot/sessionNotes.ts',
  'src/server/pilot/sessionRunAthletes.ts',
  'src/server/pilot/sessionRunClass.ts',
  'src/server/pilot/sessionStaffNotes.ts',
];

const HANDLER = /^export\s+(?:async\s+function|function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm;

describe('who was in a session, and notes on a run, are reached only from staff routes', () => {
  const routes = filesUnder(API_DIR, (file) => /route\.tsx?$/.test(file));

  it('the sweep reads the files it claims to (it has not gone blind)', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(ALL_SOURCE.length).toBeGreaterThan(routes.length + 200);
    const all = ALL_SOURCE.map(relative);
    for (const file of [...STAFF_ROUTES, ...DEFINING_MODULES, ...SESSION_NOTE_READERS]) {
      expect(all).toContain(file);
    }
  });

  it('exactly the three staff routes, the defining modules and the session-note read reach them, anywhere in the app', () => {
    expect(ALL_SOURCE.filter((file) => REACHES.test(source(file))).map(relative).sort())
      .toEqual([...STAFF_ROUTES, ...DEFINING_MODULES, ...SESSION_NOTE_READERS].sort());
  });

  it('the session-note route admits only coach, organization admin and the legacy admin name', () => {
    const text = source(path.join(WEB_DIR, SESSION_NOTE_READERS[0]));
    const handlers = Array.from(text.matchAll(HANDLER)).length;
    expect(handlers).toBe(1);
    expect(text).not.toMatch(/^export\s*(\{|\*)/m);
    expect(Array.from(text.matchAll(/requireRole\(\s*principal\s*,\s*\[\.\.\.SESSION_NOTE_READ_ROLES\]\s*\)/g))).toHaveLength(1);
    expect(text).toMatch(/const SESSION_NOTE_READ_ROLES = \['coach', 'organization_admin', 'admin'\] as const;/);
  });

  it('no route, page, component or other module names either table in its own text', () => {
    expect(ALL_SOURCE.filter((file) => NAMES_A_TABLE.test(source(file))).map(relative).sort()).toEqual(TABLE_FILES);
  });

  it('no route under an athlete, parent, guardian, family, board, public or platform path reaches them', () => {
    const audience = /\/api\/(pilot\/)?(athlete|parent|guardian|family|board|public|platform|wall|kiosk)\b/;
    const reaching = routes.map(relative).filter((file) => audience.test(`/${file.replace(/^app/, '')}`.replace('//', '/')));
    expect(reaching.length).toBeGreaterThan(0);
    for (const file of reaching) {
      const text = source(path.join(WEB_DIR, file));
      expect({ file, reaches: REACHES.test(text) || NAMES_A_TABLE.test(text) }).toEqual({ file, reaches: false });
    }
  });

  it.each(STAFF_ROUTES)('%s admits only coach, organization admin and the legacy admin name', (route) => {
    const text = source(path.join(WEB_DIR, route));
    const gates = Array.from(text.matchAll(/requireRole\(\s*principal\s*,\s*\[\.\.\.([A-Z_]+)\]\s*\)/g), (match) => match[1]);
    // Every handler in the file is gated, and by one of the two staff lists. Every way of
    // exporting a handler is counted, and a re-export (which this cannot read) is refused.
    const handlers = Array.from(text.matchAll(HANDLER)).length;
    expect(handlers).toBeGreaterThan(0);
    expect(text).not.toMatch(/^export\s*(\{|\*)/m);
    expect(gates).toHaveLength(handlers);
    for (const gate of gates) {
      expect(['RUN_ROLES', 'STAFF_NOTE_ROLES']).toContain(gate);
    }
    if (gates.includes('RUN_ROLES')) {
      expect(text).toMatch(/const RUN_ROLES = \['coach', 'admin', 'organization_admin'\] as const;/);
    }
  });

  it('STAFF_NOTE_ROLES is the three staff roles and nothing else', () => {
    expect(source(path.join(PILOT_DIR, 'sessionStaffNotes.ts')))
      .toMatch(/export const STAFF_NOTE_ROLES = \['coach', 'organization_admin', 'admin'\] as const;/);
  });

  it('no component or page imports a value from a server module that reads them', () => {
    const client = ALL_SOURCE.filter((file) => /\.tsx$/.test(file) && !/^src\//.test(relative(file)));
    expect(client.length).toBeGreaterThan(50);
    // A type-only import is erased at build time and carries no data; a value import would not be.
    const valueImport = /^import (?!type\b)[^;]*from ['"]@\/src\/server\/pilot\/(sessionRunAthletes|sessionStaffNotes|sessionScriptRuns)['"];/m;
    expect(client.filter((file) => valueImport.test(source(file))).map(relative)).toEqual([]);
  });
});
