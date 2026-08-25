import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 004B — THE DRILL CASE (Coach Drill Library, /coach/drills).
 *
 * Two separate contracts live here, and the second is the one that matters.
 *
 * 1. THE TOKEN SCOPE. `.ge-drillcase` redefines the brass ramp to aged bronze
 *    so every shared component this route renders (.mat-leather, the index
 *    cards, .btn / .btn--ghost, the field bezels, .plaque, the .t-* voices)
 *    resolves Golden Era metal together. A property override leaks wherever it
 *    is forgotten; a token override cannot. Same seam `.ge-bell`,
 *    `.ge-floorboard` and `.ge-locker` use.
 *
 * 2. THE REAL CONTROL SET SURVIVES THE MOCKUP. The locked 004B reference draws
 *    a cabinet with a search field, four filter chips (Purpose / Stance /
 *    Equipment / Level), a per-card "Add to Script" button, a "Selected Drill"
 *    panel carrying Full Cue / Progressions / Programming Notes, and a
 *    right-hand column reading New Drill / Program / Assign to Script / Assign
 *    to Athlete. NONE of that exists on this route: /api/pilot/drills serves a
 *    list and a create, and a pilot.drills row is (name, category, focus, cues,
 *    difficulty, active). There is no search, no filter, no selection state, no
 *    progressions field, no assignment action and no rounds.
 *
 *    The image also OMITS things that are real: the whole add-a-drill form, the
 *    Back to Coach Workspace link, the difficulty plaque, the category line.
 *    Implementing the picture literally would delete four working controls and
 *    invent nine with nothing behind them.
 *
 *    A visual pass is exactly when that kind of deletion happens quietly, so
 *    both halves are pinned: the five real fields and the two real actions must
 *    still be there and still be the only ones, and the mockup's captions must
 *    NOT appear. If the owner later decides the drill library really should
 *    gain search, filters or assignment, that is a feature with its own PR,
 *    its own API and its own tests — not a side effect of restyling.
 *
 * MUTATION CHECK: set a `--brass-NNN` on the `.ge-drillcase` block back to its
 * legacy value (e.g. `--brass-500: #B8912F`), or drop the class from the page,
 * or add one of the mockup's captions to the component — each turns this suite
 * red.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/coach/drills/page.tsx'),
  'utf8',
);

/** The bare `.ge-drillcase { … }` token rule, not its descendant rules. */
function scopeBody(source: string): string | null {
  const match = source.match(/^\.ge-drillcase\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-drillcase\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

describe('golden-era drillcase scope', () => {
  test('the bronze ramp is on the .ge-drillcase class scope, not :root', () => {
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

  test('the drill library route carries the scope class', () => {
    expect(PAGE).toMatch(/className="[^"]*\bge-drillcase\b[^"]*"/);
  });

  test('the scope never spends the reserved medical red on cabinet chrome', () => {
    // The ramp is bronze; #A81E22 belongs to MEDICALLY_NOT_ALLOWED alone. The
    // page's pre-existing --locked form-error sites are a separate, frozen
    // entry in safeguardingRedReservation.test.ts and are not touched here.
    //
    // Comments are stripped before the scan: the block's own prose NAMES the
    // reserved tokens in order to say it does not use them, and a guard that
    // cannot tell a declaration from the sentence documenting it is a guard
    // that punishes writing the reason down.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const declarations = stripped.slice(stripped.indexOf('.ge-drillcase'));
    expect(declarations).toContain('.ge-drillcase');
    expect(declarations).not.toMatch(/#A81E22/i);
    expect(declarations).not.toMatch(/--locked|--stamp-red/);
  });
});

describe('the 004B mockup did not delete or invent drill-library controls', () => {
  // Every control that really exists on current main, by the id or caption a
  // coach actually reaches.
  const REAL_FIELDS = [
    'drill-name',
    'drill-category',
    'drill-focus',
    'drill-cues',
    'drill-difficulty',
  ] as const;

  const REAL_LABELS = [
    'Name',
    'Category',
    'What it is for',
    'Coaching cues, one per line',
    'Difficulty',
  ] as const;

  test.each(REAL_FIELDS)('the real field %s still exists', (id) => {
    expect(PAGE).toContain(`id="${id}"`);
  });

  test.each(REAL_LABELS)('the real label "%s" still exists', (label) => {
    // Matched as text, not as `>label<`: one of these five is written on its
    // own line inside the <label>, so the tight form would pass for four
    // fields and fail for the fifth for a reason that has nothing to do with
    // whether the control is there.
    expect(PAGE).toContain(label);
  });

  test('the two real actions still exist', () => {
    expect(PAGE).toContain('Add drill');
    expect(PAGE).toContain('Back to Coach Workspace');
    expect(PAGE).toContain('href="/coach/environment/intake-router"');
  });

  test('the real difficulty vocabulary is unchanged', () => {
    expect(PAGE).toContain(
      "const DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'elite'] as const;",
    );
  });

  test('the three real list states still exist', () => {
    // A restyle that quietly collapsed these would make a failed fetch look
    // like an empty library, which is the distinction this page states in
    // prose: "This is a failure to load, not an empty library."
    expect(PAGE).toContain('Loading...');
    expect(PAGE).toContain('This is a failure to load, not an empty library.');
    expect(PAGE).toContain('Nothing yet. The first drill you add');
  });

  test('no control was invented from the reference image', () => {
    // Drawn in the locked mockup, backed by nothing on this route or in
    // pilot.drills. Each is an exact caption from the image.
    const INVENTED = [
      'Add to Script',
      'Selected Drill',
      'Full Cue',
      'Progressions',
      'Programming Notes',
      'New Drill',
      'Assign to Script',
      'Assign to Athlete',
      'Rounds',
      'Purpose',
      'Stance',
      'Equipment',
    ];
    for (const caption of INVENTED) {
      expect(PAGE).not.toContain(caption);
    }
    // The reference's search rail. There is no search on this route.
    expect(PAGE).not.toMatch(/type="search"/);
    expect(PAGE).not.toMatch(/placeholder="Search/i);
  });

  test('the control count is unchanged', () => {
    // Nothing added, nothing removed: two text inputs, two textareas, one
    // select, one button, one link.
    expect(PAGE.match(/<input\b/g) ?? []).toHaveLength(2);
    expect(PAGE.match(/<textarea\b/g) ?? []).toHaveLength(2);
    expect(PAGE.match(/<select\b/g) ?? []).toHaveLength(1);
    expect(PAGE.match(/<button\b/g) ?? []).toHaveLength(1);
    expect(PAGE.match(/<Link\b/g) ?? []).toHaveLength(1);
  });
});
