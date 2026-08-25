import { expect, test, type Page } from '@playwright/test';
import { installPilotApi, SERVER_GUARDED_ROUTES, type PilotApiStubs, type PilotSessionStub } from './support/signIn';

/* THE RESOLVED-STYLE PROOF, FOR EVERY GOLDEN-ERA SCOPE.
   ==========================================================================

   WHAT THIS FILE IS FOR. The golden-era work re-skins a surface by redefining
   the brass ramp on one scope class. Custom properties inherit, so every
   shared component inside that scope that goes THROUGH `var(--brass-N)`
   becomes bronze at once and nothing outside the scope moves. That is the
   whole leak-proof argument, and only a browser can say whether it held: a
   text scan of a stylesheet cannot compute inheritance, specificity, layer
   order, `color-mix()`, or a Tailwind arbitrary value that never went near a
   token in the first place.

   Until this file exactly one of the eight had that proof -- `.ge-bell`, in
   e2e/public-homepage.spec.ts, which stays exactly as it is and is the model
   every check below is built from. The other scopes had static text-scan
   guards only (src/design/goldenEra*Scope.test.ts). Those guards are good at
   what they do: they prove the contract is DECLARED. They cannot prove it
   RESOLVES.

   THAT GAP IS NOT HYPOTHETICAL. A browser probe of `.ge-frontoffice` once
   found its buttons resolving an `rgba(212, 175, 74, 0.42)` border -- legacy
   gold -- while the very same element correctly resolved `--brass-500` as
   bronze. Forty-six rules across the legacy sheet spelled a brass rung as a
   literal, so no scope could reach them. src/design/brassAlphaChannel.test.ts
   now bans that spelling in the sheets. Nothing before this file watched the
   RESULT in a browser, which is the only place the question is settled.

   HOW EACH SCOPE IS PROVEN. Four assertions, in the order they matter:

     1. The scope element is on the page at all, with the surface's real data
        rendered under it. A scope class that fell off a `className`, or a
        surface that quietly rendered nothing, would satisfy every check below
        vacuously.
     2. The scope wins over the document root. `--brass-500` resolves to the
        golden `#9f7a30` ON THE SCOPE while `:root` still resolves the legacy
        `#b8912f`, and the two genuinely differ. Both halves are asserted:
        without the root half a global re-skin would satisfy the scope half
        and prove nothing about scoping. The whole ramp is checked, not just
        the 500 rung, because a scope that redefines seven of eight leaks on
        the eighth.
     3. REAL SHARED COMPONENTS INSIDE THE SCOPE PAINT BRONZE. This is the
        assertion that catches leaks. It reads `getComputedStyle` off genuine
        elements -- a button border, an input keyline, a panel's
        background-image, the register sheet's ruling -- and requires that the
        resolved paint carries a golden-era rung and carries NO legacy rung,
        in either serialisation the browser uses.
     4. A whole-scope sweep: every element under the scope plus its ::before
        and ::after, across fifteen paint properties, against every legacy
        rung and against the reserved safeguarding red. Assertion 3 is the
        named catch; this is the wide net. See THE LEAK LEDGER below for the
        places it currently finds legacy gold and why.

   WHY THE SWEEP READS PSEUDO-ELEMENTS. Most golden-era metal is drawn on
   `::before`/`::after` -- rivets, screw heads, frame beads, lamp pools. A
   sweep that read only real elements would miss most of the brass on these
   pages.

   WHY EVERY VALUE IS CANONICALISED FIRST. A great deal of this metal arrives
   through `color-mix()`, which Chromium serialises as
   `color(srgb 0.431373 0.321569 0.12549 / 0.52)` rather than as an `rgb()`
   triple. Matching that spelling literally would tie the file to one build's
   float formatting, and it would fail in the wrong direction. See CANONICAL
   FORM below.

   WHAT IS STUBBED, AND WHAT IS NOT. Only the pilot API, at the network
   boundary, exactly as every other spec in this directory does it (see the
   docblock in e2e/support/signIn.ts). The CSS, the cascade, the fonts, the
   layout and every computed style read below are the genuine article. The
   stubs carry REAL-SHAPED DATA rather than empty lists on purpose: an empty
   surface renders almost no components, and a proof that no legacy gold is
   painted is worth exactly what it was measured over.

   EIGHT SCOPES, SEVEN OF THEM PROVABLE HERE. `.ge-locker` lives on
   /athlete/dashboard, whose role check runs on the SERVER against Postgres,
   so with no database it answers 307 -> /login and the scope never renders.
   Its proof is written in full below and skips itself, with the reason
   attached to the run, only when it OBSERVES that redirect. Nothing about it
   is faked, and nothing has to be remembered to switch it on.

   MUTATION EVIDENCE. A guard nobody has watched go red is a hypothesis. Six
   mutations of ppbf-golden-era.css, each applied alone and reverted, across
   six different scopes. The two failure modes are different on purpose -- a
   wrong RUNG is caught by assertion 2 and named as a token; a wrong PAINT is
   caught by assertion 3 and named as a property:

     `.ge-drillcase .input` border -> `rgba(212,175,74,.62)`
        RED: ".ge-drillcase .input — border-top-color resolved a LEGACY brass
        rung: rgba(212, 175, 74, 0.62)"
     `.ge-frontoffice` `--brass-400-rgb: 212 175 74`  (the historic leak)
        RED: ".ge-frontoffice .btn--ghost — border-top-color resolved a LEGACY
        brass rung: rgba(212, 175, 74, 0.42)"
     `.ge-afterhours` `--brass-400-rgb: 212 175 74`
        RED: ".ge-afterhours .input — border-top-color resolved a LEGACY brass
        rung: rgba(212, 175, 74, 0.28)"
     `.ge-scripts .plaque` metal -> legacy 200/300/400 literals
        RED: ".ge-scripts .plaque — background-image resolved a LEGACY brass
        rung: linear-gradient(rgb(242, 226, 168) 0%, …)"
     `.ge-scheduler` `--brass-500: #B8912F`
        RED: ".ge-scheduler must resolve the golden-era ramp", diffing
        #9f7a30 -> #b8912f
     `.ge-floorboard .mat-leather` border -> a legacy rung through `color-mix`
        RED: "… border-top-color resolved a LEGACY brass rung:
        color(srgb 0.831373 0.686275 0.290196 / 0.52)" -- the canonicalisation
        earning its place

   In every case ONLY the mutated scope went red and the other six stayed
   green, which is the scoping claim itself under test. Restore -> GREEN.

   Assertion 4, the sweep, was watched to fail independently: a legacy literal
   on `.ge-floorboard .t-eyebrow`'s `color` -- a rule no named component probe
   reads -- turned it red. That run is where the currentColor and border-side
   folding in the reader came from.
   ========================================================================== */

/* ---- The two ramps ------------------------------------------------------
   Stated as data so every check below derives from them rather than from a
   literal typed at a call site. The golden values are the ones every `.ge-*`
   block in design-system/current/ppbf-golden-era.css declares; the legacy
   values are the ones `:root` still declares in
   design-system/legacy/ppbf-leather-brass.css, and the same eight
   src/design/brassAlphaChannel.test.ts enumerates. */
const GOLDEN_ERA_RAMP: Readonly<Record<string, string>> = {
  '--brass-200': '#e7c88a',
  '--brass-300': '#d6b063',
  '--brass-400': '#be9440',
  '--brass-500': '#9f7a30',
  '--brass-600': '#896628',
  '--brass-700': '#6e5220',
  '--brass-800': '#533d18',
  '--brass-900': '#392910',
};

const LEGACY_ROOT_RAMP: Readonly<Record<string, string>> = {
  '--brass-200': '#f2e2a8',
  '--brass-300': '#e8ce7a',
  '--brass-400': '#d4af4a',
  '--brass-500': '#b8912f',
  '--brass-600': '#a98126',
  '--brass-700': '#8c6b1f',
  '--brass-800': '#6b4e12',
  '--brass-900': '#4a340b',
};

/** #A81E22 / --locked / --stamp-red. Law 2 reserves it for
    MEDICALLY_NOT_ALLOWED, so it may not be spent on decorative chrome. This is
    not a theoretical reservation on these surfaces: the legacy `.pap--ruled`
    draws its margin rule in `rgba(168,30,34,.34)`, and the golden-era
    `.mat-paper` override exists to replace exactly that. */
const SAFEGUARDING_RED = '#a81e22';

/* CANONICAL FORM, AND WHY MATCHING NEEDS ONE.

   Chromium answers `getComputedStyle` with two spellings of the same colour.
   A plain colour comes back as `rgb(110, 82, 32)`; anything that went through
   `color-mix()` -- and a great deal of golden-era metal does -- comes back as
   `color(srgb 0.431373 0.321569 0.12549 / 0.52)`. Both are brass-700.

   Matching the float spelling literally would tie this file to one browser
   build's float formatting, and the direction it would fail in is the wrong
   one: a positive assertion ("this carries bronze") fails loudly if the
   formatting changes, but a NEGATIVE one ("this carries no legacy gold")
   would quietly start passing. This suite runs against whatever Chromium the
   pinned @playwright/test installs, which is not the one it was written on, so
   that is a live risk rather than a hypothetical.

   So every value is canonicalised to integer `rgb()` channels before it is
   matched, and only the raw value is ever REPORTED -- a failure should show
   what the browser actually said. `color-mix(in oklab, …)` serialises as
   `oklab(…)` and is left alone: the one call site using it is on `--hide-950`,
   not on a brass rung. */
const SRGB_COMPONENTS = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)([^)]*)\)/g;

/** Kept as a string of source so the identical function can be used here and
    inside the page. `page.evaluate` serialises its callback, so a helper
    declared out here is not in scope in the browser, and the sweep has to run
    in the browser -- ~140 elements times three pseudo-element states times
    fifteen properties is not a payload to ship back across the wire. */
function canonicalise(value: string): string {
  return value.replace(
    SRGB_COMPONENTS,
    (_match, r: string, g: string, b: string) =>
      `rgb(${Math.round(Number(r) * 255)}, ${Math.round(Number(g) * 255)}, ${Math.round(Number(b) * 255)})`,
  );
}

/** `#rrggbb` -> the two prefixes a canonicalised value can carry it in, with
    whitespace already stripped so only the digits have to line up. Prefixes
    rather than whole values, because the alpha and the closing paren vary and
    are not what identifies a rung. */
function serialisations(hex: string): string[] {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return [`rgb(${r},${g},${b}`, `rgba(${r},${g},${b}`];
}

const squash = (value: string) => canonicalise(value).replace(/\s+/g, '');

const LEGACY_NEEDLES = Object.values(LEGACY_ROOT_RAMP).flatMap(serialisations);
const GOLDEN_NEEDLES = Object.values(GOLDEN_ERA_RAMP).flatMap(serialisations);
const RESERVED_RED_NEEDLES = serialisations(SAFEGUARDING_RED);

/** Every property a colour reaches the screen through on these surfaces.
    A flat list rather than a full CSSStyleDeclaration walk: that also picks up
    shorthands and every inherited value, on ~140 elements times three
    pseudo-element states, and reports the same paint many times over. */
const PAINT_PROPERTIES = [
  'background-color',
  'background-image',
  'border-bottom-color',
  'border-image-source',
  'border-left-color',
  'border-right-color',
  'border-top-color',
  'box-shadow',
  'color',
  'column-rule-color',
  'fill',
  'outline-color',
  'stroke',
  'text-decoration-color',
  'text-shadow',
] as const;

/* ---- THE LEAK LEDGER ----------------------------------------------------

   TWO KINDS OF DEFECT, on three surfaces, still resolve legacy gold inside a
   golden-era scope in a real browser, on merged `main`, today. Every one was
   found by the sweep below and none was visible to any existing guard:

     * a `:root` TOKEN ALIAS that freezes the legacy value before any scope
       exists (`.ge-floorboard`, `.ge-frontoffice`). The more serious of the
       two, and it contradicts a claim the stylesheet makes about itself --
       see THE FROZEN ALIAS below.
     * a LEGACY LITERAL SPELLED INTO JSX, which no token override can reach
       (`.ge-floorboard`, `.ge-afterhours`) -- see THE OTHER ONE below.

   All are defects in application code or in the sheet, and this branch is
   tests and CI wiring only (FUNCTIONAL_CHANGES: NONE), so none is fixed here.
   They are recorded rather than filtered away, and the difference matters:

     * the sweep asserts the observed set of legacy paints EXACTLY EQUALS this
       ledger. A NEW leak anywhere under any scope turns it red. A leak that
       gets FIXED also turns it red, naming the entry to delete -- so a ledger
       entry cannot quietly outlive the defect it describes.
     * every entry names its source and why it is not this branch's to fix, in
       the shape src/design/brassAlphaChannel.test.ts already uses for its
       ALLOW_LIST.

   One limit, stated rather than implied: entries are matched on
   tag + pseudo + property + value, so a second element that begins painting
   the SAME wrong value on the SAME property of the SAME tag collapses into an
   existing entry instead of failing. Widening the key to the element's full
   class attribute would catch that, and would also turn red on every
   unrelated Tailwind class change on those components -- a gate that cries
   wolf gets deleted. What this ledger holds is the KIND of leak; the count is
   not what it is for. */
interface KnownLeak {
  /** `tag::pseudo | property | value` -- exactly what the sweep reports. */
  readonly key: string;
  readonly source: string;
  readonly why: string;
}

/* THE FROZEN ALIAS. The larger of the two defects, and the one a text scan
   could never have reached, so it is written out once and pointed at twice.

   app/globals.css declares its chrome accents on `:root` as aliases of the
   ramp:

       --accent:        var(--brass-600);
       --accent-strong: var(--brass-500);
       --accent-quiet:  var(--brass-800);

   A custom property is substituted at COMPUTED-VALUE TIME on the element that
   declares it. So `--accent` computes to the legacy `#A98126` at `:root`, and
   every descendant -- inside a golden-era scope or not -- inherits that
   already-finished colour. Redefining `--brass-600` on `.ge-floorboard` or
   `.ge-frontoffice` cannot reach it: by the time the scope exists, the alias
   is no longer a reference to anything.

   The browser makes the diagnosis unarguable on a single element. The coach
   workspace's "Dashboard" tab carries both
   `bg-[var(--accent)]` and `border-[color:var(--brass-600)]`, and it resolves
   `background-color: rgb(169, 129, 38)` -- legacy -- next to
   `border-color: rgb(137, 102, 40)` -- bronze. Same element, same rung, two
   answers, and the one that went through the alias is the wrong one. That is
   the identical shape as the `rgba(212, 175, 74, 0.42)` border found on
   `.ge-frontoffice`: a paint the scope has no way to reach.

   It is also a claim in the sheet that is not true. The `.ge-frontoffice`
   docblock in ppbf-golden-era.css says "--accent-strong now resolves to
   bronze". The browser says `#B8912F`.

   The fix is small -- restate the three aliases inside each `.ge-*` block, or
   have those call sites read the rung directly -- but it is a change to CSS
   and to a shipped visual contract, and this branch is tests and CI wiring
   only. Recorded here, raised on the PR, fixed by a change that is allowed to
   touch the sheet. */
const FROZEN_ALIAS =
  'A :root token alias (--accent / --accent-strong, aliased to var(--brass-N)) '
  + 'is substituted at :root and inherits as a finished legacy colour, so no '
  + 'scope override can reach it. See THE FROZEN ALIAS above. Stylesheet '
  + 'defect; not this branch to change.';

/* THE OTHER ONE, AND IT IS THE SIMPLER STORY. A legacy brass rung spelled
   straight into a Tailwind arbitrary value -- `bg-[rgba(212,175,74,.10)]`,
   `border-[color:rgba(212,175,74,.42)]`. There is no token in it, so no scope
   can override it: this is precisely the hole
   src/design/brassAlphaChannel.test.ts closed across the stylesheets, reopened
   from the JSX side, which that guard does not scan (it reads the design-system
   sheets and app/globals.css, not components).

   Worth noting which way this cuts. Where the same literal appears in JSX on an
   element the scope DOES restate -- `.ge-drillcase .mat-leather--raised ul li`,
   `.ge-afterhours .mat-leather` -- the scope wins and the leak never reaches
   the screen. That is why one of those chips is a named component probe above:
   it proves the scope closing a leak, not merely avoiding one. Where the scope
   has no rule for the element, the literal paints. */
const JSX_LITERAL =
  'A legacy brass rung spelled into a Tailwind arbitrary value in JSX. No token, '
  + 'so no scope can reach it, and brassAlphaChannel.test.ts does not scan '
  + 'components. Application code; not this branch to change.';

const KNOWN_LEAKS: Readonly<Record<string, readonly KnownLeak[]>> = {
  '.ge-frontoffice': [
    {
      key: 'button | background-color | rgb(184, 145, 47)',
      source:
        'apps/web/app/globals.css -- `--accent-strong: var(--brass-500)` on :root, painted by the '
        + 'active tab of the people console (`bg-[var(--accent-strong)]`)',
      why: FROZEN_ALIAS,
    },
  ],
  '.ge-floorboard': [
    {
      key: 'button | background-color | rgb(169, 129, 38)',
      source:
        'apps/web/app/globals.css -- `--accent: var(--brass-600)` on :root, painted by the coach '
        + 'workspace\'s current tab and mode buttons (`bg-[var(--accent)]`)',
      why: FROZEN_ALIAS,
    },
  ],
  /* `.ge-afterhours` HAD TWO ENTRIES AND NOW HAS NONE. Both were
     `border-[color:rgba(212,175,74,…)]` in apps/web/app/admin/shadow/page.tsx
     -- the console masthead rule, the evidence divider and the dashed upload
     drop zone. This PR spells them `rgb(var(--brass-400-rgb) / …)`, so the
     scope reaches them and /admin/shadow now sweeps clean: the measured set is
     `[]`, which is why the scope is absent from this ledger rather than
     present with an empty list. The ledger is checked in BOTH directions, so
     leaving the entries here after fixing them would fail exactly as loudly as
     a new leak -- that is the check working, and it is how these four came to
     be deleted. */
};

/* ---- The surfaces ------------------------------------------------------- */

/** One named component inside a scope, and the paint property that has to
    carry golden-era metal on it. Chosen from what the surface actually
    renders, and deliberately from SHARED furniture -- .btn, .input, .frame,
    .mat-paper, .mat-leather -- because shared furniture is what a token scope
    claims to re-skin, and where a leak shows up first. */
interface ComponentProof {
  readonly selector: string;
  readonly property: (typeof PAINT_PROPERTIES)[number];
  readonly note: string;
}

interface ScopeCase {
  readonly scope: string;
  readonly route: string;
  /** A selector that is only present once the surface has finished rendering. */
  readonly ready: string;
  /** A string only the STUBBED data can put on the page. Matched against
      textContent rather than innerText: several of these voices are
      `text-transform: uppercase`, which innerText applies and textContent
      does not, and a casing rule is not what this is asking about. */
  readonly renders: string;
  readonly session: PilotSessionStub | null;
  readonly routes: PilotApiStubs;
  readonly components: readonly ComponentProof[];
  /** Set when the route's role check runs on the SERVER against Postgres. */
  readonly serverGuarded?: boolean;
}

const ATHLETES = [
  { athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' },
  { athlete_id: 'ath-devon', full_name: 'Devon Pierce' },
];

const SCOPES: readonly ScopeCase[] = [
  {
    scope: '.ge-bell',
    route: '/login',
    ready: '.ge-bell .frame',
    // The Bell is the one public surface here: it has no stubbed data to
    // render, so its own masthead is what proves it got past the gate.
    renders: 'The Bell',
    session: null,
    routes: {},
    components: [
      { selector: '.frame', property: 'background-image', note: 'the riveted brass door around the sign-in card' },
      { selector: '.btn--kiosk', property: 'background-image', note: 'the kiosk sign-in button metal' },
    ],
  },
  {
    scope: '.ge-floorboard',
    route: '/coach/environment/intake-router',
    ready: '.ge-floorboard .mat-leather',
    renders: 'Rosa Delgado',
    session: { role: 'coach' },
    routes: { '/api/pilot/athletes/list': { ok: true, items: ATHLETES } },
    components: [
      { selector: '.mat-leather button', property: 'background-image', note: 'a tab plaque screwed to the slate board' },
      { selector: '.mat-leather', property: 'border-top-color', note: 'the aged wood surround of the board' },
    ],
  },
  {
    scope: '.ge-drillcase',
    route: '/coach/drills',
    ready: '.ge-drillcase .mat-leather',
    renders: 'Straight jab retraction',
    session: { role: 'coach' },
    routes: {
      '/api/pilot/drills': {
        ok: true,
        items: [
          {
            organization_id: 'org-punxsy',
            drill_id: 'drill-1',
            name: 'Straight jab retraction',
            category: 'Striking',
            focus: 'Quick fist return to protect the chin after the jab.',
            cues: ['Elbow tucked', 'Snap the fist back'],
            difficulty: 'beginner',
            active: true,
            created_at: '2026-08-20T10:00:00.000Z',
            updated_at: '2026-08-20T10:00:00.000Z',
          },
        ],
      },
    },
    components: [
      { selector: '.btn', property: 'background-image', note: 'the ghost button back to the coach workspace' },
      { selector: '.input', property: 'border-top-color', note: 'the drill-name field keyline' },
      {
        // The JSX spells this border as a legacy literal
        // (`border-[color:rgba(212,175,74,.22)]`) and the scope's own rule
        // beats it. That makes this the single best-earning probe on the
        // surface: it proves the scope closes a leak rather than merely
        // avoiding one.
        selector: '.mat-leather--raised ul li',
        property: 'border-top-color',
        note: 'a coaching-cue chip, whose JSX border is a legacy literal the scope has to beat',
      },
    ],
  },
  {
    scope: '.ge-scheduler',
    route: '/schedule',
    ready: '.ge-scheduler > div',
    renders: 'Tuesday Fundamentals',
    session: { role: 'coach' },
    routes: {
      '/api/pilot/athletes/list': { ok: true, items: ATHLETES },
      '/api/pilot/scheduler': {
        ok: true,
        role: 'coach',
        athlete_id: null,
        classes: [
          {
            class_id: 'class-1',
            title: 'Tuesday Fundamentals',
            start_at: '2026-09-01T22:00:00.000Z',
            end_at: '2026-09-01T23:00:00.000Z',
            location: 'Main floor',
            capacity: 16,
            coach_account_id: 'coach.jane',
            status: 'open',
            registered_count: 4,
          },
        ],
        registrations: [
          {
            registration_id: 'reg-1',
            class_id: 'class-1',
            athlete_id: 'ath-rosa',
            requested_by_role: 'coach',
            parent_reviewed: true,
            status: 'registered',
            created_at: '2026-08-20T10:00:00.000Z',
          },
        ],
        coaching_requests: [
          {
            request_id: 'req-1',
            athlete_id: 'ath-devon',
            preferred_at: '2026-09-02T22:00:00.000Z',
            goals: 'Footwork under pressure.',
            status: 'pending',
            assigned_coach_account_id: null,
            created_at: '2026-08-20T10:00:00.000Z',
          },
        ],
        attendance: [
          {
            attendance_id: 'att-1',
            class_id: 'class-1',
            athlete_id: 'ath-rosa',
            status: 'present',
            method: 'coach_override',
            note: '',
            checked_in_at: '2026-08-20T22:05:00.000Z',
          },
        ],
      },
    },
    components: [
      { selector: '.btn', property: 'background-image', note: 'the primary action metal on the schedule board' },
      { selector: '.input', property: 'border-top-color', note: 'a class-detail field keyline' },
      {
        selector: '.mat-leather--raised',
        property: 'background-image',
        note: 'a torn parchment session card, with a brass rivet at every corner',
      },
    ],
  },
  {
    scope: '.ge-frontoffice',
    route: '/admin/people',
    ready: '.ge-frontoffice .mat-leather',
    // The register prints a coach by their sign-in email, not by their
    // account id, so this is the string the stub actually puts on the page.
    renders: 'jane@example.org',
    session: { role: 'organization_admin' },
    routes: {
      '/api/pilot/admin/staff': {
        ok: true,
        organization_id: 'org-punxsy',
        guardian_links: [],
        members: [
          {
            account_id: 'coach.jane',
            login_email: 'jane@example.org',
            auth_provider: 'microsoft',
            role: 'coach',
            athlete_id: null,
            active_flag: true,
            has_pin: false,
            membership_active: true,
          },
          {
            account_id: 'ath.rosa',
            login_email: null,
            auth_provider: 'ppbf_local',
            role: 'athlete',
            athlete_id: 'ath-rosa',
            active_flag: true,
            has_pin: true,
            membership_active: true,
          },
        ],
      },
      '/api/pilot/admin/athlete-pin-directory': {
        ok: true,
        items: [
          { athlete_id: 'ath-rosa', full_name: 'Rosa Delgado', account_id: 'ath.rosa', account_active: true },
        ],
      },
    },
    components: [
      {
        // THE PROPERTY THE ORIGINAL LEAK WAS FOUND ON. A browser probe caught
        // this very border resolving rgba(212, 175, 74, 0.42) while the same
        // element's --brass-500 was correctly bronze. It must read
        // rgba(190, 148, 64, 0.42) -- golden brass-400 -- and nothing else.
        selector: '.btn--ghost',
        property: 'border-top-color',
        note: 'the desk button keyline: the exact property the historic .ge-frontoffice leak was found on',
      },
      { selector: '.frame', property: 'background-image', note: 'the screwed oak register frame and its bronze bead' },
      {
        selector: '.mat-paper',
        property: 'background-image',
        note: 'the register sheet, whose margin rule is bronze ink and never the reserved red',
      },
    ],
  },
  {
    scope: '.ge-scripts',
    route: '/coach/session-scripts',
    ready: '.ge-scripts article',
    renders: 'Tuesday Fundamentals Script',
    session: { role: 'coach' },
    routes: {
      '/api/pilot/session-scripts': {
        scripts: [
          {
            organization_id: 'org-punxsy',
            script_id: 'script-1',
            lineage_id: 'lineage-1',
            version: 1,
            name: 'Tuesday Fundamentals Script',
            discipline: 'boxing',
            theme: 'Guard recovery',
            phase: 'build',
            day_of_week: 'tuesday',
            total_minutes: 60,
            contact_structure: 'no_contact',
            target_group: 'Beginners',
            prerequisite_note: 'Wraps on before the first block.',
            reset_protocol: 'Two minutes seated, water, then re-enter.',
            coach_priorities: 'Hands back to the chin after every combination.',
            frequent_phrases: 'Snap it back.',
            authoring_state: 'published',
            source_document: 'packet-004a',
            created_by_account_id: 'coach.jane',
            created_at: '2026-08-20T10:00:00.000Z',
            updated_at: '2026-08-20T10:00:00.000Z',
          },
        ],
      },
      // No session in progress. The page disables starting until this check
      // succeeds, and an unstubbed default would leave it in the
      // "could not be checked" state rather than on the clipboard.
      '/api/pilot/session-scripts/runs': { run: null },
    },
    components: [
      { selector: '.plaque', property: 'background-image', note: 'the engraved bronze state plate on a script card' },
      { selector: 'article', property: 'border-top-color', note: 'the clipboard sheet edge' },
      { selector: 'header', property: 'border-bottom-color', note: 'the rule under the masthead' },
      { selector: '.btn--ghost', property: 'border-top-color', note: 'the back-to-drill-library button keyline' },
    ],
  },
  {
    scope: '.ge-afterhours',
    route: '/admin/shadow',
    // The instrument bezel only exists once the metrics panel has its data,
    // so waiting on it waits for the surface this scope was drawn for.
    ready: '.ge-afterhours .gauge-bezel',
    renders: '82.4%',
    session: { role: 'organization_admin' },
    routes: {
      '/api/pilot/shadow/metrics': {
        metrics: {
          period: 'last_30_days',
          effectiveness: {
            unavailableReasons: {},
            avgRecommendationScore: 82.4,
            libraryUtilization: 0.61,
            topicsWithGoodCoverage: ['guard recovery'],
            concernedTopics: [],
          },
          engagement: {
            unavailableReasons: {},
            dailyActiveUsers: 12,
            avgMessagesPerSession: 4.2,
            feedbackRate: 0.31,
            usersByTier: { bronze: 6, silver: 4, gold: 2 },
            newUsersThisPeriod: 3,
          },
          safety: {
            unavailableReasons: {},
            highRiskFlagCount: 0,
            escalationsToHuman: 1,
            flaggedTopicsNeedingReview: [],
          },
          growth: {
            unavailableReasons: {},
            avgComplexityProgression: 0.4,
            profileCompletionRate: 0.72,
            tierAdvancementCount: 2,
            totalInteractions: 418,
            positiveOutcomeRate: 0.88,
            filterRate: 0.074,
            avgSatisfaction: 4.31,
            reviewedOutcomes: 26,
            researchRequirementsCreated: 5,
            researchRequirementsClosed: 3,
            newLibraryPatterns: 7,
          },
        },
      },
    },
    components: [
      {
        selector: '.gauge-bezel',
        property: 'background-image',
        note: 'the night console\'s instrument bezel -- the object Golden Era 006 is built around',
      },
      { selector: '.mat-leather', property: 'border-top-color', note: 'a console panel edge' },
      { selector: '.btn', property: 'background-image', note: 'the primary action metal on the night console' },
      { selector: '.input', property: 'border-top-color', note: 'a console field keyline' },
    ],
  },
  {
    scope: '.ge-locker',
    route: '/athlete/dashboard',
    ready: '.ge-locker',
    renders: 'Athlete',
    session: { role: 'athlete', athleteId: 'ath-rosa' },
    routes: {},
    serverGuarded: true,
    components: [
      { selector: '.mat-leather', property: 'border-top-color', note: 'the locker carcass' },
    ],
  },
];

/* ---- The reader --------------------------------------------------------

   One page.evaluate per surface, returning everything the assertions need.
   Split across several round trips it would read a DOM that could have moved
   between them; the golden-era rooms animate nothing, but a proof that
   depends on that staying true is a proof waiting to flake. */
interface ScopeReading {
  readonly present: boolean;
  readonly rendersStubbedData: boolean;
  readonly elementCount: number;
  readonly scopeRamp: Record<string, string>;
  readonly rootRamp: Record<string, string>;
  readonly components: Record<string, { readonly found: boolean; readonly value: string }>;
  readonly leaks: readonly string[];
  readonly reservedRed: readonly string[];
}

interface ReaderInput {
  readonly scopeSelector: string;
  readonly renders: string;
  readonly rungNames: readonly string[];
  readonly paintProperties: readonly string[];
  readonly componentKeys: readonly (readonly [string, string])[];
  readonly legacyNeedles: readonly string[];
  readonly redNeedles: readonly string[];
}

function readScope(page: Page, scopeCase: ScopeCase): Promise<ScopeReading> {
  const input: ReaderInput = {
    scopeSelector: scopeCase.scope,
    renders: scopeCase.renders,
    rungNames: Object.keys(GOLDEN_ERA_RAMP),
    paintProperties: PAINT_PROPERTIES,
    componentKeys: scopeCase.components.map((component) => [component.selector, component.property] as const),
    legacyNeedles: LEGACY_NEEDLES,
    redNeedles: RESERVED_RED_NEEDLES,
  };

  return page.evaluate((arg: ReaderInput): ScopeReading => {
    const scope = document.querySelector(arg.scopeSelector);
    if (!scope) {
      return {
        present: false,
        rendersStubbedData: false,
        elementCount: 0,
        scopeRamp: {},
        rootRamp: {},
        components: {},
        leaks: [],
        reservedRed: [],
      };
    }

    /* The same canonicalisation as `squash` out in Node, restated here because
       page.evaluate serialises this callback and nothing declared outside it
       is in scope. `color(srgb f f f)` -> `rgb(R, G, B)` first, whitespace
       stripped second: the float form has to keep its separators long enough
       to be parsed. */
    const flatten = (value: string) => value
      .replace(
        /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)([^)]*)\)/g,
        (_match: string, r: string, g: string, b: string) =>
          `rgb(${Math.round(Number(r) * 255)}, ${Math.round(Number(g) * 255)}, ${Math.round(Number(b) * 255)})`,
      )
      .replace(/\s+/g, '');
    const scopeStyle = getComputedStyle(scope);
    const rootStyle = getComputedStyle(document.documentElement);

    const scopeRamp: Record<string, string> = {};
    const rootRamp: Record<string, string> = {};
    for (const rung of arg.rungNames) {
      scopeRamp[rung] = scopeStyle.getPropertyValue(rung).trim().toLowerCase();
      rootRamp[rung] = rootStyle.getPropertyValue(rung).trim().toLowerCase();
    }

    const components: Record<string, { found: boolean; value: string }> = {};
    for (const [selector, property] of arg.componentKeys) {
      const element = scope.matches(selector) ? scope : scope.querySelector(selector);
      components[`${selector}|${property}`] = element
        ? { found: true, value: getComputedStyle(element).getPropertyValue(property) }
        : { found: false, value: '' };
    }

    /* The sweep. Reported as a deduplicated, sorted list of
       `tag::pseudo | property | value` so the assertion's diff reads as the
       set of DISTINCT wrong paints rather than as a wall of repeats -- and so
       the failure NAMES THE PROPERTY, which is the whole point of a leak
       report.

       TWO ECHOES ARE FOLDED AWAY BEFORE REPORTING, and neither of them can
       hide a leak:

         * the four `border-*-color` sides collapse to one `border-color` when
           they are equal, which they are whenever a single `border` or
           `border-color` declaration set them. Four identical lines describing
           one declaration is noise, and noise is what gets a gate deleted.
         * a property that merely inherited `currentColor` is not reported --
           only `color` is. `border-color`, `outline-color`,
           `text-decoration-color` and `column-rule-color` all default to the
           element's own `color`, so one wrong `color` used to report eight
           times per element and three times again for its pseudo-elements.
           The `color` entry still reports it, so the leak is still named; a
           border that was EXPLICITLY set to a wrong value differs from `color`
           and survives the fold. */
    const CURRENT_COLOR_DEFAULTED = [
      'border-color',
      'outline-color',
      'text-decoration-color',
      'column-rule-color',
    ];
    const BORDER_SIDES = ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];

    const nodes: Element[] = [scope, ...Array.from(scope.querySelectorAll('*'))];
    const leaks = new Set<string>();
    const reservedRed = new Set<string>();

    for (const element of nodes) {
      for (const pseudo of ['', '::before', '::after']) {
        const style = getComputedStyle(element, pseudo || undefined);
        const ownColor = style.getPropertyValue('color');

        const sides = BORDER_SIDES.map((side) => style.getPropertyValue(side));
        const oneBorder = sides.every((side) => side === sides[0]);

        const painted: [string, string][] = [];
        for (const property of arg.paintProperties) {
          if (oneBorder && BORDER_SIDES.includes(property)) continue;
          painted.push([property, style.getPropertyValue(property)]);
        }
        if (oneBorder) painted.push(['border-color', sides[0]]);

        for (const [property, raw] of painted) {
          if (!raw) continue;
          if (property !== 'color' && raw === ownColor && CURRENT_COLOR_DEFAULTED.includes(property)) continue;
          const flat = flatten(raw);
          const key = `${element.tagName.toLowerCase()}${pseudo} | ${property} | ${raw}`;
          if (arg.legacyNeedles.some((needle) => flat.includes(needle))) leaks.add(key);
          if (arg.redNeedles.some((needle) => flat.includes(needle))) reservedRed.add(key);
        }
      }
    }

    return {
      present: true,
      rendersStubbedData: (document.body.textContent ?? '').includes(arg.renders),
      elementCount: nodes.length,
      scopeRamp,
      rootRamp,
      components,
      leaks: [...leaks].sort(),
      reservedRed: [...reservedRed].sort(),
    };
  }, input);
}

const carries = (value: string, needles: readonly string[]) =>
  needles.some((needle) => squash(value).includes(needle));

const legacyRungsIn = (value: string) =>
  Object.entries(LEGACY_ROOT_RAMP)
    .filter(([, hex]) => carries(value, serialisations(hex)))
    .map(([rung, hex]) => `${rung} (${hex})`);

/* ========================================================================== */

test.describe('Golden-era scopes resolve to bronze in a real browser', () => {
  for (const scopeCase of SCOPES) {
    test(`${scopeCase.scope} on ${scopeCase.route}`, async ({ page }) => {
      await installPilotApi(page, { session: scopeCase.session, routes: scopeCase.routes });

      const response = await page.goto(scopeCase.route);
      expect(response?.status(), `expected ${scopeCase.route} to answer`).toBeLessThan(400);

      /* SERVER-GUARDED ROUTES, HANDLED HONESTLY.

         /athlete/dashboard resolves its role inside the Next server
         (`requirePageRole` -> resolvePrincipal -> Postgres). With no database
         in this environment it answers 307 -> /login for everybody, stub or
         not, because a browser-level stub cannot reach a check that runs on
         the server. See SERVER_GUARDED_ROUTES in e2e/support/signIn.ts.

         So `.ge-locker` is NOT proven here, and this spec does not pretend
         otherwise. What it does instead is decide at run time: the proof
         below is written in full, and only an OBSERVED redirect skips it,
         with the reason attached to the run. Point this suite at an
         environment that has a database and the locker proof executes on its
         own, with nothing to remember to re-enable. */
      if (scopeCase.serverGuarded) {
        expect(
          SERVER_GUARDED_ROUTES as readonly string[],
          `${scopeCase.route} is treated as server-guarded here, so it must be listed as one`,
        ).toContain(scopeCase.route);
        test.skip(
          new URL(page.url()).pathname === '/login',
          `${scopeCase.route} is server-guarded (requirePageRole -> Postgres) and answers 307 -> /login `
          + `with no database present, so ${scopeCase.scope} cannot be resolved in this environment. `
          + `The proof in this test is complete and runs unchanged once a database is available.`,
        );
      }

      await page.waitForSelector(scopeCase.ready, { timeout: 20000 });

      /* Wait for the surface's DATA, not only its chrome. These consoles paint
         their panels as soon as the session resolves and fill them a fetch
         later, so `ready` can be on screen while the roster, the register or
         the drill list is still in flight -- and a sweep that ran there would
         report a clean page because there was nothing on it yet. Polled rather
         than asserted on a single snapshot: the first read of this was a
         one-shot check that passed locally and then failed on a faster run,
         which is the definition of a flake rather than of a finding. */
      await expect
        .poll(
          () => page.evaluate(
            (needle: string) => (document.body.textContent ?? '').includes(needle),
            scopeCase.renders,
          ),
          {
            message:
              `expected ${scopeCase.route} to render "${scopeCase.renders}" -- a surface with no data paints `
              + `almost nothing, and a clean sweep over an empty page proves nothing`,
            timeout: 20000,
          },
        )
        .toBe(true);

      const reading = await readScope(page, scopeCase);

      // 1. The scope is on the page, over real content. Everything below is
      //    vacuous without both halves.
      expect(reading.present, `expected ${scopeCase.scope} to be rendered on ${scopeCase.route}`).toBe(true);
      // Re-read in the SAME snapshot the styles below are read from, so the
      // poll above cannot be satisfied by a state the sweep never saw.
      expect(
        reading.rendersStubbedData,
        `expected "${scopeCase.renders}" to still be on ${scopeCase.route} when its styles were read`,
      ).toBe(true);
      expect(reading.elementCount, `expected real content under ${scopeCase.scope}`).toBeGreaterThan(10);

      // 2. The scope wins over the document root -- both halves.
      expect(reading.scopeRamp, `${scopeCase.scope} must resolve the golden-era ramp`).toEqual(GOLDEN_ERA_RAMP);
      expect(reading.rootRamp, ':root must still resolve the legacy ramp').toEqual(LEGACY_ROOT_RAMP);
      expect(reading.scopeRamp['--brass-500']).toBe('#9f7a30');
      expect(reading.rootRamp['--brass-500']).toBe('#b8912f');
      expect(reading.scopeRamp['--brass-500']).not.toBe(reading.rootRamp['--brass-500']);

      // 3. Real shared components inside the scope paint bronze, not legacy gold.
      for (const component of scopeCase.components) {
        const reads = reading.components[`${component.selector}|${component.property}`];
        expect(
          reads?.found,
          `expected ${scopeCase.scope} ${component.selector} (${component.note}) on ${scopeCase.route}`,
        ).toBe(true);
        const value = reads.value;

        expect(
          legacyRungsIn(value),
          `${scopeCase.scope} ${component.selector} — ${component.property} resolved a LEGACY brass rung: ${value}`,
        ).toEqual([]);
        expect(
          carries(value, GOLDEN_NEEDLES),
          `${scopeCase.scope} ${component.selector} — ${component.property} carries no golden-era rung at all: ${value}`,
        ).toBe(true);
        expect(
          carries(value, RESERVED_RED_NEEDLES),
          `${scopeCase.scope} ${component.selector} — ${component.property} paints the reserved safeguarding red: ${value}`,
        ).toBe(false);
      }

      // 4a. The sweep, against the ledger, in both directions.
      const ledger = (KNOWN_LEAKS[scopeCase.scope] ?? []).map((leak) => leak.key).sort();
      expect(
        reading.leaks,
        `legacy brass resolved under ${scopeCase.scope} on ${scopeCase.route}. An entry here that is not in `
        + `KNOWN_LEAKS is a NEW leak; a KNOWN_LEAKS entry missing here has been fixed, and its ledger entry `
        + `must be deleted.`,
      ).toEqual(ledger);

      // 4b. Law 2 — the safety gate's red is not chrome. No ledger, no exceptions.
      expect(
        reading.reservedRed,
        `${SAFEGUARDING_RED} is reserved for MEDICALLY_NOT_ALLOWED and may not be painted as decorative `
        + `chrome on ${scopeCase.route}`,
      ).toEqual([]);
    });
  }
});
