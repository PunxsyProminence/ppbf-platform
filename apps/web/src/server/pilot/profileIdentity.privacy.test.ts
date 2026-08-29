import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A SOURCE-LEVEL GUARD ON THE IDENTITY LAYER.
 *
 * profileVisibility.test.ts checks the decisions, and that is the stronger
 * test -- but it can only see the fields the code produces today. This one
 * watches the READS and the PLACEMENT, because the way a feature like this goes
 * wrong is not somebody shipping a child's medical state next to their
 * photograph on purpose. It is somebody six months from now joining
 * pilot.readiness into the roster query to make it "more useful", or dropping a
 * corner tint onto the clearance screen because the screen looked plain.
 *
 * So: the tables that must never be joined into an identity read, and the files
 * that are allowed to carry a corner, named out loud and checked. A test that
 * fails with "profileDb.ts mentions pilot.medical_intake" is a conversation; a
 * code review that has to notice a join is not.
 *
 * This is the same instrument wallDisplayPrivacy.test.ts points at the wall.
 */

const SERVER_DIR = __dirname;
const IDENTITY_MODULES = [
  'profileIdentity.ts',
  'profileVisibility.ts',
  'profileDb.ts',
  'profilePhotoPolicy.ts',
].map((name) => path.join(SERVER_DIR, name));

const ROUTE_DIR = path.resolve(SERVER_DIR, '../../../app/api/pilot/profile');

/** Everything on this list is a health, safety, clinical or conduct record. */
const FORBIDDEN_TABLES = [
  'pilot.readiness',
  'pilot.medical_intake',
  'pilot.coach_observations',
  'pilot.assessments',
  'pilot.emergency_contacts',
  'pilot.shadow_medical',
  'pilot.shadow_near_misses',
  'pilot.waivers',
  'pilot.documents',
  'pilot.intake_documents',
];

/**
 * Columns that exist on tables the identity layer DOES read, and must not be
 * selected from them. weight_class and gym_status are records about a person's
 * body and standing; emergency_contact and pin_hash have no business anywhere
 * near a card.
 */
const FORBIDDEN_COLUMNS = [
  'weight_class',
  'gym_status',
  'emergency_contact',
  'clearance_status',
  'pin_hash',
  'injury',
];

function codeOf(source: string): string {
  // Comments only discuss this file's own subject matter in prose -- "no
  // clearance, no injury" appears in several of them by design. Strip them so a
  // word in a comment is not a failure.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .toLowerCase();
}

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    // Routes only. A .test.ts sitting beside a route is not one, and the
    // sweeps below read it as one in two ways that both mislead: the audit
    // check demands a `details: {` literal that a test written with
    // toEqual does not have, and the label it reports is derived from the
    // DIRECTORY -- so a failure in clear/route.test.ts is printed as
    // "clear/route.ts", pointing at a file that is fine. This has been
    // latent since roster/route.test.ts landed; that file passed only
    // because it happens not to mention writePilotAuditEvent.
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('the identity layer reads nothing it must not', () => {
  const sources = [...IDENTITY_MODULES, ...routeFiles(ROUTE_DIR)].map((file) => ({
    file: path.relative(path.resolve(SERVER_DIR, '../../..'), file),
    code: codeOf(readFileSync(file, 'utf8')),
  }));

  it('found the modules it means to check', () => {
    // Guards the guard: a rename that emptied this list would make every
    // assertion below vacuous.
    expect(sources.length).toBeGreaterThanOrEqual(9);
  });

  it.each(FORBIDDEN_TABLES)('never queries %s', (table) => {
    for (const { file, code } of sources) {
      expect({ file, mentions: code.includes(table) }).toEqual({ file, mentions: false });
    }
  });

  it.each(FORBIDDEN_COLUMNS)('never selects %s', (column) => {
    for (const { file, code } of sources) {
      expect({ file, mentions: code.includes(column) }).toEqual({ file, mentions: false });
    }
  });
});

describe('a ring name never reaches the audit log', () => {
  /* The takedown route removes a string somebody objected to. Writing that
     string into pilot.audit_events would republish it -- to a wider audience,
     permanently, past the visibility gate the whole feature is built on. The
     audit records that a clear happened and who did it, and nothing more. */
  const auditingRoutes = routeFiles(ROUTE_DIR).filter((file) => {
    const source = readFileSync(file, 'utf8');
    return source.includes('writePilotAuditEvent');
  });

  it('finds the routes that audit', () => {
    expect(auditingRoutes.length).toBeGreaterThanOrEqual(3);
  });

  it.each(auditingRoutes.map((f) => [path.basename(path.dirname(f)) + '/route.ts', f]))(
    '%s writes no nickname value into its audit details',
    (_label, file) => {
      const source = readFileSync(file as string, 'utf8');
      const details = [...source.matchAll(/details:\s*\{([^}]*)\}/g)].map((m) => m[1]);
      expect(details.length).toBeGreaterThan(0);
      for (const block of details) {
        // Field NAMES are fine ("fields: changed"). A value is not.
        expect(block).not.toMatch(/nickname:\s*(validation|profile|body|raw|value)/);
        expect(block).not.toMatch(/display_nickname:/);
        expect(block).not.toMatch(/ring_name:/);
      }
    },
  );

  it('never mirrors an identity change into the SHADOW event stream', () => {
    // shadow_mirror defaults to ON. A child's identity changes belong in the
    // audit table and nowhere else -- SHADOW's event stream feeds a model.
    for (const file of auditingRoutes) {
      const source = readFileSync(file, 'utf8');
      // Calls, not mentions -- the import line names the function too.
      const auditCalls = source.split('writePilotAuditEvent({').length - 1;
      const suppressions = source.split('shadow_mirror: false').length - 1;
      expect({ file: path.basename(path.dirname(file)), auditCalls, suppressions })
        .toEqual({ file: path.basename(path.dirname(file)), auditCalls, suppressions: auditCalls });
    }
  });
});

describe('the corner never lands on a surface that carries a safety state', () => {
  /**
   * A corner is decoration on a person's OWN space. Applied anywhere else it
   * sits inches from a readiness dot or a clearance badge, which is exactly
   * where a personal preference starts being read as a status.
   *
   * The mechanism is `data-corner` on a `.corner-scope`, so the allow-list is a
   * list of files. Adding a corner to a medical, clearance or roster surface
   * fails here.
   */
  const CLIENT_DIRS = [
    path.resolve(SERVER_DIR, '../../../components'),
    path.resolve(SERVER_DIR, '../../../app'),
  ];

  const ALLOWED = new Set([
    // The member's own card, and the plate that is part of it.
    'components/FightCard.tsx',
    'components/ProfilePortrait.tsx',
    // The member's own settings screen, and the header on their own workspace.
    'components/ProfileSettings.tsx',
    'components/ProfileHeader.tsx',
  ]);

  function tsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsxFiles(full));
      else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('is applied only in the files allowed to apply it', () => {
    const root = path.resolve(SERVER_DIR, '../../..');
    const offenders: string[] = [];
    for (const dir of CLIENT_DIRS) {
      for (const file of tsxFiles(dir)) {
        const relative = path.relative(root, file).replace(/\\/g, '/');
        if (relative.endsWith('.test.ts') || relative.endsWith('.test.tsx')) continue;
        const source = readFileSync(file, 'utf8');
        if (!/data-corner|--corner-/.test(source)) continue;
        if (!ALLOWED.has(relative)) offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the allow-list is not stale -- every file on it still applies a corner', () => {
    const root = path.resolve(SERVER_DIR, '../../..');
    for (const relative of ALLOWED) {
      const source = readFileSync(path.join(root, relative), 'utf8');
      expect({ relative, applies: /data-corner|--corner-/.test(source) })
        .toEqual({ relative, applies: true });
    }
  });

  it('the coach roster shows faces and names, and no corner at all', () => {
    const roster = readFileSync(
      path.resolve(SERVER_DIR, '../../../components/CoachWorkspace.tsx'),
      'utf8',
    );
    expect(roster).toContain('ProfilePortrait');
    expect(roster).not.toMatch(/data-corner=/);
  });
});
