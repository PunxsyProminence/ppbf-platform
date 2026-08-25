import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * A BRASS RUNG MAY NOT BE SPELLED AS A LITERAL.
 *
 * THE LEAK THIS EXISTS TO PREVENT. The golden-era work re-skins a surface by
 * redefining the brass ramp on one scope class -- `.ge-bell`, `.ge-scheduler`
 * and so on. Custom properties inherit, so every shared component inside that
 * scope that resolves `var(--brass-500)` becomes bronze at once, and nothing
 * outside the scope moves. That is the whole leak-proof argument, and it has
 * exactly one hole: it only reaches rules that go THROUGH a token.
 *
 * A rule that spells the colour out -- `rgba(212,175,74,.42)` -- has no token
 * in it. No scope can override it. It paints legacy gold inside a golden-era
 * room and there is no property anyone forgot; the override is simply not
 * reachable. This was not hypothetical: a browser probe of `.ge-frontoffice`
 * found its buttons resolving a `rgba(212, 175, 74, 0.42)` border while the
 * very same element correctly resolved `--brass-500` as bronze. Forty-six
 * rules across the legacy sheet were spelled that way, on the most shared
 * furniture in the app -- the focus ring, every input border, every ghost
 * button, the inset top-light on every tile, and the whole jump palette.
 *
 * THE FIX THOSE RULES NOW CARRY. CSS cannot unpack a hex into channels, so
 * each rung also ships an unpacked triple (`--brass-400-rgb: 212 175 74`) and
 * the alpha rules read `rgb(var(--brass-400-rgb) / .42)`. Outside a scope the
 * triple is the colour it always was -- a whole-page computed-style
 * fingerprint over four legacy surfaces was byte-identical before and after
 * the conversion -- and inside a scope it finally follows the scope.
 *
 * WHAT THIS GUARD CHECKS, AND WHY EACH PART IS HERE.
 *
 *   1. Each triple matches its own hex. The triple is stated, not derived,
 *      so a typo would silently paint a colour nobody chose. Checked by
 *      arithmetic against the hex, not against a second hardcoded list.
 *   2. No brass literal appears anywhere outside its own token declaration.
 *      This is the rule that keeps the hole shut: re-adding
 *      `rgba(232,206,122,.14)` to any sheet fails here.
 *   3. A scope that redefines a rung redefines its triple too. This is the
 *      forward-looking half. Every golden-era scope redefines the ramp; a
 *      scope that redefines `--brass-400` and forgets `--brass-400-rgb`
 *      re-opens the leak for that surface only, which is precisely the kind
 *      of per-surface drift that is invisible until someone looks at the
 *      deployed page.
 *
 * COMMENTS ARE STRIPPED FIRST. A comment is not a rule, and this file's own
 * explanation quotes the literal it bans.
 */

const APP_GLOBALS = path.resolve(__dirname, '../../app/globals.css');

/** The legacy ramp, as the sheet declares it. Stated once here so the checks
 *  below derive everything else -- channels included -- by arithmetic. */
const RUNGS: ReadonlyArray<readonly [number, string]> = [
  [900, '#4A340B'],
  [800, '#6B4E12'],
  [700, '#8C6B1F'],
  [600, '#A98126'],
  [500, '#B8912F'],
  [400, '#D4AF4A'],
  [300, '#E8CE7A'],
  [200, '#F2E2A8'],
];

/**
 * Sites that still spell a brass literal, each named with the reason it is
 * not this guard's to fix. An entry is a substring matched against the
 * comment-stripped line; it must be specific enough that it cannot swallow a
 * new violation elsewhere.
 *
 * KEEPING THIS LIST SHORT IS THE POINT. Every entry is a place a scope cannot
 * reach, so every entry is a small hole in the leak-proof argument. Nothing
 * belongs here that a token could simply fix.
 */
const ALLOW_LIST: ReadonlyArray<{ readonly line: string; readonly why: string }> = [];

function isAllowed(line: string): boolean {
  return ALLOW_LIST.some((entry) => line.includes(entry.line));
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function channelsOf(hex: string): readonly [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

const DESIGN_CSS = stripComments(readDesignSystemCss(DESIGN_SYSTEM_ENTRY));
const GLOBALS_CSS = stripComments(readDesignSystemCss(APP_GLOBALS));
const ALL_CSS = `${DESIGN_CSS}\n${GLOBALS_CSS}`;

describe('the brass ramp is reachable through tokens, never spelled as a literal', () => {
  test('the sheet actually still declares the ramp (this guard is not reading an empty string)', () => {
    // readDesignSystemCss resolving to nothing would make every check below
    // pass vacuously. Prove there is a sheet here before trusting the rest.
    expect(DESIGN_CSS.length).toBeGreaterThan(10_000);
    for (const [rung] of RUNGS) {
      expect(ALL_CSS).toMatch(new RegExp(`--brass-${rung}\\s*:`));
      expect(ALL_CSS).toMatch(new RegExp(`--brass-${rung}-rgb\\s*:`));
    }
  });

  test.each(RUNGS)('any var(--brass-%s-rgb, …) fallback carries that rung’s own channels', (rung, hex) => {
    // A fallback is how the foundation stays independent of the theme: with
    // no theme loaded the token does not exist and the fallback is what
    // paints. That makes the fallback a second place the colour is written
    // down, and a second place it can be written down WRONG -- silently, and
    // only visible in the one configuration nobody renders. So it is checked
    // against the hex exactly as the triple itself is.
    const wrong: string[] = [];
    const pattern = new RegExp(`var\\(\\s*--brass-${rung}-rgb\\s*,\\s*([^)]+?)\\s*\\)`, 'g');
    for (const [, fallback] of ALL_CSS.matchAll(pattern)) {
      const channels = fallback.trim().split(/[\s,]+/).map(Number);
      if (channels.length !== 3 || channels.some(Number.isNaN)) {
        wrong.push(`unreadable fallback "${fallback}"`);
        continue;
      }
      if (channels.join(' ') !== channelsOf(hex).join(' ')) {
        wrong.push(`fallback "${fallback}" is not ${hex} (${channelsOf(hex).join(' ')})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('every allow-list entry still matches a real line', () => {
    // A stale exemption is how an allow-list turns into a blanket. If the
    // site it names is gone, the defect was fixed and the entry must go with
    // it -- otherwise the next violation that happens to contain the same
    // substring is waved through by an entry nobody remembers.
    for (const entry of ALLOW_LIST) {
      expect({ line: entry.line, found: ALL_CSS.includes(entry.line) }).toEqual({
        line: entry.line,
        found: true,
      });
    }
  });

  test.each(RUNGS)('--brass-%s-rgb carries exactly the channels of its own hex', (rung, hex) => {
    const declared = new RegExp(`--brass-${rung}-rgb\\s*:\\s*([0-9]+)\\s+([0-9]+)\\s+([0-9]+)\\s*;`).exec(ALL_CSS);
    expect(declared).not.toBeNull();

    const actual = [Number(declared![1]), Number(declared![2]), Number(declared![3])];
    expect(actual).toEqual([...channelsOf(hex)]);
  });

  test.each(RUNGS)('no rule spells brass-%s as a literal instead of using its token', (rung, hex) => {
    const [r, g, b] = channelsOf(hex);
    const offenders: string[] = [];

    // The hex, anywhere it is not this rung's own declaration.
    for (const line of ALL_CSS.split('\n')) {
      if (!new RegExp(hex, 'i').test(line)) continue;
      if (new RegExp(`--brass-${rung}\\s*:\\s*${hex}`, 'i').test(line)) continue;
      if (isAllowed(line)) continue;
      offenders.push(line.trim());
    }

    // The rgb()/rgba() spelling of the same colour, anywhere at all. The
    // token form is `rgb(var(--brass-N-rgb) / a)` and carries no bare
    // channels, so any bare-channel match here is a literal.
    for (const line of ALL_CSS.split('\n')) {
      if (!new RegExp(`rgba?\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}\\s*[,)]`, 'i').test(line)) continue;
      if (isAllowed(line)) continue;
      offenders.push(line.trim());
    }

    expect(offenders).toEqual([]);
  });

  test('every scope that redefines a rung redefines its channel triple too', () => {
    // Split into declaration blocks. A block is `selector { ... }`; nested
    // at-rules are flattened by the split, which is fine here because the
    // question is only ever "do these two declarations sit together".
    const blocks = ALL_CSS.split('}');
    const failures: string[] = [];

    for (const block of blocks) {
      const brace = block.indexOf('{');
      if (brace === -1) continue;
      const selector = block.slice(0, brace).split('\n').pop()!.trim();
      const body = block.slice(brace + 1);

      for (const [rung] of RUNGS) {
        const hasHex = new RegExp(`--brass-${rung}\\s*:`).test(body);
        const hasRgb = new RegExp(`--brass-${rung}-rgb\\s*:`).test(body);
        if (hasHex && !hasRgb) {
          failures.push(
            `${selector} redefines --brass-${rung} but not --brass-${rung}-rgb: ` +
              `alpha rules in this scope will keep painting the inherited colour.`,
          );
        }
        if (hasRgb && !hasHex) {
          failures.push(
            `${selector} redefines --brass-${rung}-rgb but not --brass-${rung}: ` +
              `solid and alpha uses of the same rung would disagree.`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
