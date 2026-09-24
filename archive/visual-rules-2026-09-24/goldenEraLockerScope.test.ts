import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 003 — MY CORNER (Athlete Workspace).
 *
 * The token scope is the same leak-proof seam .ge-bell and .ge-floorboard use:
 * the shared components on this route resolve var(--brass-*), so redefining the
 * ramp on `.ge-locker` re-skins them together and legacy gold cannot leak
 * through a property nobody overrode.
 *
 * The second block pins the athlete's real tab groups. Unlike 002 this packet's
 * stated tabs match main exactly, so there is nothing to escalate -- which is
 * precisely why it is worth pinning: a later visual pass must not quietly drop
 * one, and "it matched when we shipped" is not a guarantee.
 *
 * MUTATION: delete a --brass rung from the scope, drop the class from the page,
 * or remove a tab group -- each turns this red.
 */
const BRASS_RUNGS = ['200','300','400','500','600','700','800','900'] as const;
const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);
const PAGE = readFileSync(path.resolve(__dirname, '../../app/athlete/dashboard/page.tsx'), 'utf8');
const WORKSPACE = readFileSync(path.resolve(__dirname, '../../components/AthleteWorkspace.tsx'), 'utf8');

function scopeBody(source: string): string | null {
  const m = source.match(/^\.ge-locker\s*\{([^}]*)\}/m);
  return m ? m[1] : null;
}
function legacyRung(source: string, rung: string): string | null {
  const without = source.replace(/^\.ge-locker\s*\{[^}]*\}/m, '');
  const m = without.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

describe('golden-era locker scope', () => {
  test('the bronze ramp is on the .ge-locker class scope, not :root', () => {
    expect(scopeBody(css)).not.toBeNull();
    /* `?? []` turns "the regex found no :root block" into "there is nothing to
       check", and a for-loop over nothing asserts nothing -- so this half of the
       test reports that no :root carries the bronze in exactly the same voice
       whether that is true or whether the scan simply broke. Seven :root blocks
       resolve today; the floor is the honest claim, which is that at least one
       was read and the loop below therefore ran. */
    expect((css.match(/:root\s*\{[^}]*\}/g) ?? []).length).toBeGreaterThan(0);
    for (const block of css.match(/:root\s*\{[^}]*\}/g) ?? []) {
      expect(block).not.toContain('#E7C88A');
    }
  });

  test.each(BRASS_RUNGS)('brass rung %s is redefined on the scope and differs from legacy', (rung) => {
    const body = scopeBody(css);
    expect(body).not.toBeNull();
    const scoped = (body as string).match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
    expect(scoped).not.toBeNull();
    /* `legacyRung` returns null when it finds no definition outside the scope,
       and `not.toEqual(null)` is satisfied by every string there is. So the
       moment the ramp this scope exists to differ FROM stops being in the
       resolved sheet, "differs from legacy" starts passing for the one reason
       that means nothing was compared. Asserted the way its sibling
       goldenEraTokenScope.test.ts already asserts it. */
    expect(legacyRung(css, rung)).not.toBeNull();
    expect((scoped as RegExpMatchArray)[1].toLowerCase()).not.toEqual(legacyRung(css, rung));
  });

  test('the athlete dashboard carries the scope class', () => {
    expect(PAGE).toMatch(/className="[^"]*\bge-locker\b[^"]*"/);
  });
});

describe('the 003 visual pass kept every athlete tab group', () => {
  const REAL_GROUPS = ['Today', 'Development', 'Learn', 'Schedule', 'Messages', 'SHADOW'] as const;

  function groupBlock(): string {
    const m = WORKSPACE.match(/const TAB_GROUPS[\s\S]*?\n\];/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[0];
  }

  test.each(REAL_GROUPS)('the %s group still exists', (label) => {
    expect(groupBlock()).toContain(`label: '${label}'`);
  });
});
