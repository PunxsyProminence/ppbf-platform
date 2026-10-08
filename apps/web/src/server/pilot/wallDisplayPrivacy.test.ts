import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A source-level guard on the wall display.
 *
 * wallDisplay.test.ts checks the payload that comes out of buildWallBoard, and
 * that is the stronger test -- but it can only see the fields the code puts
 * there today. This one watches the READS, because the way this screen goes
 * wrong is not somebody shipping a readiness score on purpose. It is somebody
 * six months from now adding `select ... , r.score` to make the floor list
 * "more useful", and the payload test passing because they also added the field
 * to the expected shape.
 *
 * So: the tables and columns that must never be joined into a wall board, named
 * out loud, checked against the files that do the reading. A test that fails
 * with "wallDisplayDb.ts mentions pilot.readiness" is a conversation; a code
 * review that has to notice a join is not.
 */

const HERE = __dirname;
const READ_MODULES = [
  path.join(HERE, 'wallDisplay.ts'),
  path.join(HERE, 'wallDisplayDb.ts'),
];

// The denylists live in privacyTiers.ts (capability #200) so the same
// field-level rules govern every public surface from one registry. This
// test keeps the teeth; the registry keeps the list.
import { PUBLIC_SURFACE_FORBIDDEN_COLUMNS, PUBLIC_SURFACE_FORBIDDEN_TABLES } from './privacyTiers';

const FORBIDDEN_TABLES = PUBLIC_SURFACE_FORBIDDEN_TABLES;
const FORBIDDEN_COLUMNS = PUBLIC_SURFACE_FORBIDDEN_COLUMNS;

function sqlOf(source: string): string {
  // Only the query text, so a column named in a comment (this file's own
  // subject matter appears in prose in both modules) is not a failure.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .toLowerCase();
}

describe('the wall display reads nothing it must not', () => {
  const sources = READ_MODULES.map((file) => ({ file: path.basename(file), sql: sqlOf(readFileSync(file, 'utf8')) }));

  it.each(FORBIDDEN_TABLES)('never queries %s', (table) => {
    for (const { file, sql } of sources) {
      expect({ file, mentions: sql.includes(table) }).toEqual({ file, mentions: false });
    }
  });

  it.each(FORBIDDEN_COLUMNS)('never selects %s', (column) => {
    for (const { file, sql } of sources) {
      expect({ file, mentions: sql.includes(column) }).toEqual({ file, mentions: false });
    }
  });

  it('reads attendance only for people who are present', () => {
    // 'absent' and 'excused' are the other two values in the check constraint.
    // A public record of who did not turn up is exactly the thing a wall must
    // not become, so the filter is pinned here rather than left to review.
    const db = sqlOf(readFileSync(path.join(HERE, 'wallDisplayDb.ts'), 'utf8'));
    expect(db).toContain("status = 'present'");
    expect(db).not.toContain("'absent'");
    expect(db).not.toContain("'excused'");
  });

  it('issues no DDL, like every other read path in this app', () => {
    const ddl = /\b(create|alter|drop|truncate)\s+(table|schema|index|extension|view|type|sequence)\b/i;
    for (const file of READ_MODULES) {
      expect({ file: path.basename(file), ddl: ddl.test(readFileSync(file, 'utf8')) }).toEqual({
        file: path.basename(file),
        ddl: false,
      });
    }
  });

  it('never lets the caller choose the organization', () => {
    // The public announcements route learned this the hard way (see its own
    // header comment). An unauthenticated endpoint that accepts an org id is a
    // way to read another gym's children.
    const route = readFileSync(path.join(HERE, '../../../app/api/pilot/wall/route.ts'), 'utf8');
    expect(route).toContain('getPilotDefaultOrganizationId()');
    expect(route).not.toMatch(/searchParams|request\.json\(\)|params\./);
  });

  it('never returns a raw athlete id to an unauthenticated caller', () => {
    // The payload carries wallKey() instead: an id list is a roster even when
    // the names beside it are initials.
    const board = readFileSync(path.join(HERE, 'wallDisplay.ts'), 'utf8');
    const shape = board.slice(board.indexOf('export interface WallPerson'), board.indexOf('export interface WallBoard'));
    expect(shape).not.toMatch(/athlete_id/);
  });
});

/* OD-2026-10-07-008 (Jason, question card 1, "Paired gym TV only"): the public
   address shows today's classes and a head count only; initials and milestones
   go only to a TV paired with a code. The public half of that ruling lives in
   loadPublicWallBoard / buildPublicWallBoard / WallPublicBoard, and these tests
   read THOSE by name out of the two modules, so a join or a field added to the
   public path fails here and not in review. Mutation proof for the PR: put
   `placement = 'everywhere'` or a pilot.athletes join into loadPublicWallBoard
   and the matching case below goes red. */
describe('the public board (unpaired television) carries no person', () => {
  const db = readFileSync(path.join(HERE, 'wallDisplayDb.ts'), 'utf8');
  const pure = readFileSync(path.join(HERE, 'wallDisplay.ts'), 'utf8');

  /** The text of one top-level export, from its signature to the next export. */
  function exportedBlock(source: string, name: string): string {
    const start = source.indexOf(name);
    expect({ name, found: start >= 0 }).toEqual({ name, found: true });
    const rest = source.slice(start + name.length);
    const next = rest.search(/\n(?:export |\/\*\*)/);
    return name + (next >= 0 ? rest.slice(0, next) : rest);
  }

  /** Code only, case kept: the prose around these blocks names the very things they must not read. */
  const codeOf = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  // Anchors carry the character after the name, so WallPublicBoard cannot
  // match the prefix of WallPublicBoardSources whichever is declared first.
  const loader = sqlOf(exportedBlock(db, 'export async function loadPublicWallBoard('));
  const builder = codeOf(exportedBlock(pure, 'export function buildPublicWallBoard('));
  const shape = codeOf(exportedBlock(pure, 'export interface WallPublicBoard {'));
  const sources = codeOf(exportedBlock(pure, 'export interface WallPublicBoardSources {'));

  it.each(['pilot.athletes', 'pilot.waivers', 'pilot.sessions', 'full_name', 'dob', 'signed_by_role', 'waiver_type'])(
    'the public loader never reads %s',
    (needle) => {
      expect({ needle, mentions: loader.includes(needle) }).toEqual({ needle, mentions: false });
    },
  );

  it('the public loader reads gym_notices only, never everywhere', () => {
    expect(loader).toContain("placement = 'gym_notices'");
    expect(loader).not.toContain('everywhere');
  });

  it('the public loader counts people in SQL and never selects an athlete id as a column', () => {
    // count(distinct athlete_id) is the only spelling allowed: the id is
    // consumed inside the aggregate and never crosses the wire.
    const bare = loader.replace(/count\(distinct athlete_id\)/g, '');
    expect(bare).not.toContain('athlete_id');
    expect(loader).toContain("status = 'present'");
  });

  it('the public loader never calls the paired builder', () => {
    expect(loader).toContain('buildpublicwallboard(');
    expect(loader).not.toContain('buildwallboard(');
  });

  it.each(['on_floor:', 'marquee', 'name_mode', 'WallPerson', 'WallMilestone', 'visibility'])(
    'the public shape has no %s field',
    (field) => {
      expect({ field, present: shape.includes(field) }).toEqual({ field, present: false });
    },
  );

  it('the public shape is discriminated so the television cannot mistake it for the paired board', () => {
    expect(shape).toContain("readonly scope: 'public'");
  });

  it('the public builder is never handed an athlete, a waiver or a crossing', () => {
    for (const needle of ['WallAthleteRow', 'WallWaiverRow', 'WallCrossingRow', 'WallAttendanceRow', 'athlete']) {
      expect({ needle, inSources: sources.includes(needle) }).toEqual({ needle, inSources: false });
    }
    for (const needle of ['renderWallName', 'resolveDisplayVisibility', 'wallKey', 'selectMarquee', 'athlete']) {
      expect({ needle, inBuilder: builder.includes(needle) }).toEqual({ needle, inBuilder: false });
    }
  });

  it('the public route reads the public loader and never the paired one', () => {
    const route = readFileSync(path.join(HERE, '../../../app/api/pilot/wall/route.ts'), 'utf8');
    const code = sqlOf(route);
    expect(code).toContain('loadpublicwallboard(');
    expect(code).not.toContain('loadwallboard(');
    expect(code).not.toContain('getwalldisplaynamemode');
    // The import itself, literally: an alias (`loadWallBoard as loadPublicWallBoard`)
    // would satisfy the call-site checks above and serve the paired board.
    expect(route).toContain("import { loadPublicWallBoard } from '@/src/server/pilot/wallDisplayDb';");
    expect(route).not.toMatch(/loadWallBoard/);
  });

  it('the paired board is served only behind the device-cookie gate', () => {
    // The one caller of loadWallBoard outside tests is gymTvs.ts readGymTvScreen,
    // reached only after resolveGymTvByDeviceKey returned a paired TV.
    const tvs = sqlOf(readFileSync(path.join(HERE, 'gymTvs.ts'), 'utf8'));
    const screen = tvs.slice(tvs.indexOf('export async function readgymtvscreen'), tvs.indexOf('async function readsessionfortv'));
    expect(screen).toContain('resolvegymtvbydevicekey(devicekey)');
    expect(screen).toContain('if (!tv) return null;');
    expect(screen).toContain('loadwallboard({ organizationid: tv.organization_id');
    expect(screen).not.toMatch(/organizationid: (?:input|options|request|params)\./);
  });
});
