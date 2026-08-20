import fs from 'node:fs';
import path from 'node:path';

import { BUILDING, ROOM_ORDER, type Room } from './buildingMap';
import { isFamilyGround } from './roleGround';
import type { ClubRole } from './roleRoutes';

/**
 * THE MAP AND THE WALL MUST AGREE.
 *
 * Every surface carries its room twice, and until this file the two were never
 * compared:
 *
 *   (a) `buildingMap.ts` puts a `room:` on each door. That is what the corridor
 *       and the card catalog file the surface under -- "Gym Floor", "Clinic".
 *   (b) The page paints its own `.room--*` class, or passes `room=` to the
 *       RoleStandaloneView shell. That is the wall, the light and the floor
 *       shadow the person actually sees.
 *
 * buildingMapCoverage.test.ts checks that a route HAS a door; designSystemClasses
 * .test.ts checks the six room rules exist in the sheet. Neither notices when a
 * door files a page under one room and the page paints another, so drift is
 * silent by construction: the catalog says Front Office, the wall says clinic
 * green, and nothing is red. Fourteen routes had drifted that way when this
 * file was written.
 *
 * The comparison is static rather than rendered. Rendering 106 routes would
 * need a session, a fetch mock and a DOM per page; the room is a literal in the
 * source in every case, so reading it is both cheaper and harder to fool -- and
 * a test that costs a second is a test that keeps running.
 */

const WEB_DIR = path.resolve(__dirname, '..');
const APP_DIR = path.join(WEB_DIR, 'app');

const ROOMS = new Set<string>(ROOM_ORDER);

/**
 * `room--lit-center` is a LIGHT, not a room: it hangs a lamp in the middle of
 * whatever room it is on (ppbf.css, .room--lit-center::before). It shares the
 * prefix and nothing else, so it is named here rather than pattern-matched
 * away -- a modifier nobody listed would otherwise be read as a seventh room.
 */
const ROOM_MODIFIERS = new Set(['lit-center']);

/**
 * Shells that carry the `room` prop rather than declaring a room of their own.
 * RoleStandaloneView renders `room--${room}` from a template literal, so
 * following a page into it would find a room-shaped string on every page that
 * wraps in it. The prop is read at the call site, which is the page.
 */
const SHELL_MODULES = new Set(['RoleStandaloneView', 'RoleSessionGate', 'BoardRoleGate']);

/* ---------------------------------------------------------------- reading -- */

type Resolution =
  | { kind: 'room'; room: Room }
  | { kind: 'canvas' }
  | { kind: 'none' }
  | { kind: 'ambiguous'; rooms: string[] };

function readSource(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Every room this source paints, as a class or as a `room=` prop. */
function roomsDeclaredIn(source: string): Set<string> {
  const found = new Set<string>();

  // `.room--office`, including inside a longer className string.
  for (const match of source.matchAll(/room--([a-z][a-z0-9-]*)/g)) {
    if (!ROOM_MODIFIERS.has(match[1])) found.add(match[1]);
  }
  // room="clinic" / room='clinic' / room={'clinic'}
  for (const match of source.matchAll(/\broom=\{?["']([a-z]+)["']\}?/g)) {
    found.add(match[1]);
  }
  return found;
}

/**
 * The roles a page hands its RoleStandaloneView, so the family/canvas branch
 * can be read the same way the component reads it. Returns one entry per
 * `allowedRoles={[...]}` in the file: a page with several branches states the
 * list several times.
 */
function allowedRoleLists(source: string): ClubRole[][] {
  return [...source.matchAll(/allowedRoles=\{\[([^\]]*)\]\}/g)].map((match) =>
    match[1]
      .split(',')
      .map((role) => role.trim().replace(/['"]/g, ''))
      .filter(Boolean) as ClubRole[],
  );
}

/**
 * RoleStandaloneView drops the room on its family branch:
 *
 *     familyGround ? '' : (room ? `room--${room}` : '')
 *
 * and the reason is in the component -- .room--* paints a background image that
 * would beat the .on-canvas ground and put a dark plank wall behind
 * canvas-coloured text. So a parent-facing route renders NO room however the
 * map files it, and that is correct rather than drift. This models the branch
 * instead of flagging it.
 */
function rendersOnCanvas(source: string): boolean {
  if (!/<RoleStandaloneView/.test(source)) return false;
  const lists = allowedRoleLists(source);
  if (lists.length === 0) return false;
  return lists.every((roles) => isFamilyGround(roles));
}

/** Resolve an import specifier the way tsconfig/jest do: "@/x" is src/x then x. */
function resolveModule(spec: string, fromFile: string): string | null {
  const candidates: string[] = [];
  if (spec.startsWith('@/')) {
    candidates.push(path.join(WEB_DIR, 'src', spec.slice(2)), path.join(WEB_DIR, spec.slice(2)));
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    candidates.push(path.resolve(path.dirname(fromFile), spec));
  } else {
    return null; // a package, not ours
  }

  for (const base of candidates) {
    for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
      if (fs.existsSync(base + ext)) return base + ext;
    }
  }
  return null;
}

/**
 * The rooms a page paints, following the components it renders.
 *
 * A page routinely holds nothing but a gate and a component -- /names is
 * RoleSessionGate around WallOfNames, and the room is in WallOfNames -- so
 * stopping at page.tsx would read most of the building as roomless. Only
 * imports that actually appear as `<Name` in the JSX are followed, and only
 * until a room is found: a component that paints one is the room, and its own
 * children cannot be in a different one.
 */
function roomsFromModule(file: string, depth: number, seen: Set<string>): Set<string> {
  if (depth < 0 || seen.has(file)) return new Set();
  seen.add(file);

  const source = readSource(file);
  const own = roomsDeclaredIn(source);
  if (own.size > 0) return own;

  const found = new Set<string>();
  for (const match of source.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (/^import\s+type\s/.test(match[0])) continue;
    const names = [...match[1].matchAll(/([A-Z]\w+)/g)].map((m) => m[1]);
    if (names.length === 0) continue;
    if (names.some((name) => SHELL_MODULES.has(name))) continue;
    // Imported but never rendered means it is data or a type, not a wall.
    if (!names.some((name) => new RegExp(`<${name}[\\s/>]`).test(source))) continue;

    const target = resolveModule(match[2], file);
    if (!target) continue;
    for (const room of roomsFromModule(target, depth - 1, seen)) found.add(room);
  }
  return found;
}

/** Rooms painted by the layouts a route passes through (/wall's is one). */
function roomsFromLayouts(href: string): Set<string> {
  const found = new Set<string>();
  let dir = APP_DIR;
  for (const segment of ['', ...href.split('/').filter(Boolean)]) {
    dir = segment ? path.join(dir, segment) : dir;
    const layout = path.join(dir, 'layout.tsx');
    if (fs.existsSync(layout)) {
      for (const room of roomsDeclaredIn(readSource(layout))) found.add(room);
    }
  }
  return found;
}

function pageFileFor(href: string): string | null {
  const dir = path.join(APP_DIR, href === '/' ? '' : href);
  for (const name of ['page.tsx', 'page.ts']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** What room a person standing on this route is actually looking at. */
function renderedRoom(href: string): Resolution {
  const page = pageFileFor(href);
  if (!page) return { kind: 'none' };

  const source = readSource(page);
  if (rendersOnCanvas(source)) return { kind: 'canvas' };

  const found = new Set([
    ...roomsFromLayouts(href),
    ...roomsFromModule(page, 3, new Set()),
  ]);

  if (found.size === 0) return { kind: 'none' };
  if (found.size > 1) return { kind: 'ambiguous', rooms: [...found].sort() };
  const [only] = [...found];
  if (!ROOMS.has(only)) return { kind: 'ambiguous', rooms: [only] };
  return { kind: 'room', room: only as Room };
}

/* ------------------------------------------------------------ exceptions -- */

/**
 * Routes where the two disagree and the PAGE is the one that is wrong.
 *
 * EMPTY, and it should stay that way. It held two entries when this file was
 * written -- /simulator painting office inside the file-room pipeline, and
 * /coach/decision-loop painting clinic over seven panels of coaching work --
 * recorded rather than fixed only because that branch could not edit
 * app/**\/page.tsx. Both pages have since been moved to the room their door
 * files them under, and the tests below took the entries with them: the
 * 'drops a PAGE_IS_WRONG entry as soon as the page is fixed' check fails on
 * any line that outlives its fix.
 *
 * These are not tolerances. An entry is a page whose room contradicts what
 * the screen is for, and it is only ever the right move when the drift is
 * real, agreed, and out of reach of the change being made. Anything else is
 * a page to fix.
 */
const PAGE_IS_WRONG: Record<string, { paints: Room; shouldPaint: Room; why: string }> = {};

/**
 * Routes that paint no room at all.
 *
 * Not drift -- there is no second answer to disagree with -- but not nothing
 * either: a door filed under Front Office that opens onto a bare ink page is a
 * catalog promising a room the building does not have. They are listed with
 * what they paint instead so the set can only shrink, and so a NEW roomless
 * page has to be argued for rather than added in silence.
 *
 * Parent-facing routes are deliberately absent: RoleStandaloneView drops the
 * room on its canvas branch, so those are resolved as 'canvas' above and are
 * correct with no room.
 *
 * SIX HAVE LEFT. /dashboard and the three /operations surfaces were bare ink
 * under ink-tuned content -- mat-leather panels, t-* type, brass chips -- so
 * hanging the office wall behind them was a class on one line and nothing
 * else.
 *
 * /notices and /admin/consent were the two NEEDS A SLICE entries where the
 * room was already decided and the ink was the whole obstacle, and they were
 * paid rather than re-argued: /notices had its --hide-800 / --hide-950 header
 * moved onto .t-eyebrow / .t-command / .t-body, and /admin/consent had some
 * forty inline restatements of canvas-tan and --black replaced by the paper
 * form and ledger the sheet already carries. Both then took `room room--office`
 * on their last edited line. What remains is not a backlog of the same kind of
 * edit. Each entry below now says which of the reasons keeps it here:
 *
 *   NO MARKUP    -- the page returns a redirect or hands its whole surface to
 *                   something that brings its own ground. There is nowhere to
 *                   put a room and nothing a room would do.
 *   NEEDS A SLICE -- the room is DECIDED (the door says it, and the reason is
 *                   written out below), but the page's type and panels are
 *                   still tuned for the ground it is on. Moving the ground
 *                   without converting the content is the readability trap
 *                   roleGround.ts names and app/parent/safety/page.tsx
 *                   documents: hard-coded canvas ink lands dark-on-dark the
 *                   moment a wall goes up behind it. The conversion is the
 *                   work, and the room comes free at the end of it.
 *   FAMILY GROUND -- T7: a family or signed-out surface takes the warm plate
 *                   or none, never another room's wall.
 */
const UNPAINTED: Record<string, string> = {
  '/admin/safety-escalations':
    'NO MARKUP -- the whole page is redirect("/admin/escalations"); it returns no JSX',
  '/print':
    'NO MARKUP -- the page is a gate around PrintRoom, and print sheets carry their own '
    + 'paper ground. A wall behind paper that is about to leave the building on a printer '
    + 'is a wall nobody sees',
  '/store':
    'NEEDS A SLICE -- legacy canvas-tan with --black type, and open to families and '
    + 'signed-out visitors, so the ground is an audience question (T7) before it is a room one',
  '/retro-lab':
    'NEEDS A SLICE -- the door says floor, but this is the component showroom on canvas-tan, '
    + 'not a gym surface. A room here would put a brick wall behind samples of the things that '
    + 'are supposed to be shown against it',
  '/help':
    'FAMILY GROUND -- .on-canvas, open to every role and to nobody signed in at all. The door '
    + 'files it under office, which settles nothing: T7 is about who is reading, and a parent '
    + 'reads this one',
  '/public':
    'FAMILY GROUND -- .on-canvas, and the only surface a signed-out visitor sees',
  '/parent/consent':
    'FAMILY GROUND -- guardian page, room deliberately dropped (see the comment in the page)',
  '/parent/safety':
    'FAMILY GROUND -- guardian page, room deliberately dropped (see the comment in the page)',
};

/* ---------------------------------------------------------------- checks -- */

describe('the room a door files a surface under is the room the page paints', () => {
  const resolved = BUILDING.map((door) => ({ door, rendered: renderedRoom(door.href) }));

  it('reads a room off most of the building, so the comparison is not vacuous', () => {
    // A resolver that quietly returned 'none' everywhere would make every
    // assertion below pass while comparing nothing at all.
    const painted = resolved.filter((r) => r.rendered.kind === 'room');
    expect(painted.length).toBeGreaterThan(BUILDING.length * 0.7);
  });

  it('reads a room from a class, from a prop, from a layout and through a component', () => {
    // One pinned example of each way a page can state its room, so a change
    // that breaks one of the four paths fails here by name rather than showing
    // up as a pile of routes that suddenly paint nothing.
    expect(renderedRoom('/coach/review-queue')).toEqual({ kind: 'room', room: 'floor' }); // class
    expect(renderedRoom('/profile')).toEqual({ kind: 'room', room: 'office' }); // prop
    expect(renderedRoom('/wall')).toEqual({ kind: 'room', room: 'floor' }); // layout
    expect(renderedRoom('/names')).toEqual({ kind: 'room', room: 'floor' }); // component
  });

  it('treats a parent-facing surface as roomless rather than as drift', () => {
    // RoleStandaloneView ignores `room` on the canvas branch, so these render
    // no wall at all and cannot disagree with the map.
    expect(renderedRoom('/guardian')).toEqual({ kind: 'canvas' });
    expect(renderedRoom('/parent/dashboard')).toEqual({ kind: 'canvas' });
  });

  it('never finds a page standing in two rooms at once', () => {
    // Law: every screen inherits exactly one room (ROOM-PURPOSE-DNA.md).
    const split = resolved
      .filter((r) => r.rendered.kind === 'ambiguous')
      .map((r) => `${r.door.href} paints ${(r.rendered as { rooms: string[] }).rooms.join(' and ')}`);

    expect(split).toEqual([]);
  });

  it('files every painted surface under the room it paints', () => {
    const drifting = resolved
      .filter((r) => r.rendered.kind === 'room')
      .filter((r) => (r.rendered as { room: Room }).room !== r.door.room)
      .filter((r) => !(r.door.href in PAGE_IS_WRONG))
      .map((r) => `${r.door.href}: map says ${r.door.room}, page paints ${(r.rendered as { room: Room }).room}`);

    // Whoever trips this: decide which of the two is right about what the
    // screen is FOR (docs/shadow-ui/ROOM-PURPOSE-DNA.md), then fix that one.
    // Adding the route to PAGE_IS_WRONG is only for a page you may not edit.
    expect(drifting).toEqual([]);
  });

  it('keeps every PAGE_IS_WRONG entry honest about what the page paints today', () => {
    const wrong: string[] = [];
    for (const [href, entry] of Object.entries(PAGE_IS_WRONG)) {
      const rendered = renderedRoom(href);
      if (rendered.kind !== 'room' || rendered.room !== entry.paints) {
        wrong.push(`${href}: recorded as painting ${entry.paints}, actually ${JSON.stringify(rendered)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('drops a PAGE_IS_WRONG entry as soon as the page is fixed', () => {
    // The entry exists because the branch that found the drift could not edit
    // pages. Once the page paints what the map says, the line is a lie about
    // outstanding work -- so it has to fail, loudly, and be deleted.
    const settled = Object.keys(PAGE_IS_WRONG).filter((href) => {
      const rendered = renderedRoom(href);
      const door = BUILDING.find((d) => d.href === href);
      return rendered.kind === 'room' && door !== undefined && rendered.room === door.room;
    });

    expect(settled).toEqual([]);
  });

  it('points every PAGE_IS_WRONG entry at the room its door already says', () => {
    // The map side is fixed on this branch. If an entry disagrees with the
    // door too, then nobody has decided what the surface is, and the note is
    // pointing at a third answer.
    for (const [href, entry] of Object.entries(PAGE_IS_WRONG)) {
      expect(BUILDING.find((d) => d.href === href)?.room).toBe(entry.shouldPaint);
    }
  });

  it('does not let the roomless set grow', () => {
    const unpainted = resolved
      .filter((r) => r.rendered.kind === 'none')
      .map((r) => r.door.href)
      .filter((href) => !(href in UNPAINTED));

    // A new page with no room is a door onto a corridor with no wall. Give it
    // one of the six, or add it here with what it paints instead and why.
    expect(unpainted).toEqual([]);
  });

  it('does not keep a roomless entry for a page that now has a room', () => {
    const stale = Object.keys(UNPAINTED).filter((href) => renderedRoom(href).kind !== 'none');
    expect(stale).toEqual([]);
  });

  it('never records the same route as both roomless and mis-painted', () => {
    expect(Object.keys(PAGE_IS_WRONG).filter((href) => href in UNPAINTED)).toEqual([]);
  });

  it('carries no exception for a route with no door', () => {
    const hrefs = new Set(BUILDING.map((d) => d.href));
    const orphaned = [...Object.keys(PAGE_IS_WRONG), ...Object.keys(UNPAINTED)]
      .filter((href) => !hrefs.has(href));
    expect(orphaned).toEqual([]);
  });
});
