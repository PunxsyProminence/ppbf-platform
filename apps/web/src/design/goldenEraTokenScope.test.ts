import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * STATIC CONTRACT CHECK for the golden-era Bell token scope.
 *
 * The Bell migrates off the retired "Leather & Brass" look by redefining the
 * brass ramp on its one scope, `.ge-bell`; the shared components it renders
 * (.frame, .rivet, .btn, keylines, eyebrows) resolve `var(--brass-*)`, so the
 * scope re-skins them to aged bronze at once and nothing falls through to
 * legacy gold. This test guards the SOURCE contract:
 *
 *   1. `.ge-bell` redefines every brass rung 200..900, and each value differs
 *      from its legacy `:root` value -- so no golden-era component can resolve
 *      a rung that still holds legacy gold.
 *   2. The bronze values are NOT placed on a bare `:root` (that would move the
 *      whole app); they live on the class scope, so un-migrated pages, which
 *      never carry `.ge-bell`, are untouched.
 *   3. The Bell (app/login) actually carries the `ge-bell` scope class.
 *
 * WHAT THIS TEST DOES NOT DO, ON PURPOSE. A text scan cannot prove that a
 * browser RESOLVES a component inside `.ge-bell` to bronze -- inheritance and
 * the cascade are the browser's to compute. That proof is a separate,
 * authoritative guard: e2e/public-homepage.spec.ts opens the real /login and
 * reads getComputedStyle off `.ge-bell .frame` (bronze gradient + brown-leather
 * border) and off the scope's own `--brass-500` vs the document root's, and it
 * is the one that fails if the resolved styling regresses. This static check is
 * the fast precheck that the contract is even declared.
 *
 * MUTATION CHECK: delete any `--brass-NNN:` line from the `.ge-bell` token
 * block, or set one equal to its legacy value, or drop `ge-bell` from
 * app/login/page.tsx -- each turns this suite red. Restore -> green.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/** The bare `.ge-bell { … }` token rule (at line start), NOT the descendant
 *  rules like `.ge-bell .frame {`. The block holds only custom-property
 *  declarations, so a non-greedy brace match is exact. */
function bellScopeBody(source: string): string | null {
  const match = source.match(/^\.ge-bell\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

/** First value a rung is given OUTSIDE the Bell scope block -- its legacy
 *  `:root` definition in the leather-brass sheet. */
function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-bell\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

function scopeRung(body: string, rung: string): string | null {
  const m = body.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

describe('golden-era Bell token scope — static contract', () => {
  test('the bronze ramp is declared on the .ge-bell class scope, not on :root', () => {
    expect(bellScopeBody(css)).not.toBeNull();
    const rootBlocks = css.match(/:root\s*\{[^}]*\}/g) ?? [];
    for (const block of rootBlocks) {
      // A :root block may DEFINE the legacy ramp; it may not carry the golden
      // bronze values (that would re-skin every un-migrated page).
      expect(block).not.toContain('#E7C88A');
    }
  });

  test.each(BRASS_RUNGS)('brass rung %s is redefined on .ge-bell and differs from legacy', (rung) => {
    const body = bellScopeBody(css);
    expect(body).not.toBeNull();

    const scoped = scopeRung(body as string, rung);
    const legacy = legacyRung(css, rung);

    expect(scoped).not.toBeNull();
    expect(legacy).not.toBeNull();
    expect(scoped).not.toEqual(legacy);
  });

  test('The Bell carries the ge-bell scope class', () => {
    const page = readFileSync(
      path.resolve(__dirname, '../../app/login/page.tsx'),
      'utf8',
    );
    expect(page).toMatch(/className="[^"]*\bge-bell\b[^"]*"/);
  });
});
