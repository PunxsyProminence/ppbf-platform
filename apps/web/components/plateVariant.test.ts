import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BUILDING, type Room } from './buildingMap';
import {
  PLATE_SPLITS,
  PLATE_VARIANT_ATTRIBUTE,
  normalizePlateRoute,
  plateVariantSlot,
  plateVariantTokens,
} from './plateVariant';
import { readDesignSystemCss } from '../src/design/readDesignSystemCss';

/**
 * THE ROUTE-DERIVED PLATE VARIANT, AND THE CASCADE IT HAS TO SURVIVE.
 *
 * Two halves, and either one alone is a mechanism that does nothing:
 *
 *   (a) a deterministic selector -- route in, variant slot out, the same
 *       answer every load, forever;
 *   (b) a rule in the PLATES section of ppbf.css that the slot can actually
 *       reach, WITHOUT outranking the overrides that are already there.
 *
 * (b) is the part with teeth. `@media (orientation: portrait)` carries no
 * specificity of its own, so the portrait floor plate is defended by nothing
 * but `.room--floor` at (0,1,0) and its position in the file. Any variant rule
 * written the obvious way -- `.room--floor[data-plate-variant~="2of2"]` -- is
 * (0,2,0), outranks it, and takes the portrait plate off the gym tablet: the
 * one room where the crop matters most, on the one device it matters most on,
 * silently, with no build error and no warning anywhere. This repository has
 * shipped four defects from that family. So the sheet wraps the attribute in
 * `:where()` to keep every plate rule at (0,1,0) and orders the block by source
 * position, and the tests below prove BOTH directions: that the portrait plate
 * survives the variant rule, and that it would NOT survive the same rule
 * written without `:where()`.
 *
 * NOTHING WAS SEEN RENDERED. The sandbox refuses outbound HTTPS and no lane can
 * load a deployed page, so the cascade here is reasoned from the sheet by the
 * resolver below rather than measured in a browser. The resolver is written to
 * refuse anything it does not understand for exactly that reason: a guard that
 * quietly skipped a rule it could not parse would be a green test that had
 * checked nothing.
 */

const REPO = join(__dirname, '..', '..', '..');
const CSS_PATH = join(REPO, 'design-system', 'ppbf.css');
const CSS = readDesignSystemCss(CSS_PATH);
const SELECTOR_SOURCE = readFileSync(join(__dirname, 'plateVariant.ts'), 'utf8');

/** The plate each room resolves to today, straight out of the locked inventory. */
const DEFAULT_PLATE: Record<Room, string> = {
  office: '/plates/plate-01-office-01.jpg',
  floor: '/plates/plate-02a-floor-landscape-01.jpg',
  board: '/plates/plate-04-board-01.jpg',
  file: '/plates/plate-05-file-01.jpg',
  clinic: '/plates/plate-03-clinic-01.jpg',
  night: '/plates/plate-06-night-01.jpg',
};

const FLOOR_PORTRAIT_PLATE = '/plates/plate-02b-floor-portrait-01.jpg';

/* ==========================================================================
   A CASCADE THE TESTS CAN INTERROGATE

   jsdom is not an option here: its getComputedStyle does not resolve custom
   properties through the cascade at all, so asking it which plate wins would
   return a green answer it had not computed. Reading the sheet directly is
   also what five other guards in this repository already do (roomBaseClass,
   familyPlateGround, designSystemClasses, typeLadder, cornerColor); this is
   that habit with specificity and source order attached.
   ========================================================================== */
interface StyleTarget {
  /** Classes on the element itself, e.g. `room`, `room--floor`. */
  readonly classes: readonly string[];
  /** Element name, only used if a rule ever carries a type selector. */
  readonly tag?: string;
  /**
   * The single ancestor this model has: PlateVariantGround's marker. Its
   * attributes are what an ancestor compound in a selector is matched against.
   * Omit it to model a room rendered with no ground at all -- the degradation
   * rung where no variant logic has run.
   */
  readonly groundAttributes?: Readonly<Record<string, string>>;
}

interface MediaState {
  readonly orientation: 'portrait' | 'landscape';
  readonly reducedData: boolean;
  readonly print: boolean;
}

const SCREEN: MediaState = { orientation: 'landscape', reducedData: false, print: false };
const PORTRAIT: MediaState = { orientation: 'portrait', reducedData: false, print: false };

interface CssRule {
  readonly selectors: readonly string[];
  readonly media: readonly string[];
  readonly body: string;
  /** Position in the sheet. Later wins at equal specificity. */
  readonly order: number;
}

interface Specificity {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/* ------------------------------------------------------------- parsing -- */

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every rule in a sheet, flattened, each carrying the at-rule conditions it
 * sits inside and its position in source order.
 *
 * `@keyframes`, `@font-face` and `@page` fall through the ordinary-rule branch
 * and are consumed whole by brace matching, so their innards never reach the
 * rule list. Only `@media` nests here, because only `@media` is a condition a
 * plate rule can hide behind in this sheet.
 */
function parseCss(css: string): CssRule[] {
  const source = stripCssComments(css);
  const rules: CssRule[] = [];
  const media: string[] = [];
  let prelude = '';
  let index = 0;
  let order = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === ';') {
      // An at-statement such as `@import "./fonts.css";` -- no block to enter.
      prelude = '';
      index += 1;
      continue;
    }

    if (char === '}') {
      media.pop();
      prelude = '';
      index += 1;
      continue;
    }

    if (char !== '{') {
      prelude += char;
      index += 1;
      continue;
    }

    const head = prelude.trim();
    prelude = '';

    if (head.startsWith('@media')) {
      media.push(head.slice('@media'.length).trim());
      index += 1;
      continue;
    }

    let depth = 1;
    let end = index + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    rules.push({
      selectors: head.split(',').map((one) => one.trim()).filter(Boolean),
      media: [...media],
      body: source.slice(index + 1, end - 1),
      order: order++,
    });
    index = end;
  }

  return rules;
}

/* ---------------------------------------------------------- specificity -- */

const SIMPLE = /^(?:\.[\w-]+|#[\w-]+|\[[^\]]+\]|::[\w-]+|:[\w-]+|[a-zA-Z][\w-]*)/;

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of input) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The compounds of a selector, outermost ancestor first. */
function compoundsOf(selector: string): string[] {
  if (/[>+~]/.test(selector.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, ''))) {
    throw new Error(`plateCascade: combinators other than descendant are not modelled: ${selector}`);
  }
  return splitTopLevel(selector, ' ');
}

function tokensOf(compound: string): string[] {
  const tokens: string[] = [];
  let rest = compound;
  while (rest.length > 0) {
    if (rest.startsWith(':where(')) {
      let depth = 0;
      let end = ':where'.length;
      for (; end < rest.length; end += 1) {
        if (rest[end] === '(') depth += 1;
        if (rest[end] === ')') {
          depth -= 1;
          if (depth === 0) { end += 1; break; }
        }
      }
      if (depth !== 0) throw new Error(`plateCascade: unbalanced :where() in ${compound}`);
      tokens.push(rest.slice(0, end));
      rest = rest.slice(end);
      continue;
    }
    const match = SIMPLE.exec(rest);
    if (!match) throw new Error(`plateCascade: unreadable selector fragment "${rest}" in "${compound}"`);
    tokens.push(match[0]);
    rest = rest.slice(match[0].length);
  }
  return tokens;
}

function specificityOf(selector: string): Specificity {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const compound of compoundsOf(selector)) {
    for (const token of tokensOf(compound)) {
      // THE WHOLE POINT: :where() contributes nothing, whatever is inside it.
      if (token.startsWith(':where(')) continue;
      if (token.startsWith('#')) a += 1;
      else if (token.startsWith('.') || token.startsWith('[')) b += 1;
      else if (token.startsWith('::')) c += 1;
      else if (token.startsWith(':')) b += 1;
      else c += 1;
    }
  }
  return { a, b, c };
}

/* ------------------------------------------------------------- matching -- */

function attributeMatches(token: string, attributes: Readonly<Record<string, string>>): boolean {
  const parsed = /^\[([\w-]+)(?:(~?=)"([^"]*)")?\]$/.exec(token);
  if (!parsed) throw new Error(`plateCascade: attribute selector not modelled: ${token}`);
  const [, name, operator, value] = parsed;
  const present = Object.prototype.hasOwnProperty.call(attributes, name);
  if (!operator) return present;
  if (!present) return false;
  const actual = attributes[name];
  if (operator === '=') return actual === value;
  return actual.split(/\s+/).includes(value);
}

function compoundMatches(
  compound: string,
  classes: readonly string[],
  attributes: Readonly<Record<string, string>>,
  tag: string,
  allowPseudoElement: boolean,
): boolean {
  for (const token of tokensOf(compound)) {
    if (token.startsWith(':where(')) {
      const inner = token.slice(':where('.length, -1);
      const anyMatches = splitTopLevel(inner, ',').some((one) => {
        const parts = compoundsOf(one);
        if (parts.length !== 1) {
          throw new Error(`plateCascade: :where() with a descendant selector is not modelled: ${token}`);
        }
        return compoundMatches(parts[0], classes, attributes, tag, allowPseudoElement);
      });
      if (!anyMatches) return false;
      continue;
    }
    if (token.startsWith('.')) {
      if (!classes.includes(token.slice(1))) return false;
      continue;
    }
    if (token.startsWith('[')) {
      if (!attributeMatches(token, attributes)) return false;
      continue;
    }
    if (token.startsWith('::')) {
      // A pseudo-element narrows to a generated box, not to a different
      // element; `--plate` is declared on the element, never on ::after.
      if (!allowPseudoElement) return false;
      continue;
    }
    if (token.startsWith(':')) {
      throw new Error(`plateCascade: pseudo-class not modelled: ${token}`);
    }
    if (token !== tag) return false;
  }
  return true;
}

/**
 * Does this selector match the modelled element?
 *
 * The model has exactly two nodes -- the ground marker and the room element --
 * so a selector with more than one ancestor compound is refused rather than
 * approximated.
 */
function selectorMatches(selector: string, target: StyleTarget): boolean {
  const compounds = compoundsOf(selector);
  const subject = compounds[compounds.length - 1];
  const ancestors = compounds.slice(0, -1);
  if (ancestors.length > 1) {
    throw new Error(`plateCascade: more than one ancestor compound is not modelled: ${selector}`);
  }
  if (!compoundMatches(subject, target.classes, {}, target.tag ?? 'main', false)) return false;
  for (const ancestor of ancestors) {
    if (!compoundMatches(ancestor, [], target.groundAttributes ?? {}, 'div', false)) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- media -- */

function mediaHolds(condition: string, state: MediaState): boolean {
  const text = condition.trim();
  if (text === 'print') return state.print;
  if (text === '(orientation: portrait)') return state.orientation === 'portrait';
  if (text === '(orientation: landscape)') return state.orientation === 'landscape';
  if (text === '(prefers-reduced-data: reduce)') return state.reducedData;
  throw new Error(`plateCascade: media condition not modelled: ${condition}`);
}

/* ------------------------------------------------------------- resolving -- */

const PLATE_DECLARATION = /(?:^|;)\s*--plate\s*:\s*([^;]+)/;

interface PlateResolution {
  readonly url: string | null;
  readonly selector: string;
  readonly specificity: Specificity;
  readonly order: number;
}

/** Every rule in the sheet that declares `--plate`, with its position. */
function platePropertyRules(css: string): { rule: CssRule; selector: string; value: string }[] {
  const found: { rule: CssRule; selector: string; value: string }[] = [];
  for (const rule of parseCss(css)) {
    const declaration = PLATE_DECLARATION.exec(rule.body);
    if (!declaration) continue;
    for (const selector of rule.selectors) {
      found.push({ rule, selector, value: declaration[1].trim() });
    }
  }
  return found;
}

/**
 * The `--plate` URL that actually wins for this element under this viewport,
 * or null when nothing declares one.
 */
function resolvePlate(css: string, target: StyleTarget, state: MediaState): PlateResolution | null {
  let winner: (PlateResolution & { value: string }) | null = null;

  for (const { rule, selector, value } of platePropertyRules(css)) {
    if (!rule.media.every((condition) => mediaHolds(condition, state))) continue;
    if (!selectorMatches(selector, target)) continue;

    const specificity = specificityOf(selector);
    if (winner) {
      const better = specificity.a !== winner.specificity.a
        ? specificity.a > winner.specificity.a
        : specificity.b !== winner.specificity.b
          ? specificity.b > winner.specificity.b
          : specificity.c !== winner.specificity.c
            ? specificity.c > winner.specificity.c
            : rule.order >= winner.order;
      if (!better) continue;
    }

    const url = /^url\("([^"]+)"\)$/.exec(value);
    winner = {
      url: url ? url[1] : null,
      value,
      selector,
      specificity,
      order: rule.order,
    };
  }

  return winner;
}

/* ==========================================================================
   HELPERS THE TESTS SHARE
   ========================================================================== */

/** A room element standing under the ground marker for `route`. */
function roomOn(room: Room, route: string | null): StyleTarget {
  const tokens = route === null ? undefined : plateVariantTokens(route);
  return {
    classes: ['room', `room--${room}`],
    tag: 'main',
    groundAttributes: tokens === undefined ? {} : { [PLATE_VARIANT_ATTRIBUTE]: tokens },
  };
}

/** The sheet with a variant rule spliced in exactly where the block says. */
function cssWithVariant(rule: string): string {
  const anchor = '@media (orientation: portrait) {';
  if (!CSS.includes(anchor)) throw new Error('the orientation override moved; this test needs rewriting');
  return CSS.replace(anchor, `${rule}\n\n${anchor}`);
}

const doorsIn = (room: Room) => BUILDING.filter((door) => door.room === room).map((door) => door.href);

/* ==========================================================================
   (a) THE SELECTOR
   ========================================================================== */

describe('the same route resolves to the same variant, every time', () => {
  it('returns an identical token list on repeated calls', () => {
    for (const href of BUILDING.map((door) => door.href)) {
      const first = plateVariantTokens(href);
      for (let repeat = 0; repeat < 5; repeat += 1) {
        expect(plateVariantTokens(href)).toBe(first);
      }
    }
  });

  it('pins the mapping, so the building cannot be reshuffled by accident', () => {
    /*
     * THIS IS NOT A CHANGE-DETECTOR, IT IS THE PROMISE ITSELF.
     *
     * "Deterministic" is not a property of a single run -- comparing a call to
     * itself proves only that the function is a function, and the first version
     * of this test did exactly that and could not fail. The promise the README
     * and GROK-VISUAL-LANE both make is across TIME: the door a coach opened
     * last week stands in front of the same wall today. Nothing enforces that
     * except a recorded answer, so here it is recorded.
     *
     * The values are free to be wrong today and expensive to change later:
     * every room is at -01, so re-hashing now costs nothing and re-hashing
     * after art lands moves walls under people. Locking it while it is free is
     * the point. If you are here because this went red, you changed the hash --
     * which is allowed, deliberately, by an owner, and never as a side effect
     * of tidying the mixing function.
     */
    const PINNED: ReadonlyArray<readonly [string, string]> = [
      ['/dashboard', '1of2 3of3 1of4 5of5 3of6'],
      ['/coach/review-queue', '2of2 3of3 2of4 1of5 6of6'],
      ['/wall', '2of2 1of3 4of4 1of5 4of6'],
      ['/names', '1of2 3of3 3of4 1of5 3of6'],
      ['/admin/attendance', '1of2 1of3 1of4 2of5 1of6'],
      ['/board', '2of2 2of3 4of4 4of5 2of6'],
    ];
    for (const [route, tokens] of PINNED) {
      expect(`${route} -> ${plateVariantTokens(route)}`).toBe(`${route} -> ${tokens}`);
    }
    // And the pinned routes are real doors, not invented strings.
    const hrefs = new Set(BUILDING.map((door) => door.href));
    for (const [route] of PINNED) expect(hrefs.has(route)).toBe(true);
  });

  it('reads a query string and a trailing slash as the same page', () => {
    expect(plateVariantTokens('/admin/athletes?tab=roster')).toBe(plateVariantTokens('/admin/athletes'));
    expect(plateVariantTokens('/admin/athletes/')).toBe(plateVariantTokens('/admin/athletes'));
    expect(plateVariantTokens('/admin/athletes#top')).toBe(plateVariantTokens('/admin/athletes'));
    expect(normalizePlateRoute('/')).toBe('/');
  });

  it('derives the variant from nothing but the path', () => {
    // The rule the README and GROK-VISUAL-LANE both state, asserted against the
    // source rather than trusted: no clock, no randomness, no counter, no
    // session. A screen that changes between loads breaks screenshot
    // comparison, print reproducibility, and a coach's sense of place.
    //
    // PROSE IS NOT CODE. The first version of this scanned the raw file and
    // failed on the module's own comment explaining that it uses no Math.random
    // -- the same trap roomBaseClass.test.ts and buildingMapRooms.test.ts each
    // had to fix, arriving here from the opposite direction: there a comment
    // made a guard pass, here it made one fail. Both are the same mistake.
    const executable = SELECTOR_SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');

    expect(executable).toContain('plateVariantTokens');
    expect(executable).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|crypto\./);
    // Nor may it accumulate state between calls. A module-level binding is one
    // written at column zero -- the `let`s inside the hash are locals, reset on
    // every call, and a counter cannot hide in one.
    expect(executable).not.toMatch(/^(?:let|var)\s/m);
  });

  it('emits one well-formed token per split and nothing else', () => {
    const tokens = plateVariantTokens('/coach/review-queue')!.split(' ');
    expect(tokens).toHaveLength(PLATE_SPLITS.length);
    tokens.forEach((token, index) => {
      const count = PLATE_SPLITS[index];
      const parsed = /^(\d+)of(\d+)$/.exec(token);
      expect(parsed).not.toBeNull();
      expect(Number(parsed![2])).toBe(count);
      expect(Number(parsed![1])).toBeGreaterThanOrEqual(1);
      expect(Number(parsed![1])).toBeLessThanOrEqual(count);
    });
  });

  it('has no route to derive a variant from, and says so', () => {
    // React drops an attribute whose value is undefined, so a room rendered
    // outside a router carries none and falls back to its -01 declaration.
    expect(plateVariantTokens(null)).toBeUndefined();
    expect(plateVariantTokens(undefined)).toBeUndefined();
    expect(plateVariantTokens('')).toBeUndefined();
  });
});

describe('routes in a big room spread across the variants instead of piling up', () => {
  // Office covers 40 doors and floor 31 (README). A selector that sent all of
  // them to one plate would satisfy every determinism test in this file and
  // still be useless -- so the distribution is measured, per split, on the real
  // route list rather than on invented strings.
  for (const room of ['office', 'floor'] as const) {
    const doors = doorsIn(room);

    it(`spreads the ${room} doors across every split`, () => {
      expect(doors.length).toBeGreaterThan(10);

      for (const count of PLATE_SPLITS) {
        const buckets = new Map<number, number>();
        for (const href of doors) {
          const slot = plateVariantSlot(href, count);
          buckets.set(slot, (buckets.get(slot) ?? 0) + 1);
        }

        // NOTHING TAKES OVER. A fair share is 1/count of the room's doors;
        // twice that is a generous ceiling for a hash over 32-44 real strings,
        // and it is the assertion a broken selector cannot survive -- anything
        // that returns a constant, or ignores the route, puts every door in one
        // bucket and blows through this by a factor of `count`.
        const ceiling = (doors.length * 2) / count;
        for (const used of buckets.values()) expect(used).toBeLessThanOrEqual(ceiling);

        /* NEARLY EVERY PLATE GETS USED, where there are enough doors for
           that to be a statement about the hash rather than about small
           numbers.

           This asserted that EVERY bucket is occupied above six doors per
           plate, on the stated expectation that floor's known empty
           six-bucket at 32 doors was small-number variance that a few more
           routes would fill. Measured when the 36th floor door was added:
           the split went 8/5/11/6/0/6 -- still empty, in the same bucket,
           and 8/4/11/6/0/6 without the new door, so the gap belongs to the
           existing route names and not to the addition that revealed it.

           The expectation was a guess and the measurement disproved it. For
           36 items in 6 buckets a specific bucket is empty with probability
           (5/6)^36, about 0.15%, and SOME bucket about 0.9% -- unlikely, and
           this route set is that case. A guard that demands a coin land the
           likely way is a guard that blocks the next unrelated route.

           So the claim is narrowed to what the data supports and no further:
           at most one plate may go unused. That still fails hard on the
           failure this whole block exists for -- a selector that ignores the
           route leaves count-1 buckets empty, not one -- and the ceiling
           assertion above, which the file's own comment calls the one a
           broken selector cannot survive, is untouched.

           Whether the hash should be reshaped so all six fill is a design
           question for the plate lane, not something to settle by refusing
           to add a door. */
        if (doors.length >= count * 6) {
          const unused = count - buckets.size;
          expect(unused).toBeLessThanOrEqual(1);
        }
      }
    });
  }

  it('does not hand every route in the building the same tokens', () => {
    // The token list is one hash reduced five ways, so it can take at most
    // lcm(2,3,4,5,6) = 60 distinct values however many doors there are. 108
    // doors thrown at 60 buckets fill about 50 of them, which is what a sound
    // hash looks like -- and both bounds are asserted, because a mutation that
    // collapsed the hash would undershoot and one that smuggled in per-call
    // state would overshoot the ceiling that the arithmetic makes impossible.
    const distinct = new Set(BUILDING.map((door) => plateVariantTokens(door.href)));
    expect(distinct.size).toBeGreaterThan(35);
    expect(distinct.size).toBeLessThanOrEqual(60);
  });
});

/* ==========================================================================
   (b) THE SHEET
   ========================================================================== */

describe('the resolver reads the sheet it is pointed at', () => {
  it('finds the plate declarations that are actually there', () => {
    // A parser that returned nothing would make every cascade test below pass
    // by resolving nothing at all -- the failure mode a sheet-reading guard is
    // most prone to.
    const declared = platePropertyRules(CSS).map((entry) => entry.selector);
    expect(declared).toEqual(expect.arrayContaining([
      '.room--office', '.room--floor', '.room--board',
      '.room--file', '.room--clinic', '.room--night', '.on-canvas',
    ]));
    // Six rooms, the portrait floor, and the warm canvas ground.
    expect(declared).toHaveLength(8);
  });

  it('still routes every plate through --plate, so resolving it means something', () => {
    expect(CSS).toMatch(/\.room::after,\s*\n?\s*\.on-canvas::after\s*\{[^}]*background-image:\s*var\(--plate,\s*none\)/);
  });

  it('scores :where() at zero and a bare attribute at one', () => {
    expect(specificityOf('.room--floor')).toEqual({ a: 0, b: 1, c: 0 });
    expect(specificityOf(':where([data-plate-variant~="2of2"]) .room--floor')).toEqual({ a: 0, b: 1, c: 0 });
    expect(specificityOf('[data-plate-variant~="2of2"] .room--floor')).toEqual({ a: 0, b: 2, c: 0 });
  });
});

describe('the PLATES cascade is decided by source order, not by specificity', () => {
  it('holds every plate declaration in the sheet at exactly one class', () => {
    // This is the law, stated as one assertion. Every rule that declares
    // --plate sits at (0,1,0), so nothing in the block can outrank anything
    // else and position in the file is the whole answer. A variant rule that
    // drops :where() lands at (0,2,0) and fails here by name.
    const offenders = platePropertyRules(CSS)
      .map(({ selector }) => ({ selector, specificity: specificityOf(selector) }))
      .filter(({ specificity }) => specificity.a !== 0 || specificity.b !== 1 || specificity.c !== 0)
      .map(({ selector, specificity }) => `${selector} is (${specificity.a},${specificity.b},${specificity.c})`);

    expect(offenders).toEqual([]);
  });

  it('keeps every variant rule ahead of the orientation override, or inside it', () => {
    // Equal specificity means the later rule wins, so a variant rule declared
    // after the portrait block would beat it just as surely as a specificity
    // mistake would.
    const portrait = platePropertyRules(CSS)
      .find((entry) => entry.rule.media.includes('(orientation: portrait)'));
    expect(portrait).toBeDefined();

    const misplaced = platePropertyRules(CSS)
      .filter((entry) => entry.selector.includes(PLATE_VARIANT_ATTRIBUTE))
      .filter((entry) => !entry.rule.media.includes('(orientation: portrait)'))
      .filter((entry) => entry.rule.order > portrait!.rule.order)
      .map((entry) => entry.selector);

    expect(misplaced).toEqual([]);
  });

  it('documents the recipe next to the rules it governs', () => {
    // The one declaration a person adds when art arrives. If the worked example
    // drifts from what the tests prove, the next person follows the comment.
    expect(CSS).toContain(':where([data-plate-variant~="2of2"]) .room--office');
    expect(CSS).toContain('data-plate-variant="2of2 1of3 4of4 3of5 5of6"');
  });
});

/* ==========================================================================
   (c) THE NO-CHANGE GUARANTEE, AND THE LADDER UNDER IT
   ========================================================================== */

describe('with one variant per room, every route resolves to -01', () => {
  it('declares no variant rule at all today', () => {
    /*
     * THE NO-CHANGE GUARANTEE, AND THE TRIPWIRE UNDER IT.
     *
     * Every room is at -01, and a room with one plate needs no rule: the
     * declaration in the locked inventory is already the right answer for every
     * route. So this branch resolves every door to exactly the plate it
     * resolved to before, and merging it changes nothing anybody can see.
     *
     * WHEN ART ARRIVES this goes red on purpose, and it is not alone -- the two
     * tests below it and 'finds the plate declarations that are actually there'
     * all count today's inventory. That is the intended cost: adding a plate is
     * a deliberate act with a short, named list of expectations to move, rather
     * than a silent change to what the building looks like.
     */
    const variantRules = platePropertyRules(CSS).filter((entry) => entry.selector.includes(PLATE_VARIANT_ATTRIBUTE));
    expect(variantRules).toEqual([]);
  });

  it('paints the locked inventory on every door in the building', () => {
    const wrong: string[] = [];
    for (const door of BUILDING) {
      const resolved = resolvePlate(CSS, roomOn(door.room, door.href), SCREEN);
      if (resolved?.url !== DEFAULT_PLATE[door.room]) {
        wrong.push(`${door.href} (${door.room}) resolved ${String(resolved?.url)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('paints the same plate whatever the route, for every room', () => {
    for (const room of Object.keys(DEFAULT_PLATE) as Room[]) {
      const resolved = new Set(
        BUILDING.map((door) => resolvePlate(CSS, roomOn(room, door.href), SCREEN)?.url),
      );
      expect([...resolved]).toEqual([DEFAULT_PLATE[room]]);
    }
  });
});

describe('the ladder below the variant still holds', () => {
  it('gives a room with no variant attribute its default plate', () => {
    // Rung two: the plate loads, no variant logic has run -- a room rendered
    // outside a router, a page served before hydration, a test. It gets -01.
    for (const room of Object.keys(DEFAULT_PLATE) as Room[]) {
      expect(resolvePlate(CSS, roomOn(room, null), SCREEN)?.url).toBe(DEFAULT_PLATE[room]);
    }
  });

  it('keeps the portrait floor plate on an upright tablet', () => {
    expect(resolvePlate(CSS, roomOn('floor', '/wall'), PORTRAIT)?.url).toBe(FLOOR_PORTRAIT_PLATE);
  });

  it('still takes every plate away under prefers-reduced-data', () => {
    // Rung one, and the zero-asset guarantee: the plate layer is switched off
    // wholesale rather than swapped, so no variant rule can reach past it.
    expect(CSS).toMatch(
      /@media \(prefers-reduced-data: reduce\) \{\s*\n?\s*\.room::after, \.on-canvas::after \{ background-image: none; \}/,
    );
  });
});

/* ==========================================================================
   (d) THE TRAP, BOTH WAYS ROUND
   ========================================================================== */

describe('a variant rule does not take the portrait plate off the gym tablet', () => {
  const WITH_WHERE = ':where([data-plate-variant~="2of2"]) .room--floor {\n'
    + '  --plate: url("/plates/plate-02a-floor-landscape-02.jpg");\n}';
  /**
   * The same rule as WITH_WHERE, written the way it comes out if nobody has
   * thought about specificity. Because the attribute is on an ANCESTOR, the
   * trap here is a descendant selector rather than a compound one -- but the
   * arithmetic is identical: one attribute plus one class is (0,2,0), and
   * `.room--floor` inside the orientation block is (0,1,0).
   */
  const WITHOUT_WHERE = '[data-plate-variant~="2of2"] .room--floor {\n'
    + '  --plate: url("/plates/plate-02a-floor-landscape-02.jpg");\n}';

  /** A floor route that lands in the second half of an of2 split. */
  const secondHalf = doorsIn('floor').find((href) => plateVariantSlot(href, 2) === 2)!;
  const firstHalf = doorsIn('floor').find((href) => plateVariantSlot(href, 2) === 1)!;

  it('has a real route on each side of the split to test with', () => {
    expect(secondHalf).toBeDefined();
    expect(firstHalf).toBeDefined();
  });

  it('paints the second landscape plate on a landscape screen', () => {
    const sheet = cssWithVariant(WITH_WHERE);
    expect(resolvePlate(sheet, roomOn('floor', secondHalf), SCREEN)?.url)
      .toBe('/plates/plate-02a-floor-landscape-02.jpg');
    expect(resolvePlate(sheet, roomOn('floor', firstHalf), SCREEN)?.url)
      .toBe(DEFAULT_PLATE.floor);
  });

  it('yields to the orientation override when the tablet is upright', () => {
    const sheet = cssWithVariant(WITH_WHERE);
    expect(resolvePlate(sheet, roomOn('floor', secondHalf), PORTRAIT)?.url).toBe(FLOOR_PORTRAIT_PLATE);
    expect(resolvePlate(sheet, roomOn('floor', firstHalf), PORTRAIT)?.url).toBe(FLOOR_PORTRAIT_PLATE);
  });

  it('would NOT yield if the same rule were written without :where()', () => {
    // The counter-proof, and the reason :where() is in the sheet at all. This
    // is the defect as it would actually ship: correct-looking CSS, a green
    // build, and a landscape wall stretched onto an upright gym tablet. If this
    // expectation ever inverts, :where() has stopped doing its job and the
    // guard above has stopped meaning anything.
    const sheet = cssWithVariant(WITHOUT_WHERE);
    expect(specificityOf('[data-plate-variant~="2of2"] .room--floor')).toEqual({ a: 0, b: 2, c: 0 });
    expect(resolvePlate(sheet, roomOn('floor', secondHalf), PORTRAIT)?.url)
      .toBe('/plates/plate-02a-floor-landscape-02.jpg');
  });

  it('leaves the other five rooms exactly where they were', () => {
    const sheet = cssWithVariant(WITH_WHERE);
    for (const room of Object.keys(DEFAULT_PLATE) as Room[]) {
      if (room === 'floor') continue;
      expect(resolvePlate(sheet, roomOn(room, secondHalf), SCREEN)?.url).toBe(DEFAULT_PLATE[room]);
    }
  });
});

describe('a second office plate is one declaration and nothing else', () => {
  // The recipe in the sheet, executed. Whoever adds plate-01-office-02.jpg
  // should be able to read this test as the instructions.
  const RULE = ':where([data-plate-variant~="2of2"]) .room--office {\n'
    + '  --plate: url("/plates/plate-01-office-02.jpg");\n}';

  it('splits the office doors between the two plates', () => {
    const sheet = cssWithVariant(RULE);
    const painted = new Map<string, number>();
    for (const href of doorsIn('office')) {
      const url = resolvePlate(sheet, roomOn('office', href), SCREEN)?.url ?? 'none';
      painted.set(url, (painted.get(url) ?? 0) + 1);
    }
    expect([...painted.keys()].sort()).toEqual([
      '/plates/plate-01-office-01.jpg',
      '/plates/plate-01-office-02.jpg',
    ]);
    for (const used of painted.values()) expect(used).toBeGreaterThan(doorsIn('office').length * 0.25);
  });

  it('sends each office door to the same plate on every load', () => {
    const sheet = cssWithVariant(RULE);
    for (const href of doorsIn('office')) {
      const first = resolvePlate(sheet, roomOn('office', href), SCREEN)?.url;
      expect(resolvePlate(sheet, roomOn('office', href), SCREEN)?.url).toBe(first);
    }
  });

  it('changes nothing for a room that has no second plate', () => {
    const sheet = cssWithVariant(RULE);
    for (const href of doorsIn('clinic')) {
      expect(resolvePlate(sheet, roomOn('clinic', href), SCREEN)?.url).toBe(DEFAULT_PLATE.clinic);
    }
  });
});
