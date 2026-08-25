import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * WHAT A COACH CAN ACTUALLY READ ON THE FLOOR BOARD, AND WHERE THE FOCUS IS.
 *
 * THE MEASUREMENT THIS FILE DEFENDS. On 2026-08-25 the six merged golden-era
 * scopes were audited in real Chromium at both playwright.config.ts viewports:
 * every text-bearing element was collected with getComputedStyle, then the page
 * was screenshotted with every measured run set to `color: transparent` and the
 * pixels UNDER THE GLYPH BAND were sampled. 622 pairings, 133 distinct; the
 * failures clustered on `.ge-floorboard`, and every one of them was invisible
 * to a cascade-reading check.
 *
 * WHY A CASCADE-READING CHECK MISSED THEM. `.mat-leather--raised` declares
 * `background-color: var(--hide-700)` (#3B2C21) and then paints a warm radial
 * over it with `background-blend-mode: … screen …`. The top-left of a tile --
 * where an eyebrow sits -- PAINTS around #7F6346, roughly two rungs lighter
 * than the colour the sheet names. So `.t-eyebrow` "reads" 7.27:1 from the
 * cascade and measured 3.02:1 to 3.21:1 on the screen; the roster ring name
 * "read" 5.39:1 and measured 2.98:1; the pain report's own field labels
 * measured 3.49:1 on the phone. Those are the labels over a coach's readiness
 * alert count, over an injury flag, and over a child's reported pain.
 *
 * SO THIS FILE PINS THE TWO STRUCTURAL FACTS THE FIX RESTS ON, NOT A RATIO.
 * A ratio recomputed here would be the same fiction the cascade told: nothing
 * in Jest can screen-blend a radial. What Jest can do is hold the ink and the
 * ground where the browser said they had to be, in RUNGS rather than hexes, so
 * a palette retune moves them together and a revert cannot pass quietly.
 *
 *   1. THE GROUND. Every stop of the tile gradient inside `.ge-floorboard`
 *      resolves no lighter than `--hide-800`. The legacy literals it replaced
 *      (#4B382A / #34271D / #241B14) sit two rungs above that, which is what
 *      put the painted sheen two rungs too high. The ceiling is --hide-800 and
 *      not --hide-700 because the one-rung version was built and MEASURED
 *      first: it left the tile eyebrows at 4.49:1 and the roster ring name at
 *      4.47:1, both a hair under the 4.5:1 line.
 *   2. THE INK. Every voice the audit lifted resolves no darker than the rung
 *      it was lifted to. `--bone-400` takes `--bone-300`; the eyebrow mix and
 *      brass-as-ink on a tile take `--brass-200`.
 *
 * AND THE THIRD FINDING, WHICH WAS NOT ABOUT COLOUR AT ALL. `.btn:focus-
 * visible` carries the entire focus indicator for this app in its BOX-SHADOW
 * (`outline: 0; box-shadow: var(--focus), …`) at specificity (0,2,0). Five
 * golden-era scope rules override `box-shadow` on the same controls at the
 * same or greater weight and are imported later, so they won the tie and took
 * the indicator away while leaving `outline: 0` standing. Measured: Tab landed
 * on The Bell's "Continue With Microsoft", on the floor board's "Acknowledge"
 * (the escalation inbox), on /coach/drills' every field, and the screenshots
 * before and after focus were BYTE-IDENTICAL. Isolated by removing the scope
 * class in the live page, which brought the ring straight back.
 *
 * The focus check below is DERIVED, not listed: it finds every golden-era rule
 * that overrides box-shadow on something focusable and requires that scope to
 * restate the ring. A pinned list would be a second place to forget.
 *
 * MUTATION CHECK: put `#4B382A` back in the tile gradient, or `--bone-400`
 * back to the leather rung, or `--brass-300` back on a tile's ink, or delete
 * one `:focus-visible` companion -- each turns this suite red and names the
 * surface and the measured ratio.
 */

const CSS = readDesignSystemCss(DESIGN_SYSTEM_ENTRY).replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------------------------------------------------------- COLOUR MATHS -- */

function channels(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/* ------------------------------------------------------------- CSS READING -- */

/** Every `selectorList { body }` pair in the resolved sheet, in source order. */
function rules(): Array<{ selectors: string; body: string }> {
  const found: Array<{ selectors: string; body: string }> = [];
  for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.push({ selectors: match[1].trim().replace(/\s+/g, ' '), body: match[2] });
  }
  return found;
}

const RULES = rules();

/** The last declaration of `property` in any rule whose selector list matches
    `selector` exactly, since later wins among equal selectors. */
function declaration(selector: string, property: string): string | null {
  let value: string | null = null;
  for (const rule of RULES) {
    if (rule.selectors !== selector) continue;
    const match = rule.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (match) value = match[1].trim();
  }
  return value;
}

/** Custom properties declared OUTSIDE any `.ge-*` scope: the base ramps. */
function baseTokens(): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of RULES) {
    if (/\.ge-[a-z]+/.test(rule.selectors)) continue;
    for (const match of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
      found.set(match[1], match[2].trim());
    }
  }
  return found;
}

/** Custom properties declared on the bare `.<scope>` class rule(s). */
function scopeTokens(scope: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of RULES) {
    if (rule.selectors !== `.${scope}`) continue;
    for (const match of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
      found.set(match[1], match[2].trim());
    }
  }
  return found;
}

const BASE = baseTokens();

/**
 * Resolve a colour expression to a hex, inside a scope.
 *
 * Handles the three forms this sheet actually uses for ink and ground: a hex,
 * a `var(--token)` chain, and `color-mix(in srgb, A p%, B)`. Anything else
 * throws rather than returning a guess -- a guard that silently resolves an
 * expression it does not understand is a guard that reports a colour nobody
 * wrote.
 */
function resolve(expression: string, scope: Map<string, string>, depth = 0): string {
  const value = expression.trim();
  if (depth > 12) throw new Error(`Cannot resolve (cycle?): ${expression}`);

  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value.toUpperCase();

  const varMatch = value.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/i);
  if (varMatch) {
    const name = varMatch[1];
    const declared = scope.get(name) ?? BASE.get(name) ?? varMatch[2];
    if (!declared) throw new Error(`Unknown token ${name}`);
    return resolve(declared, scope, depth + 1);
  }

  const mixMatch = value.match(/^color-mix\(\s*in\s+srgb\s*,\s*(.+)\s*\)$/i);
  if (mixMatch) {
    const parts = splitTop(mixMatch[1]);
    if (parts.length !== 2) throw new Error(`Unsupported color-mix: ${value}`);
    /* [\s\S] rather than . with the /s flag: this repository targets an
       ECMAScript version below es2018, where the dotall flag is a type error. */
    const first = parts[0].match(/^([\s\S]*?)(?:\s+([\d.]+)%)?$/);
    const second = parts[1].match(/^([\s\S]*?)(?:\s+([\d.]+)%)?$/);
    if (!first || !second) throw new Error(`Unsupported color-mix: ${value}`);
    const p1 = first[2] ? Number(first[2]) / 100 : (second[2] ? 1 - Number(second[2]) / 100 : 0.5);
    const a = channels(resolve(first[1], scope, depth + 1));
    const b = channels(resolve(second[1], scope, depth + 1));
    return toHex([0, 1, 2].map((i) => a[i] * p1 + b[i] * (1 - p1)) as [number, number, number]);
  }

  throw new Error(`Unsupported colour expression: ${value}`);
}

/** Split a comma list at the top level, ignoring commas inside parentheses. */
function splitTop(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of input) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim());
}

const FLOORBOARD = scopeTokens('ge-floorboard');

/* ================================================================ GROUND == */

describe('the floor board tile is seated deep enough for its own sheen', () => {
  const SELECTOR = '.ge-floorboard .mat-leather--raised';

  it('reads a real sheet, so nothing below passes on an empty string', () => {
    expect(CSS.length).toBeGreaterThan(10_000);
    expect(RULES.length).toBeGreaterThan(200);
    expect(BASE.get('--hide-700')).toBeDefined();
  });

  it('restates the raised-leather ground inside the scope at all', () => {
    expect(declaration(SELECTOR, 'background-image')).not.toBeNull();
  });

  /* MEASURED, and the reason this rule exists: with the legacy stops the tile
     painted #7F6346 at the eyebrow band and `.t-eyebrow` read 3.02:1 against
     a 4.5:1 requirement. Every stop is checked, not just the first, because
     the gradient is what paints -- the background-color underneath it is
     never seen. */
  it('paints every gradient stop no lighter than --hide-800 (eyebrow measured 3.02:1 on the old stops, 4.49:1 one rung up)', () => {
    const image = declaration(SELECTOR, 'background-image');
    expect(image).not.toBeNull();
    const gradient = (image as string).match(/linear-gradient\(([^;]*)\)\s*$/);
    expect(gradient).not.toBeNull();

    const stops = splitTop((gradient as RegExpMatchArray)[1])
      .slice(1)
      .map((stop) => stop.replace(/\s+[\d.]+%$/, '').trim());
    expect(stops.length).toBeGreaterThan(1);

    const ceiling = luminance(resolve('var(--hide-800)', FLOORBOARD));
    const tooLight = stops
      .map((stop) => ({ stop, hex: resolve(stop, FLOORBOARD) }))
      .filter((entry) => luminance(entry.hex) > ceiling + 1e-9)
      .map((entry) => `${entry.stop} -> ${entry.hex}`);

    expect(tooLight).toEqual([]);
  });
});

/* =================================================================== INK == */

/**
 * Every ink the browser said had to move, with the ratio it measured before it
 * moved and the rung it was moved to. The FLOOR is a rung, never a hex, so a
 * retune of the ramp carries the guard with it instead of pinning a colour.
 */
const LIFTED_INKS: ReadonlyArray<{
  readonly what: string;
  readonly ink: () => string;
  readonly floor: string;
  readonly measured: string;
}> = [
  {
    what: '.ge-floorboard tertiary ink (--bone-400): the session card\'s "no scheduling backend feed" '
      + 'caveat, the pain report\'s "Not stated", "Session Name", the roster\'s "Unknown" attendance, '
      + 'and the masthead\'s "Coach workspace \u00b7 Live session management"',
    ink: () => resolve('var(--bone-400)', FLOORBOARD),
    floor: '--bone-300',
    measured: '2.37:1 (masthead, Pixel 7) to 4.40:1 on the painted ground; 4.5:1 required',
  },
  {
    what: '.ge-floorboard .t-eyebrow: the "Readiness Alerts" / "Injury Flags" / "Open Reviews" tile labels',
    ink: () => resolve(declaration('.ge-floorboard .t-eyebrow', 'color') as string, FLOORBOARD),
    floor: '--brass-200',
    measured: '3.02:1 on the painted tile (4.5:1 required)',
  },
  {
    what: '.ge-floorboard brass spelled as ink at a call site: the pain-report field labels '
      + '("Body location", "Pain type") and the roster ring name',
    ink: () => resolve(
      declaration('.ge-floorboard .mat-leather--raised [class~="text-[color:var(--brass-300)]"]', 'color') as string,
      FLOORBOARD,
    ),
    floor: '--brass-200',
    measured: '2.98:1 (ring name) and 3.49:1 (field labels) on the painted tile (4.5:1 required)',
  },
];

describe('every ink the browser measured as failing stays lifted', () => {
  it('resolves a real ink for each entry, or it is comparing nothing', () => {
    for (const entry of LIFTED_INKS) {
      expect(entry.ink()).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it.each(LIFTED_INKS.map((e) => [e.what, e] as const))(
    'is no darker than its rung — %s',
    (_what, entry) => {
      const ink = entry.ink();
      const floor = resolve(`var(${entry.floor})`, FLOORBOARD);
      const lifted = luminance(ink) >= luminance(floor) - 1e-9;
      /* Reported as a value rather than a bare boolean so the failure prints
         WHICH line a coach loses and what it measured, not `false !== true`. */
      expect(lifted ? 'lifted' : `${entry.what}\n  measured ${entry.measured}\n`
        + `  ink resolves to ${ink}, which is darker than ${entry.floor} (${floor})`).toBe('lifted');
    },
  );
});

/* ================================================================= FOCUS == */

/** Selectors that can hold focus, as this sheet spells them. */
const FOCUSABLE = /(^|\s|>)(\.btn(--[a-z]+)?|\.input|\.select|\.textarea|button|input|select|textarea|summary|a)(\b|:|\.|\[)/;

/** A selector's compound list: `.ge-floorboard .mat-leather button` -> three. */
function compounds(selector: string): string[] {
  return selector.trim().split(/\s+(?![^[]*\])/).filter((part) => part !== '>' && part !== '+' && part !== '~');
}

/**
 * Does the focus rule `f` answer the overriding rule `r`?
 *
 * Same compound chain, with one allowance: `r` may end in a bare element
 * (`button`) where `f` ends in a class (`.btn`). That is not a loophole, it is
 * the shape of the real repair -- `.ge-floorboard .mat-leather button` catches
 * every control in the panel, but only the `.btn` ones lost their ring (the
 * plaques are not `.btn`, so `outline: 0` never applied to them), and ringing
 * the plaques as well would leave them wearing two.
 */
function answers(f: string, r: string): boolean {
  const a = compounds(f.replace(/:focus(-visible)?/g, ''));
  const b = compounds(r);
  if (a.length !== b.length) return false;
  return a.every((part, index) => {
    if (part === b[index]) return true;
    const last = index === a.length - 1;
    return last && /^[a-z]+$/.test(b[index]) && part.startsWith('.');
  });
}

describe('a golden-era rule that overrides box-shadow on a control restates its focus ring', () => {
  /* The whole finding in one sentence: `.btn:focus-visible` puts the entire
     indicator in box-shadow at (0,2,0), so ANY later scope rule of equal or
     greater weight that sets box-shadow on the same control silently deletes
     the ring -- and `outline: 0` from that same base rule stays in force, so
     nothing at all is drawn. Derived rather than listed so the next scope
     cannot forget, and checked PER SELECTOR rather than per scope: the first
     version of this asked only whether the scope restated a ring somewhere,
     and deleting the drill case's field rule left it green because the drill
     case's button rule still answered. */
  const overriding = RULES
    .filter((rule) => {
      if (/:focus/.test(rule.selectors)) return false;
      if (/::(before|after)/.test(rule.selectors)) return false;
      return /(?:^|;)\s*box-shadow\s*:/.test(rule.body);
    })
    .flatMap((rule) => splitTop(rule.selectors))
    .filter((selector) => /\.ge-[a-z]+/.test(selector) && FOCUSABLE.test(selector));

  /**
   * Does this rule body actually PAINT a ring?
   *
   * `var(--focus)` is the sheet's own token and the usual answer, but it is not
   * the only legitimate one: `.ge-bell .input--kiosk:focus` draws its own
   * parchment halo (`0 0 0 3px color-mix(…)`) and the browser probe confirmed
   * a visible indicator there. So the test asks for an OUTER ring -- a
   * non-inset spread shadow, or a real outline -- rather than for one token.
   * (How strong that ring is, is a rendered question this file cannot answer;
   * the audit measured each one and the weak ones are on the PR.)
   */
  function paintsRing(body: string): boolean {
    if (/var\(--focus\)/.test(body)) return true;
    const shadow = body.match(/(?:^|;)\s*box-shadow\s*:\s*([^;]+)/);
    if (shadow && splitTop(shadow[1]).some((layer) => (
      !/\binset\b/.test(layer) && /\b0\s+0\s+0\s+[\d.]+(px|rem|em)/.test(layer)
    ))) return true;
    return /(?:^|;)\s*outline\s*:\s*(?!0\b|none\b)[^;]*[\d.]+(px|rem|em)/.test(body);
  }

  const ringRules = RULES
    .filter((rule) => /:focus(-visible)?/.test(rule.selectors) && paintsRing(rule.body))
    .flatMap((rule) => splitTop(rule.selectors));

  it('finds the scope selectors that override a control box-shadow at all', () => {
    expect(overriding.length).toBeGreaterThan(5);
    expect(ringRules.length).toBeGreaterThan(3);
  });

  /**
   * Selectors that override a control's box-shadow and are NOT owed a ring,
   * each with the reason. Recorded in the shape lightGroundVoices.test.ts
   * records its exemptions: the list is decisions, and anything not on it is
   * owed an answer.
   *
   * All three are plain `<button>` rather than `.btn`, so the base sheet's
   * `outline: 0` never applied to them and they keep the outline ring the
   * sheet gives every focusable. The browser probe measured a visible
   * indicator on each, on both viewports.
   */
  const NOT_OWED: Record<string, string> = {
    '.ge-floorboard [role="tablist"] button': 'tab plaque — plain <button>, keeps the sheet outline ring (measured visible)',
    '.ge-floorboard .mat-leather button[aria-current="page"]': 'active tab plaque — same, and the .btn companion must not double-ring it',
    '.ge-frontoffice nav.mat-leather button': 'people-console tab — plain <button>, measured visible at 2.6:1 on both viewports',
  };

  const owed = [...new Set(overriding)].filter((selector) => !(selector in NOT_OWED)).sort();

  it('has a non-trivial set of selectors owing a ring', () => {
    expect(owed.length).toBeGreaterThan(4);
  });

  it.each(owed)(
    '%s restates var(--focus) on its own focus selector (Tab measured byte-identical without it)',
    (selector) => {
      const answered = ringRules.some((ring) => answers(ring, selector));
      if (!answered) {
        throw new Error(
          `${selector} overrides box-shadow on a control, which defeats \`.btn:focus-visible\`\n`
          + '  (and .input:focus / .select:focus / .textarea:focus, which work the same way).\n'
          + '  Measured: the control took focus with the screen BYTE-IDENTICAL — no indicator at all.\n'
          + `  Add \`${selector}:focus-visible\` (or \`:focus\` for a field) carrying var(--focus).`,
        );
      }
      expect(answered).toBe(true);
    },
  );

  /* An exemption for a selector that no longer overrides anything is a stale
     decision, and a stale decision reads as a considered one. */
  it('carries no exemption for a selector that overrides nothing', () => {
    expect(Object.keys(NOT_OWED).filter((selector) => !overriding.includes(selector))).toEqual([]);
  });
});
