import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readDesignSystemCss } from '../src/design/readDesignSystemCss';

/**
 * A ROOM MODIFIER ON ITS OWN IS NOT A ROOM.
 *
 * ppbf.css builds a room out of four parts and only one of them is the
 * modifier:
 *
 *   .room          the ground, the ink, `position: relative`, `isolation`
 *   .room::before  THE LIGHT -- the lamp pools and the falloff, which is the
 *                  whole difference between a lit room and a flat field
 *   .room::after   the plate layer, painting var(--plate)
 *   .room--X       the material variation. It DECLARES --plate and it never
 *                  consumes it, because the consumer is .room::after.
 *
 * So a surface that writes `room--office` and stops gets the plank texture and
 * nothing else: no lamp, no plate layer, no stacking context for the plate to
 * live in, and none of the base ground underneath. It still looks like it did
 * something, which is why this went unnoticed -- a pseudo-element selector
 * whose subject class is absent simply never matches, and neither the build,
 * the type-checker, nor a browser says a word about it.
 *
 * That is what shipped. RoleStandaloneView emitted
 *
 *     familyGround ? '' : (room ? `room--${room}` : '')
 *
 * and 76 of the 79 surfaces in the building went out with unlit walls. The
 * three that read as rooms -- /chalkboard, /wall, /names -- were the three
 * that happened to write the pair by hand. The owner's report was that the
 * whole app "looks like one skin", and it did: every room was the same flat
 * texture behind the same panels.
 *
 * designSystemClasses.test.ts checks the six .room--* RULES still exist in the
 * sheet, and buildingMapRooms.test.ts checks each page paints the room its
 * door files it under. Neither can see this: both are satisfied by a modifier
 * that is present, correctly spelled, and attached to nothing.
 *
 * MUTATION-CHECKED. Reverting the shell to `room--${room}` alone turns two of
 * the tests below red by name.
 */

const WEB_DIR = join(__dirname, '..');
const REPO = join(WEB_DIR, '..', '..');
const CSS = join(REPO, 'design-system', 'ppbf.css');
const DESIGN_SYSTEM = join(REPO, 'design-system');

const ROOMS = ['office', 'floor', 'board', 'file', 'clinic', 'night'] as const;

/**
 * The base class, and the only spelling of it. Written out rather than derived
 * from the sheet so that renaming `.room` fails here loudly instead of quietly
 * turning this file into a test of nothing.
 */
const BASE = 'room';

/**
 * `.corridor-room` is the one place a modifier is deliberately worn WITHOUT the
 * base. The corridor is a row of doorways, not a room you are standing in:
 * ppbf.css overrides the wall away again for `.corridor-room[class*="room--"]`
 * and keeps every block on the dark ground, using the modifier only to pick an
 * accent down the left edge. Adding the base there would paint six walls
 * inside one panel, which is what that override exists to prevent.
 */
const WEARS_MODIFIER_WITHOUT_BASE = 'corridor-room';

/** class="..." / className="..." / className={`...`}, in .tsx and in .html. */
const CLASS_ATTR = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

/* Prose is not markup. Every one of these files explains the room system at
   length, and several quote a class name inside backticks while doing it --
   `room--floor` appears in a comment on /coach/passbook-gaps saying the page
   supplies it itself. Stripping comments first is what keeps this file from
   failing on an accurate sentence. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function sourceFiles(dir: string, match: RegExp, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'test-results') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, match, acc);
    else if (match.test(entry)) acc.push(full);
  }
  return acc;
}

/**
 * Does this class list name a room?
 *
 * Both spellings count. `room--office` is the literal a page writes, and
 * `room--${...}` is the template fragment a shell writes -- and the shell is
 * the form that broke, so a check that only understood literals would have
 * watched the defect go out.
 */
function namesARoom(tokens: string[]): boolean {
  return tokens.some(
    (token) => ROOMS.some((r) => token === `room--${r}`) || token.startsWith('room--${'),
  );
}

function classLists(source: string): string[] {
  return [...withoutComments(source).matchAll(CLASS_ATTR)]
    .map((attr) => (attr[1] ?? attr[2] ?? attr[3] ?? '').trim());
}

function roomsWithoutTheBase(files: string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    for (const classes of classLists(readFileSync(file, 'utf8'))) {
      const tokens = classes.split(/\s+/).filter(Boolean);
      if (!namesARoom(tokens)) continue;
      if (tokens.includes(BASE)) continue;
      if (tokens.includes(WEARS_MODIFIER_WITHOUT_BASE)) continue;
      offenders.push(`${file.replace(`${REPO}/`, '')}: class="${classes}"`);
    }
  }
  return offenders;
}

const appFiles = sourceFiles(WEB_DIR, /\.tsx$/).filter((f) => !/\.test\.tsx$/.test(f));
const showroomFiles = sourceFiles(DESIGN_SYSTEM, /\.html$/);

describe('every surface that declares a room also carries the base .room class', () => {
  it('finds room declarations to check, so a broken scanner cannot pass', () => {
    // If the scanner stops matching -- a refactor moves the classes, the regex
    // rots -- every assertion below passes while checking nothing. Seventy-odd
    // surfaces paint a room today; ten is a floor low enough to survive
    // ordinary churn and high enough that a dead scanner trips it.
    const declaring = [...appFiles, ...showroomFiles].filter((file) =>
      classLists(readFileSync(file, 'utf8')).some((classes) =>
        namesARoom(classes.split(/\s+/).filter(Boolean)),
      ),
    );
    expect(declaring.length).toBeGreaterThan(10);
  });

  it('never writes a room modifier without it in the app', () => {
    // Whoever trips this: write `room room--X`, not `room--X`. The modifier is
    // the material; the base is the room. Without the base there is no light on
    // the wall and no plate layer, and the surface reads as the same flat
    // texture as every other surface in the building.
    expect(roomsWithoutTheBase(appFiles)).toEqual([]);
  });

  it('never writes a room modifier without it in the design system showroom', () => {
    // The showroom is the reference the next contributor looks at to decide
    // what a room is meant to look like. A showroom that renders its own rooms
    // unlit teaches the defect.
    expect(roomsWithoutTheBase(showroomFiles)).toEqual([]);
  });

  it('never builds a class string that STARTS with a room modifier', () => {
    // The attribute scanner above cannot see a className composed in code --
    // RoleStandaloneView builds an array and joins it, which is exactly where
    // this defect lived. Any string or template literal whose first token is
    // `room--` is a room with no base, however it is later assembled.
    const offenders = appFiles.filter((file) => {
      const source = withoutComments(readFileSync(file, 'utf8'));
      return /(?:`|'|")room--(?:\$\{|office|floor|board|file|clinic|night)/.test(source);
    });
    expect(offenders.map((f) => f.replace(`${REPO}/`, ''))).toEqual([]);
  });

  it('keeps the shell emitting the pair, since it speaks for most of the building', () => {
    // Pinned by name because RoleStandaloneView is the single call site that
    // decides the ground for 39 routes. A regression here is not one surface,
    // it is most of the app -- worth failing on its own line rather than as one
    // entry in a list.
    const shell = withoutComments(readFileSync(join(__dirname, 'RoleStandaloneView.tsx'), 'utf8'));
    expect(shell).toContain('`room room--${room}');
  });
});

describe('the light and the plate hang off the base class, which is why it is required', () => {
  const stripped = readDesignSystemCss(CSS).replace(/\/\*[\s\S]*?\*\//g, '');

  /** The body of the first rule whose selector list begins with `selector`. */
  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return stripped.match(new RegExp(`(?:^|,|\\})\\s*${escaped}[^{}]*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  }

  it('draws the fixture light on .room::before and nowhere else', () => {
    // The rooms each restyle this pseudo-element (.room--clinic::before is the
    // green shade, .room--night::before the low lamp), but only the base gives
    // it a box to paint in. Restyling a pseudo-element that was never created
    // paints nothing at all.
    const light = ruleBody('.room::before');
    expect(light).toContain('content:');
    expect(light).toContain('position: absolute');
    expect(light).toContain('radial-gradient');
  });

  it('paints the plate on .room::after, reading the variable the modifiers set', () => {
    // Every rule for this pseudo-element, not the first: the print block and
    // the prefers-reduced-data block both switch the plate off by name, and
    // either would satisfy a first-match check while proving nothing.
    const bodies = [...stripped.matchAll(/(?:^|,|\})\s*\.room::after[^{}]*\{([^}]*)\}/gm)]
      .map((m) => m[1]);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some((body) => body.includes('var(--plate'))).toBe(true);
  });

  it('gives .room the positioning both layers need', () => {
    // ::before is `position: absolute; inset: 0` and ::after sits at z-index -1.
    // Without `position: relative` the light is measured against some ancestor;
    // without `isolation: isolate` the -1 layer escapes upward and paints behind
    // the page ground. Both live on the base, so a bare modifier gets neither.
    expect(ruleBody('.room')).toContain('position: relative');
    expect(stripped).toMatch(/\.room\s*\{\s*isolation:\s*isolate/);
  });

  it('leaves the modifiers declaring --plate without consuming it', () => {
    // The reason for the class pair, stated as an assertion: every room names a
    // plate and not one of them paints it. .room::after is the only consumer.
    for (const room of ROOMS) {
      expect(stripped).toMatch(new RegExp(`\\.room--${room}\\s*\\{\\s*--plate:\\s*url\\(`));
    }
    expect(stripped).not.toMatch(/\.room--[a-z]+::after\s*\{/);
  });

  it('states no padding on .room, so a surface keeps the edges it lays out', () => {
    // A room is a wall, not a layout. This sheet is unlayered and Tailwind's
    // utilities are not, so a padding here does not add to the p-/px-/py- a
    // page states -- it REPLACES it, insets a full-bleed band away from the
    // wall, and double-pads the surfaces whose inner container already states
    // its own. Re-adding it silently re-lays-out seventy-odd screens.
    expect(ruleBody('.room')).not.toMatch(/(^|;)\s*padding:/);
  });
});
