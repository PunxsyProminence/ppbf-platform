import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * LEGACY MAY NOT SNEAK INTO A GOLDEN-ERA SURFACE.
 *
 * The visual migration is per-page: a surface opts into the golden era by
 * adding the `theme-golden` scope class, and the rest of the app stays on the
 * retired "Leather & Brass" sheet until its own turn. The danger that motivates
 * this guard is a surface that LOOKS migrated but still resolves a legacy value
 * underneath -- the exact drift that made The Bell render bright legacy gold on
 * staging.
 *
 * The seam is token-level on purpose (design-system/current/ppbf-golden-era.css,
 * `.theme-golden`): the shared components (`.frame`, `.rivet`, `.btn`, keylines,
 * eyebrows) all resolve `var(--brass-*)`, so redefining that ramp on the scope
 * re-skins them at once and nothing can fall through. This guard proves the seam
 * is intact:
 *
 *   1. `.theme-golden` exists as a CLASS scope (not `:root`), so legacy pages,
 *      which never carry the class, are untouched.
 *   2. Every brass rung 200..900 is redefined on the scope AND differs from its
 *      legacy `:root` value -- so no golden-era component can resolve a rung
 *      that still holds legacy gold.
 *   3. The Bell (the first migrated surface, and the template) actually carries
 *      `theme-golden`, so the scope is real rather than dead CSS.
 *
 * MUTATION CHECK (how to know this guard bites): delete any `--brass-NNN:` line
 * from the `.theme-golden` block, or set one equal to its legacy value, or drop
 * `theme-golden` from app/login/page.tsx -- each turns this suite red. Restore
 * and it is green.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/** The `.theme-golden { … }` body. The block holds only custom-property
 *  declarations (no nested rules), so a non-greedy brace match is exact. */
function themeGoldenBody(source: string): string | null {
  const match = source.match(/\.theme-golden\s*\{([^}]*)\}/);
  return match ? match[1] : null;
}

/** First value a rung is given OUTSIDE the golden scope -- i.e. its legacy
 *  `:root` definition in the leather-brass sheet. */
function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/\.theme-golden\s*\{[^}]*\}/, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

function scopeRung(body: string, rung: string): string | null {
  const m = body.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

describe('golden-era token scope keeps legacy from leaking in', () => {
  test('.theme-golden exists as a class scope, not on :root', () => {
    expect(themeGoldenBody(css)).not.toBeNull();
    // The redefinitions must be scoped so un-migrated pages are unaffected: the
    // ramp is NOT re-pointed on a bare :root.
    const rootBlocks = css.match(/:root\s*\{[^}]*\}/g) ?? [];
    for (const block of rootBlocks) {
      // A :root block may still legitimately DEFINE the legacy ramp; what it may
      // not do is carry the golden-era bronze values (that would move every page).
      expect(block).not.toContain('#E7C88A');
    }
  });

  test.each(BRASS_RUNGS)('brass rung %s is redefined on the scope and differs from legacy', (rung) => {
    const body = themeGoldenBody(css);
    expect(body).not.toBeNull();

    const scoped = scopeRung(body as string, rung);
    const legacy = legacyRung(css, rung);

    // Present on the scope...
    expect(scoped).not.toBeNull();
    // ...the legacy ramp still exists to migrate away from...
    expect(legacy).not.toBeNull();
    // ...and the golden-era value is genuinely different, so a golden-era
    // component cannot resolve this rung to its legacy gold.
    expect(scoped).not.toEqual(legacy);
  });

  test('The Bell carries the theme-golden scope class', () => {
    const page = readFileSync(
      path.resolve(__dirname, '../../app/login/page.tsx'),
      'utf8',
    );
    expect(page).toMatch(/className="[^"]*\btheme-golden\b[^"]*"/);
  });
});
