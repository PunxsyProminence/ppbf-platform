import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 002 — THE FLOOR BOARD (Coach Workspace).
 *
 * Two separate contracts live here, and the second is the one that matters.
 *
 * 1. THE TOKEN SCOPE. `.ge-floorboard` redefines the brass ramp to aged bronze
 *    so the shared components on this route (the .mat-leather tab rail, the tab
 *    buttons, the .t-command / .t-eyebrow voices) resolve Golden Era metal
 *    together. A property override leaks wherever it is forgotten; a token
 *    override cannot. Same seam `.ge-bell` uses.
 *
 * 2. THE REAL TAB SET SURVIVES THE MOCKUP. The locked 002 reference draws a tab
 *    bar reading MORNING READ / FLOOR / DECISION LOOP / SCRIPTS / DRILLS /
 *    RECOGNITION / VIDEO / INTEL. That is NOT this component's navigation:
 *    DECISION LOOP, SCRIPTS, DRILLS and RECOGNITION are separate routes
 *    (/coach/decision-loop, /coach/session-scripts, /coach/drills,
 *    /coach/recognition), and MORNING READ has nothing behind it at all.
 *    Implementing the image literally would delete six real tabs (Dashboard,
 *    Development, Goals, Tasks, Assessments, Athlete Reviews) and invent four
 *    controls with no backing.
 *
 *    A visual pass is exactly when that kind of deletion happens quietly, so it
 *    is pinned: the nine real tabs must still be there, and the invented labels
 *    must NOT appear in the tab list. If the owner later decides the coach
 *    workspace really should absorb those routes, that is an
 *    information-architecture change with its own PR and its own tests — not a
 *    side effect of restyling.
 *
 * MUTATION CHECK: delete a `--brass-NNN` line from the `.ge-floorboard` block,
 * or drop the class from the page, or rename a real tab to a mockup label —
 * each turns this suite red.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

const WORKSPACE = readFileSync(
  path.resolve(__dirname, '../../components/CoachWorkspace.tsx'),
  'utf8',
);
const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/coach/environment/intake-router/page.tsx'),
  'utf8',
);

/** The bare `.ge-floorboard { … }` token rule, not its descendant rules. */
function scopeBody(source: string): string | null {
  const match = source.match(/^\.ge-floorboard\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-floorboard\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

describe('golden-era floorboard scope', () => {
  test('the bronze ramp is on the .ge-floorboard class scope, not :root', () => {
    expect(scopeBody(css)).not.toBeNull();
    for (const block of css.match(/:root\s*\{[^}]*\}/g) ?? []) {
      expect(block).not.toContain('#E7C88A');
    }
  });

  test.each(BRASS_RUNGS)('brass rung %s is redefined on the scope and differs from legacy', (rung) => {
    const body = scopeBody(css);
    expect(body).not.toBeNull();
    const scoped = (body as string).match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
    expect(scoped).not.toBeNull();
    expect((scoped as RegExpMatchArray)[1].toLowerCase()).not.toEqual(legacyRung(css, rung));
  });

  test('the coach workspace route carries the scope class', () => {
    expect(PAGE).toMatch(/className="[^"]*\bge-floorboard\b[^"]*"/);
  });
});

describe('the 002 mockup did not delete or invent coach tabs', () => {
  // Every tab that really exists on current main.
  const REAL_TABS = [
    'Dashboard',
    'Floor',
    'Development',
    'Goals',
    'Tasks',
    'Assessments',
    'Film Study',
    'Athlete Reviews',
    'SHADOW Intel',
  ] as const;

  /** The COACH_TABS array only, so a label appearing elsewhere in the file
   *  (a heading, a comment) cannot satisfy or break these assertions. */
  function tabBlock(): string {
    const m = WORKSPACE.match(/const COACH_TABS = \[([\s\S]*?)\] as const/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  test.each(REAL_TABS)('the real tab %s still exists', (label) => {
    expect(tabBlock()).toContain(`label: '${label}'`);
  });

  test('no tab was invented from the reference image', () => {
    // Drawn in the locked mockup but backed by nothing here: four are separate
    // routes, and Morning Read does not exist at all.
    const INVENTED = ['Morning Read', 'Decision Loop', 'Scripts', 'Drills', 'Recognition'];
    for (const label of INVENTED) {
      expect(tabBlock()).not.toContain(`label: '${label}'`);
    }
  });

  test('the tab count is unchanged', () => {
    expect(tabBlock().match(/label: '/g) ?? []).toHaveLength(REAL_TABS.length);
  });
});
