import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE FOUNDATION'S MECHANICS ARE A VERBATIM COPY, AND MUST STAY ONE.
 *
 * The visual reset copied the neutral mechanics -- the φ proportions, the type
 * ladder, the spacing and radius scales, the split ratios, the tap floor, the
 * motion durations and easings -- out of the Leather & Brass sheet and into
 * design-system/foundation/ppbf-foundation.css, so they survive the aesthetic
 * being replaced.
 *
 * WHILE BOTH SHEETS LOAD, THAT COPY CAN DRIFT SILENTLY. Phase 1 imports the
 * foundation and then the theme, and the theme still re-exports the legacy
 * archive -- so legacy's copy of each token lands second and WINS. Change a
 * value in the foundation today and nothing happens; change it in the archive
 * and the app changes. Both are wrong, and neither shows up as a failure
 * anywhere else.
 *
 * The damage is deferred rather than absent. The day the theme stops importing
 * the archive, the foundation's values become the live ones -- and every drift
 * accumulated until then lands at once, in a change nobody associates with it.
 * `--t-md` is the kiosk minimum (Law 5) and `--tap` is the touch floor; those
 * two drifting quietly is an accessibility regression waiting for a release.
 *
 * So this checks those two against their minimums in both sheets (see the
 * note above the cases). When the archive is finally dropped, the legacy half
 * goes with it.
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

/* NARROWED 2026-10-02 (OD-2026-10-02-004, OD-2026-10-02-007). This suite used
   to require EVERY token the two sheets share to be equal, which made every
   proportion, spacing step, radius and motion duration unchangeable in one
   sheet without the other -- a pin on the look. Nothing about the look binds
   any more. What stays is the pair this file always named as load-bearing:
   --t-md is the kiosk type minimum and --tap is the touch-target floor (Law 5).

   The contract is the NUMBER, not agreement with the retired sheet. Equality
   alone would let both sheets drop to 40px together and stay green. Both
   sheets are checked because the theme still imports the legacy sheet after
   the foundation, so legacy's copy is the live value today and the
   foundation's becomes live the day that import is dropped. kioskTapFloor and
   kioskTypeFloor prove the tokens reach kiosk controls and text; this proves
   what the tokens are worth. */
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

describe('the two accessibility floors hold their minimum in every sheet that declares them', () => {
  describe.each(SHEETS)('%s', (_name, tokens) => {
    it.each(FLOORS)('%s is at least %spx', (token, minimumPx) => {
      expect(tokens.has(token)).toBe(true);
      expect(px(tokens.get(token))).toBeGreaterThanOrEqual(minimumPx);
    });
  });
});
