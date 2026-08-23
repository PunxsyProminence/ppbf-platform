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
 * WHAT THIS GUARD DOES NOT COVER, AND WHY — read before adding to it.
 *
 * `room--*`, `mat-leather`, `mat-brass` and `on-canvas` are NOT guarded here,
 * even though they are unmistakably Leather & Brass vocabulary and the reset
 * direction named them. Guarding them today would contradict guards that
 * currently REQUIRE them:
 *
 *   - buildingMapRooms.test.ts fails when a route does not paint the room its
 *     door in buildingMap.ts files it under. A new page MUST paint a room.
 *   - roomBaseClass.test.ts fails when `.room--X` appears without `.room`.
 *   - familyPlateGround.test.ts requires family surfaces to stand on
 *     `.on-canvas`.
 *   - wallSurface / darkPanelMaterials / lightGroundVoices assert material
 *     classes on the surfaces that carry them.
 *
 * So a new page cannot be written without them. Two controls pulling opposite
 * ways is worse than one control with an honest boundary: the author would
 * have no legal move, and the usual resolution to that is that somebody
 * weakens whichever guard is younger — this one.
 *
 * The room taxonomy is also not purely aesthetic. `buildingMap.ts` files every
 * door under a `room:`, so it is part of the navigation registry as well as
 * the look. Retiring the materials while keeping the taxonomy is an owner
 * decision, recorded in docs/VISUAL-RESET-PHASE-1-PLAN.md §11. When it is
 * made, those families move in here and the mandating guards change together,
 * in one reviewable step.
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
