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
 *    to Athlete. NONE of that existed on this route when the mockup was drawn:
 *    /api/pilot/drills served a list and a create, and a pilot.drills row was
 *    (name, category, focus, cues, difficulty, active). There was no search, no
 *    filter, no selection state, no progressions field, no assignment action
 *    and no rounds.
 *
 *    The image also OMITS things that are real: the whole add-a-drill form, the
 *    Back to Coach Workspace link, the difficulty plaque, the category line.
 *    Implementing the picture literally would delete four working controls and
 *    invent nine with nothing behind them.
 *
 *    A visual pass is exactly when that kind of deletion happens quietly, so
 *    both halves are pinned: the five real fields and the real actions
 *    must still be there and still be the only ones, and the mockup's captions
 *    must NOT appear. If the owner later decides the drill library really should
 *    gain search, filters or assignment, that is a feature with its own PR,
 *    its own API and its own tests — not a side effect of restyling.
 *
 *    THE THIRD ACTION ARRIVED THAT WAY, and is the illustration rather than the
 *    exception: Promote is an owner-approved coach action under
 *    OD-2026-09-16-001 (the hybrid reference / operational drill model), with its
 *    own PR, its own POST /api/pilot/drills/promote route, its own schema and its
 *    own tests. So the inventory then counted two buttons, and the Promote
 *    control is asserted BY NAME — a count alone would let any second button
 *    satisfy this proof, which is the failure mode this file exists to catch.
 *
 *    W-D4A (OD-2026-09-19-001) is the next one, and arrived the same way: an
 *    owner ruling, its own PR and its own tests. A reference drill now opens
 *    into a full detail (backed by GET /api/pilot/drill-library?drill_id=,
 *    which already existed), Promote moved from the one-line card onto that
 *    detail, and every operational drill promoted from a reference can open
 *    its reference. So the inventory grows by exactly those controls, each
 *    asserted by name below, and "Equipment" leaves the invented list because
 *    the card now labels the real equipment_needed field with it. Search and
 *    filters were still NOT here then; they stayed banned until their own
 *    change.
 *
 *    W-D4C is that change. Search and filters arrived under the same ruling,
 *    OD-2026-09-19-001, whose authorization names W-D4C as the "lifecycle,
 *    discovery and promotion quality" step -- as their own change with their
 *    own tests, and on STATED TERMS: item 4 of the "W-D4C build
 *    interpretations, flagged" block in docs/current/OWNER_DECISIONS.md.
 *      - DURABLE, STRUCTURED FIELDS ONLY. The filters are discipline, category,
 *        difficulty, contact level, the coach-authorization flag and the
 *        lifecycle the server derives from rows ("In this gym").
 *      - NAME-ONLY SEARCH. The one search box matches the drill's name and
 *        nothing else.
 *      - NO PROSE-DERIVED FILTER. Nothing is filtered by parsing purpose,
 *        execution, what good looks like, or the free-text equipment column,
 *        so there is no equipment, solo / partner or space filter: nothing
 *        records those as data.
 *    So the page may now carry exactly ONE type="search" input (labelled
 *    "Search by name", with no "Search..." placeholder rail), ONE <select>
 *    mapped over the FILTERS specs, and a Clear filters button; the opened
 *    reference detail also gains the LIFECYCLE clause's Retire / Restore
 *    control. Each is asserted by name, and the TERMS are pinned as well as the
 *    counts: a filter or a search that reads a prose field, or a filter key for
 *    equipment / partner / solo / space, turns this suite red -- "durable data
 *    only" is a promise a control count cannot keep. The shared drill detail
 *    still has no search at all, and the mockup's chips stay invented: the real
 *    filters are named for the columns they read, not for Purpose or Stance.
 *
 * MUTATION CHECK: set a `--brass-NNN` on the `.ge-drillcase` block back to its
 * legacy value (e.g. `--brass-500: #B8912F`), or drop the class from the page,
 * or add one of the mockup's captions to the component, or give the page a
 * second type="search" input or a "Search..." placeholder, or point a filter or
 * the search at drill.purpose, or add an equipment filter — each turns this
 * suite red.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/coach/drills/page.tsx'),
  'utf8',
);

/**
 * The shared drill detail (W-D4A) renders on this route too, so the invented-
 * caption and search bans cover it. Its interactive elements are counted
 * separately below: they are expanders, not actions.
 */
const DETAIL = readFileSync(
  path.resolve(__dirname, '../../components/drills/DrillDetail.tsx'),
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

/**
 * The text of `source` from the first `start` through the next `end` after it.
 * Throws instead of returning '' when either is missing: every caller goes on
 * to assert the ABSENCE of something in the slice, and an empty slice contains
 * nothing -- so a renamed or moved block would pass for the one reason that
 * means nothing was read.
 */
function sliceFrom(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`not found in the page source: ${start}`);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`no ${JSON.stringify(end)} after ${start}`);
  return source.slice(from, to + end.length);
}

/** Every distinct field read as `<name>.field` or `<name>?.field`, sorted. */
function fieldsReadOn(source: string, name: string): string[] {
  const read = new RegExp(`\\b${name}\\??\\.(\\w+)`, 'g');
  return [...new Set([...source.matchAll(read)].map((m) => m[1]))].sort();
}

/** Every single-quoted string literal in `source`, in order. */
function quoted(source: string): string[] {
  return [...source.matchAll(/'([^']*)'/g)].map((m) => m[1]);
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

  test('the real actions still exist', () => {
    expect(PAGE).toContain('Add drill');
    expect(PAGE).toContain('Back to Coach Workspace');
    expect(PAGE).toContain('href="/coach/environment/intake-router"');
    // Promote, per OD-2026-09-16-001. Named, not merely counted: the control and
    // the endpoint it calls are both pinned, so a restyle cannot drop the action
    // and a stray button cannot stand in for it.
    expect(PAGE).toContain('Promote');
    expect(PAGE).toContain('/api/pilot/drills/promote');
    // W-D4A: the detail that Promote now lives on, and the way back from it.
    expect(PAGE).toContain('View drill');
    expect(PAGE).toContain('View instructions');
    expect(PAGE).toContain('/api/pilot/drill-library?drill_id=');
    expect(PAGE).toContain('Back to the reference library');
    // W-D4C: the LIFECYCLE clause's Retire / Restore -- one control on the
    // opened reference detail, captioned by the state the server derived, and
    // sent through the drills route's PATCH -- and the discovery rail's reset.
    expect(PAGE).toContain("'Retire'");
    expect(PAGE).toContain("'Restore'");
    expect(PAGE).toContain('id={`lifecycle-${referenceDrillId}`}');
    expect(PAGE).toContain("method: 'PATCH'");
    expect(PAGE).toContain('Clear filters');
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
    // The old empty-state promise ("the first drill you add is the first one
    // your athletes will see") stopped being true at W-D2: a hand-written drill
    // never reaches Learn. The state is still pinned, with truthful copy.
    expect(PAGE).toContain('Nothing yet. Promote a drill from the reference library');
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
      // 'Equipment' left this list at W-D4A: the card now labels the real
      // equipment_needed field with it. It is a field, not a filter chip.
    ];
    for (const source of [PAGE, DETAIL]) {
      for (const caption of INVENTED) {
        expect(source).not.toContain(caption);
      }
      // The reference's search rail, as drawn: a box placeheld "Search...".
      // The page's real search (W-D4C) is labelled, not placeheld, so the
      // drawn rail stays banned on both files -- as an attribute string or as
      // a JSX expression.
      expect(source).not.toMatch(/placeholder=\{?\s*["'`]Search/i);
    }
    // The shared drill detail has no search at all. The page has exactly one:
    // the W-D4C name search, pinned by its terms in the next case.
    expect(DETAIL).not.toMatch(/type="search"/);
    expect(PAGE.match(/type="search"/g) ?? []).toHaveLength(1);
  });

  describe('W-D4C discovery: name search and durable filters, on their stated terms', () => {
    // Every drill-row field a DURABLE filter reads: CHECKed enums, the
    // discipline registry, the stored category, the coach-authorization flag.
    // The sixth filter reads the server-derived lifecycle, not the row.
    const DURABLE_FILTER_FIELDS = [
      'category',
      'contact_level',
      'difficulty',
      'discipline',
      'requires_coach_authorization',
    ];

    // The prose on a reference drill row (and its scales, stop rules and cues),
    // plus the operational row's `focus`. `equipment_needed` is here too: it is
    // free text, filterable only by parsing it. Matched as whole words, so a
    // destructured `({ purpose })` is caught as well as `drill.purpose`.
    const PROSE =
      /\b(?:target_behavior|purpose|standard_setup|execution|what_\w+|common_errors|corrections|transfer|equipment_needed|field_provenance|source_ref|cues?|focus|demand_description|constraint_applied|coach_watch_point|condition_text)\b/;

    // Discovery keys nothing durable records (OWNER_DECISIONS W-D4C item 4).
    const NO_COLUMN = /equipment|partner|solo|space|environment|coach[-_ ]?led/i;

    const FILTER_KEYS = ['discipline', 'category', 'difficulty', 'contact', 'authorization', 'lifecycle'];

    test('the one search input is the labelled NAME search, with no placeholder rail', () => {
      const searchInputs = (PAGE.match(/<input\b[\s\S]*?\/>/g) ?? []).filter((tag) => tag.includes('type="search"'));
      expect(searchInputs).toHaveLength(1);
      const [searchInput] = searchInputs;
      expect(searchInput).toContain('id="reference-search"');
      expect(searchInput).not.toContain('placeholder');
      expect(PAGE).toContain('<label htmlFor="reference-search" className="t-label">Search by name</label>');
    });

    test('the search predicate reads the drill name and nothing else', () => {
      expect(PAGE).toContain('const searchTerm = search.trim().toLowerCase();');
      const predicate = sliceFrom(PAGE, 'const visibleReferenceDrills = referenceDrills.filter(', '\n  });');
      expect(predicate).toContain('if (searchTerm && !drill.name.toLowerCase().includes(searchTerm)) return false;');
      // `drill_id` is the key into the server's lifecycle map for the
      // "In this gym" filter; `name` is the search. Nothing else of the row.
      expect(fieldsReadOn(predicate, 'drill')).toEqual(['drill_id', 'name']);
      expect(predicate).not.toMatch(PROSE);
    });

    test('every filter reads a durable structured field, never prose', () => {
      const specs = sliceFrom(PAGE, 'const FILTERS: FilterSpec[] = [', '\n];');
      expect(fieldsReadOn(specs, 'drill')).toEqual(DURABLE_FILTER_FIELDS);
      expect(fieldsReadOn(specs, 'lifecycle')).toEqual(['state']);
      expect(specs).not.toMatch(PROSE);
      expect(specs).not.toMatch(/\.what_/);
    });

    test('the filter set is exactly the six durable filters, and no equipment / partner / solo / space key', () => {
      const specs = sliceFrom(PAGE, 'const FILTERS: FilterSpec[] = [', '\n];');
      expect([...specs.matchAll(/\bkey: '(\w+)'/g)].map((m) => m[1])).toEqual(FILTER_KEYS);
      expect([...specs.matchAll(/\blabel: '([^']+)'/g)].map((m) => m[1])).toEqual([
        'Discipline',
        'Category',
        'Difficulty',
        'Contact',
        'Coach authorization',
        'In this gym',
      ]);

      const keyType = sliceFrom(PAGE, 'type FilterKey =', ';');
      expect(quoted(keyType)).toEqual(FILTER_KEYS);
      const reset = sliceFrom(PAGE, 'const NO_FILTERS: Record<FilterKey, string> = {', '\n};');
      expect([...reset.matchAll(/^\s+(\w+): '',$/gm)].map((m) => m[1])).toEqual(FILTER_KEYS);

      for (const source of [specs, keyType, reset]) {
        expect(source).not.toMatch(NO_COLUMN);
      }
    });

    test('the page renders one select per FILTERS spec, so the specs are the whole filter set', () => {
      const mapped = sliceFrom(PAGE, '{FILTERS.map((spec) => (', '</select>');
      expect(mapped).toContain('<select');
      expect(mapped).toContain('id={`reference-filter-${spec.key}`}');
      expect(mapped).toContain('{spec.label}');
      expect(PAGE).toContain('Showing {visibleReferenceDrills.length} of {referenceDrills.length} reference drills');
      expect(PAGE).toContain('No reference drills match this search and these filters.');
    });
  });

  test('the shared drill detail adds reading controls only, never an action of its own', () => {
    // Its only interactive elements are <details> expanders (Level 3). The
    // Promote action is passed in by the page, where it is counted.
    expect(DETAIL.match(/<button\b/g) ?? []).toHaveLength(0);
    expect(DETAIL.match(/<input\b/g) ?? []).toHaveLength(0);
    expect(DETAIL.match(/<select\b/g) ?? []).toHaveLength(0);
    expect(DETAIL.match(/<Link\b/g) ?? []).toHaveLength(0);
    expect(DETAIL).not.toMatch(/fetch\(/);
  });

  test('the control count is unchanged', () => {
    // At 004B, nothing added and nothing removed: two text inputs, two
    // textareas, one select, one button, one link. Each owner-approved change
    // since has moved these numbers only by the controls it names.
    //
    // Two buttons rather than one since OD-2026-09-16-001: Add drill, and the
    // Promote control on each reference card. The name assertion in "the three
    // real actions still exist" is what makes the second one specifically
    // Promote; this case only holds the line against a THIRD appearing.
    //
    // Five since W-D4A: Add drill; View drill on each reference card; Back to
    // the reference library and Promote on the opened detail; View
    // instructions on each operational drill promoted from a reference. Named
    // in "the real actions still exist"; this case holds the line against a
    // SIXTH.
    //
    // W-D4C, counted in the source:
    //   - three inputs: the two form fields, and the one name search;
    //   - two selects: difficulty, and ONE element mapped over the FILTERS
    //     specs (six on screen, one in the source -- which is why the FILTERS
    //     array itself is pinned, key by key and field by field, above);
    //   - seven buttons: the five above, plus Retire / Restore (one element
    //     whose caption follows the derived lifecycle) on the opened detail,
    //     and Clear filters on the discovery rail. Named in "the real actions
    //     still exist"; this case holds the line against an EIGHTH.
    expect(PAGE.match(/<input\b/g) ?? []).toHaveLength(3);
    expect(PAGE.match(/<textarea\b/g) ?? []).toHaveLength(2);
    expect(PAGE.match(/<select\b/g) ?? []).toHaveLength(2);
    expect(PAGE.match(/<button\b/g) ?? []).toHaveLength(7);
    expect(PAGE.match(/<Link\b/g) ?? []).toHaveLength(1);
  });
});
