import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * NEW WORK MAY NOT REACH FOR THE RETIRED AESTHETIC'S VOCABULARY.
 *
 * Owner direction, 2026-08-23: "Leather & Brass" is no longer PPBF's visual
 * authority. The visual reset moved it behind design-system/current/, so the
 * app can stop being that aesthetic in one line. This guard stops the debt
 * growing back while that replacement is authored.
 *
 * IT TOLERATES WHAT IS ALREADY THERE, DELIBERATELY. The direction is explicit
 * that existing pages keep working and are not converted in this pass, so each
 * family below carries a frozen ceiling measured at the reset. Existing debt
 * passes. One more use fails, and the failure names the file and the token.
 *
 * ---------------------------------------------------------------------------
 * ROOMS ARE COVERED AS OF 2026-08-23, BY OWNER DECISION.
 *
 * They were not, at first: buildingMapRooms.test.ts REQUIRED every route to
 * paint the room its door filed it under, so capping `room--*` here would have
 * left an author with no legal move, and that argument always ends with
 * somebody weakening whichever guard is younger. The owner has since retired
 * rooms as a visual concept, that mandate is gone, and the cap is live.
 *
 * The taxonomy itself is deliberately untouched. `buildingMap.ts` still files
 * every door under a `room:` — as STRUCTURAL METADATA, per the same decision,
 * so a visual reset does not turn into a routing rewrite. What ended is the
 * requirement that a screen render it.
 *
 * WHAT REMAINS UNCOVERED, AND WHY — read before adding to it.
 *
 * `mat-leather`, `mat-brass` and `on-canvas` are still NOT capped here,
 * because guards still REQUIRE them:
 *
 *   - familyPlateGround.test.ts requires family surfaces to stand on
 *     `.on-canvas`.
 *   - wallSurface / darkPanelMaterials / lightGroundVoices assert material
 *     classes on the surfaces that carry them.
 *
 * Those move in here the same way rooms did: when the rule they encode is
 * retired, in the same change that retires it.
 * ---------------------------------------------------------------------------
 */

const WEB = path.resolve(__dirname, '../..');
const SCANNED = [path.join(WEB, 'app'), path.join(WEB, 'components')];
const REPO = path.resolve(WEB, '../..');

/**
 * The alias vocabulary globals.css defines on top of the design system. These
 * are the names the reset direction closes: "new work cannot use the legacy
 * alias vocabulary."
 *
 * They are the safe half of the retired vocabulary precisely because NOTHING
 * mandates them. They are pure convenience aliases -- `--canvas-tan` is only
 * ever `var(--canvas-warm)` -- so a new call site has a legal alternative
 * today: name the token it actually wants.
 *
 * Ceilings measured on main at a2e90771, 2026-08-23. A number here may go
 * DOWN freely as pages are converted; lowering the ceiling to match is the
 * point of the exercise. It may not go up.
 */
const ALIAS_CEILINGS: Readonly<Record<string, number>> = {
  'canvas-tan': 41,
  'canvas-tan-light': 23,
  'canvas-tan-dark': 0,
  black: 71,
  'gray-dark': 41,
  'gray-medium': 0,
  white: 5,
  'white-off': 0,
  'olive-dark': 0,
  'safety-locked': 0,
  'red-highlight': 0,
  'red-blood': 0,
  'skeleton-bg': 0,
  accent: 0,
  'accent-strong': 11,
  'accent-ink': 11,
  'accent-quiet': 0,
  'font-stencil': 0,
};

/**
 * Class-level vocabulary, capped the same way and for the same reason.
 *
 * `room--*` is counted as OCCURRENCES rather than files, because a file that
 * swaps one room for two has grown the debt while keeping its file count. 143
 * across 88 files, measured 2026-08-23 by the same walk this test performs.
 *
 * Measured that way ON PURPOSE. The first figure here was 167, taken from a
 * shell grep that filtered out matching LINES containing "test" rather than
 * test FILES. A ceiling 24 above the real count is slack, and slack is a guard
 * that quietly tolerates the thing it exists to stop -- a deliberate new
 * `room--office` slipped straight through it. A ceiling has to be measured by
 * the code that enforces it.
 *
 * Rooms may leave freely; they may not spread. A screen written from here on
 * does not paint one — buildingMapRooms.test.ts no longer requires it — and
 * this is the assertion that makes that real rather than advisory.
 */
const CLASS_CEILINGS: Readonly<Record<string, number>> = {
  'room--': 143,
};

/**
 * The personality typefaces, retired with the aesthetic by owner decision on
 * 2026-08-23. Their @font-face declarations moved to
 * design-system/legacy/legacy-fonts.css; the .woff2 files stay on disk, since
 * the decision is "archive first, remove only after the new system is
 * integrated and verified."
 *
 * Zero, not a ceiling: no app file names any of them today, so there is no
 * debt to tolerate. Naming one in app source from here on is new work reaching
 * for a retired voice.
 *
 * UnifrakturCook is the FIFTH face. The decision named four, so it was archived
 * with the others as the reading that kept the set coherent -- same folder,
 * same sheet, clinic masthead only -- and flagged rather than decided silently.
 * The owner CONFIRMED it on 2026-08-23: "Yes. Retire UnifrakturCook with the
 * other Leather & Brass personality faces. Keep the font file archived for
 * rollback/reference." So all five are retired and all five .woff2 files stay
 * on disk.
 *
 * The neutral body/data faces are deliberately absent: Roboto Condensed and
 * Geist Mono come through next/font and the same decision preserves them until
 * the new system specifies replacements.
 */
const RETIRED_FACES: readonly string[] = [
  'Alfa Slab One',
  'Oswald',
  'Special Elite',
  'Caveat',
  'UnifrakturCook',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const FILES = SCANNED.flatMap(walk);

describe('the retired aesthetic does not grow back', () => {
  /* Counted per token rather than in one total, so a page that drops six
     --black and adds six --canvas-tan does not read as no change. The two are
     separate debts and they are paid down separately. */
  it.each(Object.entries(ALIAS_CEILINGS))(
    'uses var(--%s) no more than its frozen ceiling',
    (token, ceiling) => {
      const pattern = new RegExp(`var\\(--${token}\\)`, 'g');
      const hits: string[] = [];

      for (const file of FILES) {
        const found = readFileSync(file, 'utf8').match(pattern);
        if (found) {
          hits.push(`${path.relative(REPO, file)} x${found.length}`);
        }
      }

      const total = hits.reduce(
        (sum, entry) => sum + Number(entry.slice(entry.lastIndexOf('x') + 1)),
        0,
      );

      // The message carries the files, because a bare count tells whoever is
      // red nothing about where to look.
      expect(
        total <= ceiling
          ? true
          : `var(--${token}) used ${total} times, ceiling is ${ceiling}. In:\n  ${hits.join('\n  ')}`,
      ).toBe(true);
    },
  );

  it.each(Object.entries(CLASS_CEILINGS))(
    'uses the %s class no more than its frozen ceiling',
    (token, ceiling) => {
      const pattern = new RegExp(token.replace(/[-]/g, '\\$&'), 'g');
      const hits: string[] = [];

      for (const file of FILES) {
        // Test files name these classes in order to assert about them, which
        // is not the app wearing the aesthetic.
        if (/\.test\.tsx?$/.test(file)) continue;
        const found = readFileSync(file, 'utf8').match(pattern);
        if (found) {
          hits.push(`${path.relative(REPO, file)} x${found.length}`);
        }
      }

      const total = hits.reduce(
        (sum, entry) => sum + Number(entry.slice(entry.lastIndexOf('x') + 1)),
        0,
      );

      expect(
        total <= ceiling
          ? true
          : `${token} used ${total} times, ceiling is ${ceiling}. In:\n  ${hits.join('\n  ')}`,
      ).toBe(true);
    },
  );

  it.each(RETIRED_FACES)('does not name the retired typeface %s', (face) => {
    const hits: string[] = [];

    for (const file of FILES) {
      if (/\.test\.tsx?$/.test(file)) continue;
      // Comments are stripped first. app/layout.tsx explains in prose which
      // faces ride in through which mechanism, and a guard that cannot tell
      // an explanation from a dependency reports four violations where there
      // is one binding -- then gets an allowlist, and the allowlist is what
      // eventually hides a real one.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (code.includes(face)) {
        hits.push(path.relative(REPO, file));
      }
    }

    expect(
      hits.length === 0
        ? true
        : `"${face}" is retired but named in:\n  ${hits.join('\n  ')}`,
    ).toBe(true);
  });

  /* THE ONE LIVE BINDING, recorded rather than removed.
     app/layout.tsx loads oswald-var.woff2 through next/font as
     --font-tactical-display, which globals.css reads for --font-stencil and
     --font-ui. That is a real rendering dependency, not a mention, and cutting
     it now would change how the app looks.

     The owner ruled on this directly, 2026-08-23: "Do NOT remove the remaining
     live Oswald binding yet. Replace that only when the new approved visual
     system supplies its display typography and the replacement can be
     verified." Verified is the operative word -- this repository has no
     screenshot baselines, so a font swap cannot be checked here at all.

     So it is pinned instead. This test fails if the binding moves or
     multiplies, and it is the line to delete when the new system supplies its
     own display face and someone can look at the result. */
  it('keeps the retired display face to exactly one recorded binding', () => {
    const bindings: string[] = [];

    for (const file of FILES) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const found = readFileSync(file, 'utf8').match(/oswald-var\.woff2/g);
      if (found) bindings.push(`${path.relative(REPO, file)} x${found.length}`);
    }

    expect(bindings).toEqual(['apps/web/app/layout.tsx x1']);
  });

  /* The seam only works if everything goes through it. A sheet or a component
     that imports the archive directly re-welds the aesthetic to whatever
     imports it, which is the exact architecture the reset removed. */
  it('is imported by nothing except the current theme', () => {
    const offenders: string[] = [];

    const roots = [
      path.join(REPO, 'design-system'),
      path.join(WEB, 'app'),
      path.join(WEB, 'components'),
      path.join(WEB, 'src'),
    ];

    const walkAny = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walkAny(full));
        else if (/\.(css|tsx?|mjs)$/.test(full)) out.push(full);
      }
      return out;
    };

    for (const root of roots) {
      for (const file of walkAny(root)) {
        const relative = path.relative(REPO, file);

        // The theme is the seam and is supposed to import it.
        if (relative === 'design-system/current/ppbf-theme.css') {
          continue;
        }

        /* An `@import` is what welds the aesthetic to the importer -- it makes
           those rules apply wherever the importing sheet applies. READING the
           file is a different act entirely and is legitimate: build-manifest
           parses it to build the showroom manifest, foundationMatchesLegacy
           parses it to compare token values, and this guard names the path in
           order to forbid it. Matching the bare path would flag all three and
           grow an allowlist that eventually swallows a real offender. */
        if (/@import\s+(?:url\()?["'][^"']*legacy\/ppbf-leather-brass\.css/.test(
          readFileSync(file, 'utf8'),
        )) {
          offenders.push(relative);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
