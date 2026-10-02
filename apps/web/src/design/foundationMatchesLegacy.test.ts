import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THREE ACCESSIBILITY FLOORS, CHECKED IN BOTH SHEETS THAT DECLARE THEM.
 *
 * The file keeps its old name. Until 2026-10-02 it required the foundation's
 * mechanics to be a verbatim copy of the Leather & Brass sheet, token for
 * token. That is no longer the contract: nothing about the look binds
 * (OD-2026-10-02-004, OD-2026-10-02-007), so proportions, spacing, radii and
 * motion may differ between the sheets or change in both. There is no general
 * equality here any more.
 *
 * What is checked:
 *   --tap    the touch-target floor, at least 55px (Law 5);
 *   --t-md   the kiosk type minimum, at least 19.1px (Law 5);
 *   --focus  a keyboard focus ring that actually paints.
 *
 * WHY BOTH SHEETS. design-system/ppbf.css imports the foundation and then the
 * theme, and the theme still imports the legacy sheet, so legacy's copy of
 * each token lands second and is the live value today. The day that import is
 * dropped the foundation's copy becomes live. Either sheet falling below a
 * floor is therefore a regression now or a regression waiting for that day.
 * When the legacy sheet is finally dropped, its half of these cases goes with
 * it.
 *
 * kioskTapFloor and kioskTypeFloor prove the tokens reach kiosk controls and
 * text. This file proves what the tokens are worth.
 */

const REPO = path.resolve(__dirname, '../../../..');
const FOUNDATION = path.join(REPO, 'design-system/foundation/ppbf-foundation.css');
const LEGACY = path.join(REPO, 'design-system/legacy/ppbf-leather-brass.css');

/** Every custom property and its value, last definition winning, as the
 *  cascade would resolve within a single file. */
function tokensIn(file: string): Map<string, string> {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Map<string, string>();
  for (const [, name, value] of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    found.set(name, value.trim().replace(/\s+/g, ' '));
  }
  return found;
}

const foundation = tokensIn(FOUNDATION);
const legacy = tokensIn(LEGACY);

/* The contract is the NUMBER, not agreement with the retired sheet: equality
   alone would let both sheets drop to 40px together and stay green. */
const FLOORS: Array<[token: string, minimumPx: number]> = [
  ['--t-md', 19.1],
  ['--tap', 55],
];

const SHEETS: Array<[name: string, tokens: Map<string, string>]> = [
  ['foundation', foundation],
  ['legacy', legacy],
];

function px(value: string | undefined): number {
  const match = value?.match(/^(\d+(?:\.\d+)?)px$/);
  // A floor stated in anything but px cannot be compared here; fail loudly
  // rather than pass on a value this test cannot read.
  return match ? Number(match[1]) : Number.NaN;
}

describe('the two size floors hold their minimum in every sheet that declares them', () => {
  describe.each(SHEETS)('%s', (_name, tokens) => {
    it.each(FLOORS)('%s is at least %spx', (token, minimumPx) => {
      expect(tokens.has(token)).toBe(true);
      expect(px(tokens.get(token))).toBeGreaterThanOrEqual(minimumPx);
    });
  });
});

/* THE FOCUS RING IS THE THIRD FLOOR. Every .btn and field draws its only focus
   indicator from --focus and sets `outline: 0` beside it, so a --focus that
   paints nothing leaves keyboard focus invisible app-wide (WCAG 2.4.7). The
   old every-token equality covered this by accident; this covers it on
   purpose.

   It asserts that a ring PAINTS, never what colour it is: a box-shadow spread
   of at least 2px in a colour that is not `transparent` and does not carry an
   alpha of zero. Where the colour is read through a channel-triple token, the
   triple must be in a form rgb() can parse, because a malformed triple
   invalidates the whole box-shadow. */
function paintsARing(focus: string | undefined, tokens: Map<string, string>): boolean {
  const ring = (focus ?? '').match(/^0 0 0 (\d+(?:\.\d+)?)px\s+(.+)$/);
  if (!ring) return false;
  if (Number(ring[1]) < 2) return false;

  const colour = ring[2].trim();
  if (/^transparent$/i.test(colour)) return false;
  if (/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(colour)) return false;

  // Alpha, in either spelling: `rgb(R G B / A)` or `rgba(R, G, B, A)`.
  const alpha = colour.match(/\/\s*([\d.]+%?)\s*\)\s*$/) ?? colour.match(/^(?:rgba|hsla)\([^)]*,\s*([\d.]+%?)\s*\)$/i);
  if (alpha && parseFloat(alpha[1]) === 0) return false;

  // Every channel triple the colour reads must be three space-separated
  // integers, both where it is declared and in the var() fallback.
  for (const [, name, fallback] of colour.matchAll(/var\((--[a-z0-9-]+-rgb)(?:\s*,\s*([^)]+))?\)/g)) {
    const triple = /^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/;
    const declared = tokens.get(name);
    if (declared !== undefined && !triple.test(declared)) return false;
    if (declared === undefined && !(fallback && triple.test(fallback.trim()))) return false;
  }
  return true;
}

describe('keyboard focus stays visible in every sheet that declares --focus', () => {
  it.each(SHEETS)('%s: --focus paints a ring', (_name, tokens) => {
    expect(paintsARing(tokens.get('--focus'), tokens)).toBe(true);
  });

  /* NEGATIVE CONTROLS. Each of these is a --focus that paints nothing, or too
     little, and each must be refused -- otherwise the case above is satisfied
     by any string that happens to start with a spread. */
  const good = new Map([['--brass-400-rgb', '212 175 74']]);
  it.each([
    ['none', 'none'],
    ['an empty value', ''],
    ['a 1px spread', '0 0 0 1px rgb(212 175 74 / .55)'],
    ['transparent', '0 0 0 3px transparent'],
    ['an explicit alpha of 0', '0 0 0 3px rgb(212 175 74 / 0)'],
    ['a legacy rgba alpha of 0', '0 0 0 3px rgba(212, 175, 74, 0)'],
    ['a zero-alpha hex', '0 0 0 3px #d4af4a00'],
    ['a token alpha of 0', '0 0 0 3px rgb(var(--brass-400-rgb, 212 175 74) / 0)'],
  ])('refuses %s', (_label, value) => {
    expect(paintsARing(value, good)).toBe(false);
  });

  it('refuses a ring whose colour triple rgb() cannot parse', () => {
    const malformed = new Map([['--brass-400-rgb', '212, 175, 74']]);
    expect(paintsARing('0 0 0 3px rgb(var(--brass-400-rgb, 212 175 74) / .55)', malformed)).toBe(false);
  });

  it('refuses a ring whose triple is undeclared and whose fallback cannot be parsed', () => {
    expect(paintsARing('0 0 0 3px rgb(var(--brass-400-rgb, 212,175,74) / .55)', new Map())).toBe(false);
  });

  it('accepts rings of any colour, so this never pins the look', () => {
    expect(paintsARing('0 0 0 2px #00f', new Map())).toBe(true);
    expect(paintsARing('0 0 0 4px rgb(10 200 90 / .4)', new Map())).toBe(true);
    expect(paintsARing('0 0 0 3px rgb(var(--brass-400-rgb, 212 175 74) / .55)', good)).toBe(true);
  });
});
