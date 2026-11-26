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
  /sessionRunAthletes['"]|\b(setRunAthletePresent|listPresentAthletes|staffPermittedAthleteIds|staffPermittedAthletes|listRunStaffNotes|createRunStaffNote|listSettledRunsForOrganization|isSessionRunningForAthleteToday|setSessionRunClass|markSessionNoShowsAbsent|describeRunClass|listStoppedComing|listOnTheFloorForStaff)\b/;

/** Either table, named in a file's own text (inline SQL included). */
const NAMES_A_TABLE = /session_run_athletes|session_staff_notes/;

// The only routes that may. Each is gated to coach, organization_admin and admin.
const STAFF_ROUTES = [
  'app/api/pilot/coach/session-staff-notes/route.ts',
  'app/api/pilot/session-scripts/runs/[runId]/athletes/route.ts',
  // tie_class and mark_no_shows (D4): a tie answers which of the run's marked athletes it copied.
  'app/api/pilot/session-scripts/runs/[runId]/route.ts',
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

// The stopped-coming list (lane W4-6, SC-1; Jason OW27-32 A, "Yes, on this page only"): an
// open-gym "here" mark counts as coming on that page, so stoppedComing.ts reads the last standing
// mark day per athlete that the register does not hold (untied runs, taps that created no register
// mark, cancelled classes; App Overwatch on #2172), and its one route is the only caller of
// listStoppedComing.
// Approved for exactly these two files, the route pinned below to coach, organization_admin and
// admin (Overwatch, W4-6 GO on #2163, condition 1). Nothing else from the table leaves the module.
const STOPPED_COMING_READERS = [
  'app/api/pilot/stopped-coming/route.ts',
  'src/server/pilot/stoppedComing.ts',
];

// The "on the floor now" line (lane W4-3, FN-1; Jason Q3.1 C and Q3.3 A, OD-2026-11-21-006; privacy
// review FN-0, signed off on #2160): onTheFloor.ts reads which athletes stand marked on a live run,
// for the coach and admin line, and its one route is the only caller of listOnTheFloorForStaff.
// Approved for exactly these two files, the route pinned below to coach, organization_admin and
// admin (OVERWATCH: GO W4-3 on #2192); parents and athletes are added only by FN-2, which narrows
// this test's family rule rather than dropping it. Ids and names of counted athletes leave the
// module; no run, mark, marker or time does.
const ON_THE_FLOOR_READERS = [
  'app/api/pilot/on-the-floor/route.ts',
  'src/server/pilot/onTheFloor.ts',
];

// The modules that define the reads and writers. privacyTiers.ts names them to forbid them on public surfaces.
const DEFINING_MODULES = [
  'src/server/pilot/privacyTiers.ts',
  'src/server/pilot/sessionRunAthletes.ts',
  'src/server/pilot/sessionRunClass.ts',
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
// table, but its refusal says whether the athlete is marked present, and so
// does that of reportPlaceFor, which opens a sampled window
// (behaviourSampleWindows.ts). Who may import either module is pinned below
// (WRITER_ROUTES, WRITER_MODULES), and every route among them is gated to
// coach, organization_admin and admin.
// sessionRunClass.ts (D4) sets one mark's register pointer after a tap on a
// session tied to a class wrote the register, and reads a run's standing marks
// (ids) to copy them when the session is tied mid-way and to skip them in the
// no-shows tap; its callers are setRunAthletePresent and the staff run routes.
// sessionScriptRuns.ts reads one timestamp from each table, inside the SQL
// that closes a live run idle for three hours (OD-2026-10-21-001 ruling 2,
// Jason: "A: Yes, after 3 hours (Rec.)"): the newest mark, unmark or
// note on the run counts as activity. The statement returns only the ids of
// the runs it closed; no athlete, name, mark or note leaves it, so the TV read
// that triggers it (gymTvs.ts) gets nothing from either table.
// stoppedComing.ts (lane W4-6, SC-1) reads one day per athlete from
// session_run_athletes: the last standing mark the register does not hold. It returns no
// run, mark or marker; see STOPPED_COMING_READERS.
// onTheFloor.ts (lane W4-3, FN-1) reads which athletes stand marked on a live run, for the staff
// line; it returns ids and names only, never the run, mark, marker or time; see ON_THE_FLOOR_READERS.
const TABLE_FILES = [
  'src/server/pilot/behaviourObservations.ts',
  'src/server/pilot/onTheFloor.ts',
  'src/server/pilot/privacyTiers.ts',
  'src/server/pilot/sessionNotes.ts',
  'src/server/pilot/sessionRunAthletes.ts',
  'src/server/pilot/sessionRunClass.ts',
  'src/server/pilot/sessionScriptRuns.ts',
  'src/server/pilot/sessionStaffNotes.ts',
  'src/server/pilot/stoppedComing.ts',
];

// The behaviour writer and the window module (PATTERN-1d-2, 1e): their refusals say whether an
// athlete is marked present on a run (see TABLE_FILES). Only these files import either, and each
// route among them is gated to the three staff roles (Overwatch 7084899452 point 3).
// patternStanding.ts reads the reports for the tier engine; it files nothing and opens no window.
const WRITER_IMPORT = /\bbehaviour(Observations|SampleWindows)(\.[cm]?[jt]sx?)?['"]/;
const WRITER_ROUTES = [
  'app/api/pilot/coach/behaviour-keys/route.ts',
  'app/api/pilot/coach/behaviour-observations/route.ts',
  'app/api/pilot/coach/behaviour-windows/[windowId]/route.ts',
  'app/api/pilot/coach/behaviour-windows/route.ts',
];
const WRITER_MODULES = [
  'src/server/pilot/behaviourSampleWindows.ts',
  'src/server/pilot/patternStanding.ts',
];

const HANDLER = /^export\s+(?:async\s+function|function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm;

describe('who was in a session, and notes on a run, are reached only from staff routes', () => {
  const routes = filesUnder(API_DIR, (file) => /route\.tsx?$/.test(file));

  it('the sweep reads the files it claims to (it has not gone blind)', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(ALL_SOURCE.length).toBeGreaterThan(routes.length + 200);
    const all = ALL_SOURCE.map(relative);
    for (const file of [...STAFF_ROUTES, ...DEFINING_MODULES, ...SESSION_NOTE_READERS, ...STOPPED_COMING_READERS, ...ON_THE_FLOOR_READERS]) {
      expect(all).toContain(file);
    }
  });

  it('exactly the three staff routes, the defining modules, the session-note read, the stopped-coming read and the on-the-floor read reach them, anywhere in the app', () => {
    expect(ALL_SOURCE.filter((file) => REACHES.test(source(file))).map(relative).sort())
      .toEqual([...STAFF_ROUTES, ...DEFINING_MODULES, ...SESSION_NOTE_READERS, ...STOPPED_COMING_READERS, ...ON_THE_FLOOR_READERS].sort());
  });

  it('the session-note route admits only coach, organization admin and the legacy admin name', () => {
    const text = source(path.join(WEB_DIR, SESSION_NOTE_READERS[0]));
    const handlers = Array.from(text.matchAll(HANDLER)).length;
    expect(handlers).toBe(1);
    expect(text).not.toMatch(/^export\s*(\{|\*)/m);
    expect(Array.from(text.matchAll(/requireRole\(\s*principal\s*,\s*\[\.\.\.SESSION_NOTE_READ_ROLES\]\s*\)/g))).toHaveLength(1);
    expect(text).toMatch(/const SESSION_NOTE_READ_ROLES = \['coach', 'organization_admin', 'admin'\] as const;/);
  });

  it('the stopped-coming route admits only coach, organization admin and the legacy admin name', () => {
    const text = source(path.join(WEB_DIR, STOPPED_COMING_READERS[0]));
    const handlers = Array.from(text.matchAll(HANDLER)).length;
    expect(handlers).toBe(1);
    expect(text).not.toMatch(/^export\s*(\{|\*)/m);
    expect(Array.from(text.matchAll(/requireRole\(\s*principal\s*,\s*\[\.\.\.STOPPED_COMING_READ_ROLES\]\s*\)/g))).toHaveLength(1);
    // Defined once, at the start of a line (not in a comment), as exactly the three staff roles.
    expect(Array.from(text.matchAll(/^const STOPPED_COMING_READ_ROLES = (.*)$/gm), (match) => match[1]))
      .toEqual(["['coach', 'organization_admin', 'admin'] as const;"]);
  });

  // The exemption for stoppedComing.ts (TABLE_FILES above) is for one read only: the gym-local day
  // of each athlete's last standing mark the register does not hold, inside lastOpenGymDays. Pinned, as the
  // idle sweep's exemption is below, because a new read added to that file would otherwise pass the
  // file-level list unnoticed: the staff notes table is never named, the presence table only in that
  // one FROM, the module's one value export is listStoppedComing, and it refuses a caller with no
  // staff membership before anything is read (Overwatch, W4-6 GO, condition 1).
  it('stoppedComing.ts reads one day per athlete from the presence table, in one place, behind the staff refusal', () => {
    const text = source(path.join(PILOT_DIR, 'stoppedComing.ts'));
    const lines = text.split('\n');
    // The staff notes table is never named, not even in a comment or inside the SQL.
    expect(text).not.toMatch(/session_staff_notes/);
    // The presence table is named on exactly two lines: one doc-comment line in the header,
    // and the one FROM, inside lastOpenGymDays. A third naming anywhere (a comment-prefixed
    // SQL line included) fails here.
    const naming = lines.filter((line) => NAMES_A_TABLE.test(line)).map((line) => line.trim());
    expect(naming).toHaveLength(2);
    expect(naming.filter((line) => line === 'from pilot.session_run_athletes m')).toHaveLength(1);
    expect(naming.filter((line) => line.startsWith('* '))).toHaveLength(1);
    const block = text.slice(text.indexOf('async function lastOpenGymDays('), text.indexOf('export async function listStoppedComing('));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('from pilot.session_run_athletes m');
    expect(block).toMatch(/select m\.athlete_id, max\(\(m\.marked_at at time zone \$4\)::date\)::text as last_day\n/);
    // Every export but a type is counted (default, re-export, indented, generator, enum alike):
    // the one there may be is listStoppedComing, which refuses first.
    const exports = Array.from(text.matchAll(/^\s*export\b(?!\s+(?:interface|type)\s).*$/gm), (match) => match[0].trim());
    expect(exports).toHaveLength(1);
    expect(exports[0].startsWith('export async function listStoppedComing(')).toBe(true);
    // And anywhere on a line: the word appears only on the two exported interfaces and that function.
    const exportLines = lines.filter((line) => /\bexport\b/.test(line)).map((line) => line.trim());
    expect(exportLines).toHaveLength(3);
    expect(exportLines.filter((line) => /^export interface \w+ \{$/.test(line))).toHaveLength(2);
    // The doc line that names the table sits in the header, before the first import.
    expect(lines.findIndex((line) => NAMES_A_TABLE.test(line) && line.trim().startsWith('* ')))
      .toBeLessThan(lines.findIndex((line) => /^import /.test(line)));
    expect(text).toMatch(
      /export async function listStoppedComing\(actor: ActorIdentity, today: string\): Promise<StoppedComingList> \{\n  if \(!\(await staffNoteRoleInOrganization\(actor\)\)\) \{\n    throw new ForbiddenError\(/,
    );
  });

  it('the on-the-floor route admits only coach, organization admin and the legacy admin name', () => {
    const text = source(path.join(WEB_DIR, ON_THE_FLOOR_READERS[0]));
    const handlers = Array.from(text.matchAll(HANDLER)).length;
    expect(handlers).toBe(1);
    expect(text).not.toMatch(/^export\s*(\{|\*)/m);
    expect(Array.from(text.matchAll(/requireRole\(\s*principal\s*,\s*\[\.\.\.ON_THE_FLOOR_READ_ROLES\]\s*\)/g))).toHaveLength(1);
    // Defined once, at the start of a line (not in a comment), as exactly the three staff roles.
    expect(Array.from(text.matchAll(/^const ON_THE_FLOOR_READ_ROLES = (.*)$/gm), (match) => match[1]))
      .toEqual(["['coach', 'organization_admin', 'admin'] as const;"]);
    // Nothing runs before the role gate: the session is resolved, then the gate is the very next
    // statement, so no branch (a family one included) can answer ahead of it.
    expect(text).toMatch(
      /export async function GET\(request: NextRequest\) \{\n  try \{\n    const principal = await requirePrincipal\(request\);\n    requireRole\(principal, \[\.\.\.ON_THE_FLOOR_READ_ROLES\]\);\n/,
    );
    // The route reaches the presence record through its own module's read only: no other pinned read
    // (isSessionRunningForAthleteToday, which FN-0 F13 rules out for this line, included).
    const reached = new Set(Array.from(text.matchAll(new RegExp(REACHES.source, 'g')), (match) => match[0]));
    expect([...reached]).toEqual(['listOnTheFloorForStaff']);
    // The read is asked for the current moment: that moment also drives the idle close, which writes.
    expect(Array.from(text.matchAll(/listOnTheFloorForStaff\(([^)]*\)?)\)/g), (match) => match[1])).toEqual(['principal, new Date()']);
  });

  // The exemption for onTheFloor.ts (TABLE_FILES above) is for one read only: which athletes stand
  // marked on a live run, inside markedOnLiveRuns. Pinned as the stopped-coming read is, because a
  // new read added to that file would otherwise pass the file-level list unnoticed: the staff notes
  // table is never named, the presence table only in that one FROM, the module's one value export is
  // listOnTheFloorForStaff, and it refuses a caller with no staff membership before anything is read.
  it('onTheFloor.ts reads ids of standing marks on live runs, in one place, behind the staff refusal', () => {
    const text = source(path.join(PILOT_DIR, 'onTheFloor.ts'));
    const lines = text.split('\n');
    expect(text).not.toMatch(/session_staff_notes/);
    // Named on exactly two lines: one doc-comment line in the header, and the one FROM.
    const naming = lines.filter((line) => NAMES_A_TABLE.test(line)).map((line) => line.trim());
    expect(naming).toHaveLength(2);
    expect(naming.filter((line) => line === 'from pilot.session_run_athletes m')).toHaveLength(1);
    expect(naming.filter((line) => line.startsWith('* '))).toHaveLength(1);
    const block = text.slice(text.indexOf('async function markedOnLiveRuns('), text.indexOf('async function presentOnTodaysRegister('));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('from pilot.session_run_athletes m');
    // The one thing selected from it: the athlete id, once each.
    expect(block).toMatch(/`select distinct m\.athlete_id\n/);
    // Every export but a type is counted: the one there may be is listOnTheFloorForStaff, which refuses first.
    const exports = Array.from(text.matchAll(/^\s*export\b(?!\s+(?:interface|type)\s).*$/gm), (match) => match[0].trim());
    expect(exports).toHaveLength(1);
    expect(exports[0].startsWith('export async function listOnTheFloorForStaff(')).toBe(true);
    const exportLines = lines.filter((line) => /\bexport\b/.test(line)).map((line) => line.trim());
    expect(exportLines).toHaveLength(3);
    expect(exportLines.filter((line) => /^export interface \w+ \{$/.test(line))).toHaveLength(2);
    expect(lines.findIndex((line) => NAMES_A_TABLE.test(line) && line.trim().startsWith('* ')))
      .toBeLessThan(lines.findIndex((line) => /^import /.test(line)));
    expect(text).toMatch(
      /export async function listOnTheFloorForStaff\(actor: ActorIdentity, now: Date\): Promise<OnTheFloorStaffLine> \{\n  if \(!\(await staffNoteRoleInOrganization\(actor\)\)\) \{\n    throw new ForbiddenError\(/,
    );
    // Only the two ruled sources (FN-0 F9): no other pinned read, and no other attendance or
    // check-in record, named anywhere in the file.
    const reached = new Set(Array.from(text.matchAll(new RegExp(REACHES.source, 'g')), (match) => match[0]));
    expect([...reached]).toEqual(['listOnTheFloorForStaff']);
    expect(text).not.toMatch(/\b(attendance_reconciled|activity_log|athlete_check_ins)\b|pilot\.attendance(?![\w_])/);
    // Nor through an import: these seven, and nothing loaded any other way. A new source brought in by
    // a helper from another module (a wellness check-in, the reconciled view) fails here.
    expect(Array.from(text.matchAll(/^import .*$/gm), (match) => match[0])).toEqual([
      "import { GYM_TIME_ZONE, gymDayIso } from '../../lib/gymTime';",
      "import type { ActorIdentity } from './access';",
      "import { organizationActionableRoster } from './coachAthleteRoster';",
      "import { query } from './db';",
      "import { ForbiddenError } from './errors';",
      "import { closeIdleSessionRuns } from './sessionScriptRuns';",
      "import { staffNoteRoleInOrganization } from './sessionStaffNotes';",
    ]);
    expect(text).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
  });

  it('no route, page, component or other module names either table in its own text', () => {
    expect(ALL_SOURCE.filter((file) => NAMES_A_TABLE.test(source(file))).map(relative).sort()).toEqual(TABLE_FILES);
  });

  it('no route under an athlete, parent, guardian, family, board, public, platform, wall, kiosk or tv path reaches them', () => {
    // tv: the paired gym TV keeps "showing only who is present, by initials" (OD-2026-10-17-008
    // ruling 1); FN-0 F1 asks for it here (lane W4-3, FN-1).
    const audience = /\/api\/(pilot\/)?(athlete|parent|guardian|family|board|public|platform|wall|kiosk|tv)\b/;
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

  it('the behaviour writer and the window module are imported only by the staff behaviour routes and two server modules', () => {
    const all = ALL_SOURCE.map(relative);
    for (const file of [...WRITER_ROUTES, ...WRITER_MODULES]) expect(all).toContain(file);
    expect(ALL_SOURCE.filter((file) => WRITER_IMPORT.test(source(file))).map(relative).sort())
      .toEqual([...WRITER_ROUTES, ...WRITER_MODULES].sort());
  });

  it.each(WRITER_ROUTES)('%s admits only coach, organization admin and the legacy admin name, on every handler', (route) => {
    const text = source(path.join(WEB_DIR, route));
    expect(text).not.toMatch(/^export\s*(\{|\*)/m);
    // Each handler's own text, from its export to the next handler's, holds exactly one role gate.
    const starts = Array.from(text.matchAll(HANDLER), (match) => match.index ?? 0);
    expect(starts.length).toBeGreaterThan(0);
    const gates = starts.map((start, index) => {
      const body = text.slice(start, starts[index + 1] ?? text.length);
      const found = Array.from(body.matchAll(/requireRole\(\s*principal\s*,\s*\[\.\.\.([A-Z_]+)\]\s*\)/g), (match) => match[1]);
      expect(found).toHaveLength(1);
      return found[0];
    });
    // Each gate's list is defined once, at the start of a line (not in a comment), as exactly the three staff roles.
    for (const gate of new Set(gates)) {
      expect(Array.from(text.matchAll(new RegExp(`^const ${gate} = (.*)$`, 'gm')), (match) => match[1]))
        .toEqual(["['coach', 'organization_admin', 'admin'] as const;"]);
    }
  });

  it('STAFF_NOTE_ROLES is the three staff roles and nothing else', () => {
    expect(source(path.join(PILOT_DIR, 'sessionStaffNotes.ts')))
      .toMatch(/export const STAFF_NOTE_ROLES = \['coach', 'organization_admin', 'admin'\] as const;/);
  });

  // The exemption for sessionScriptRuns.ts (TABLE_FILES above) is for one use only: a timestamp per
  // run, inside the idle sweep's SQL, that never leaves the statement. Pinned, because a new read
  // added to that file would otherwise pass the file-level list unnoticed.
  it('sessionScriptRuns.ts names either table only inside the idle sweep, which returns nothing from them', () => {
    const text = source(path.join(PILOT_DIR, 'sessionScriptRuns.ts'));
    const block = text.slice(text.indexOf('function lastActivitySql('), text.indexOf('export async function closeIdleSessionRuns('));
    expect(block.length).toBeGreaterThan(0);
    // Outside it: comments, and the existence check (to_regclass reads the catalog, not the rows).
    const outside = text.replace(block, '').split('\n').filter((line) => NAMES_A_TABLE.test(line)
      && !/^\s*\/\//.test(line)
      && !/to_regclass\('pilot\.session_(run_athletes|staff_notes)'\)/.test(line));
    expect(outside).toEqual([]);
    // Inside it: exactly two subqueries, each yielding one timestamp.
    const reads = block.split('\n').filter((line) => NAMES_A_TABLE.test(line));
    expect(reads).toHaveLength(2);
    for (const line of reads) {
      expect(line.trim()).toMatch(
        /^signals\.push\(`\(select max\(greatest\([a-z]\.(marked_at|created_at), [a-z]\.(removed_at|updated_at)\)\) from pilot\.session_(run_athletes|staff_notes) [a-z]$/,
      );
    }
    const sweep = text.slice(text.indexOf('export async function closeIdleSessionRuns('), text.indexOf('// The resume lookup.'));
    expect(sweep).toMatch(/returning r\.run_id`/);
    expect(sweep).toMatch(/export async function sweepIdleRuns\(organizationId: string\): Promise<void>/);
  });

  it('no component or page imports a value from a server module that reads them', () => {
    const client = ALL_SOURCE.filter((file) => /\.tsx$/.test(file) && !/^src\//.test(relative(file)));
    expect(client.length).toBeGreaterThan(50);
    // A type-only import is erased at build time and carries no data; a value import would not be.
    const valueImport = /^import (?!type\b)[^;]*from ['"]@\/src\/server\/pilot\/(sessionRunAthletes|sessionStaffNotes|sessionScriptRuns|sessionRunClass)['"];/m;
    expect(client.filter((file) => valueImport.test(source(file))).map(relative)).toEqual([]);
  });
});
