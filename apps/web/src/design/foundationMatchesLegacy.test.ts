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
 * So this compares them token by token. It is not asserting any particular
 * value -- it does not care whether --s4 is 13px -- only that the two files
 * agree about it. When the archive is finally dropped, this test goes with it.
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

/* The mechanics the foundation claims. Derived from the foundation itself
   rather than hardcoded, so a token added there is covered automatically --
   the failure mode this guards against is a value changing, not the list
   being wrong. */
const COPIED = [...foundation.keys()].filter((token) => legacy.has(token));

describe('the foundation has not drifted from the sheet it was copied out of', () => {
  it('copied a non-trivial number of tokens, so this test is actually testing something', () => {
    // A rename or a bad path would make COPIED empty, and an empty it.each
    // passes silently -- the exact way a guard stops guarding without anyone
    // noticing. 40 is comfortably below the ~47 copied and comfortably above
    // any accident.
    expect(COPIED.length).toBeGreaterThan(40);
  });

  it('carries the load-bearing accessibility figures', () => {
    // Named individually because these two are not merely mechanics: --t-md is
    // the kiosk type minimum (Law 5) and --tap is the touch-target floor. If a
    // future edit narrows what the foundation owns, these must not be what
    // quietly leaves.
    expect(COPIED).toContain('--t-md');
    expect(COPIED).toContain('--tap');
  });

  it.each(COPIED)('%s has the same value in both sheets', (token) => {
    expect(foundation.get(token)).toBe(legacy.get(token));
  });
});
