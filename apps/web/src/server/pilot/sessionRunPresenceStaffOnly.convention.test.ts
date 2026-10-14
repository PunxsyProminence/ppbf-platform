// Convention gate for audit finding F-067: who was in a session, and a staff
// note on an athlete in a session run, are STAFF ONLY. No athlete, parent,
// board, platform-owner or public route may reach them (OD-2026-10-10-003 items
// 3 and 4; OD-2026-10-11-007).
//
// The role gates themselves are exercised in the three routes' own suites, and
// the reads' filters on real rows in sessionRunAthletes.pg.test.ts. What this
// file adds is the sweep those cannot make: it reads every route under app/api
// and every module under src/server/pilot from disk, so a NEW route or module
// that starts reading these records fails here until someone decides, on
// purpose, that it may.
//
// It is a source check and says so: it proves which files name these records,
// not what any of them returns.

import fs from 'node:fs';
import path from 'node:path';

const WEB_DIR = path.resolve(__dirname, '../../..');
const API_DIR = path.join(WEB_DIR, 'app', 'api');
const PILOT_DIR = __dirname;

function filesUnder(dir: string, keep: (file: string) => boolean): string[] {
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

/** What reaches the records: the presence module, the run-note functions, the finished-sessions read. */
const REACHES = /sessionRunAthletes'|\b(listRunStaffNotes|createRunStaffNote|listSettledRunsForOrganization)\b/;

// The only routes that may. Each is gated to coach, organization_admin and admin.
const STAFF_ROUTES = [
  'app/api/pilot/coach/session-staff-notes/route.ts',
  'app/api/pilot/session-scripts/runs/[runId]/athletes/route.ts',
  'app/api/pilot/session-scripts/runs/route.ts',
];

// The only modules that may name the table. privacyTiers.ts names it to forbid it on public surfaces.
const TABLE_MODULES = ['privacyTiers.ts', 'sessionRunAthletes.ts', 'sessionStaffNotes.ts'];

describe('who was in a session, and notes on a run, are reached only from staff routes', () => {
  const routes = filesUnder(API_DIR, (file) => /route\.tsx?$/.test(file));

  it('the sweep reads the routes it claims to (it has not gone blind)', () => {
    expect(routes.length).toBeGreaterThan(100);
    for (const route of STAFF_ROUTES) {
      expect(routes.map(relative)).toContain(route);
    }
  });

  it('exactly the three staff routes import the presence module or the run-note and finished-session reads', () => {
    expect(routes.filter((file) => REACHES.test(source(file))).map(relative).sort()).toEqual(STAFF_ROUTES);
  });

  it('no route under an athlete, parent, guardian, family, board, public or platform path reaches them', () => {
    const audience = /\/api\/(pilot\/)?(athlete|parent|guardian|family|board|public|platform|wall|kiosk)\b/;
    const reaching = routes.map(relative).filter((file) => audience.test(`/${file.replace(/^app/, '')}`.replace('//', '/')));
    expect(reaching.length).toBeGreaterThan(0);
    for (const file of reaching) {
      expect({ file, reaches: REACHES.test(source(path.join(WEB_DIR, file))) }).toEqual({ file, reaches: false });
    }
  });

  it.each(STAFF_ROUTES)('%s admits only coach, organization admin and the legacy admin name', (route) => {
    const text = source(path.join(WEB_DIR, route));
    const gates = Array.from(text.matchAll(/requireRole\(\s*principal\s*,\s*\[\.\.\.([A-Z_]+)\]\s*\)/g), (match) => match[1]);
    // Every handler in the file is gated, and by one of the two staff lists.
    const handlers = Array.from(text.matchAll(/export async function (GET|POST|PATCH|DELETE)\b/g)).length;
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

  it('only the presence module, the notes module and the privacy map name the table', () => {
    const modules = filesUnder(PILOT_DIR, (file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file));
    const naming = modules.filter((file) => /session_run_athletes/.test(source(file))).map((file) => path.basename(file)).sort();
    expect(naming).toEqual(TABLE_MODULES);
  });

  it('no component or page under app/ or components/ names the table or imports a server module that reads it', () => {
    const client = [
      ...filesUnder(path.join(WEB_DIR, 'app'), (file) => /\.tsx$/.test(file) && !/\.test\.tsx$/.test(file)),
      ...filesUnder(path.join(WEB_DIR, 'components'), (file) => /\.tsx$/.test(file) && !/\.test\.tsx$/.test(file)),
    ];
    expect(client.length).toBeGreaterThan(50);
    // A type-only import is erased at build time and carries no data; a value import would not be.
    const valueImport = /^import (?!type\b)[^;]*from '@\/src\/server\/pilot\/(sessionRunAthletes|sessionStaffNotes)';/m;
    const offending = client.filter((file) => /session_run_athletes/.test(source(file)) || valueImport.test(source(file))).map(relative);
    expect(offending).toEqual([]);
  });
});
