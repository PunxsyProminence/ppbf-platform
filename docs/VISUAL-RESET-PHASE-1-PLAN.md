# Visual Reset — Phase 1 plan

**Measured against `main` at `a2e9077129fc43fc69a6eaa2b57ba9047ccfeab7`, 2026-08-23.**
Every number below was re-measured at that SHA. None is carried over from an
earlier session.

Owner direction: the "Leather & Brass" aesthetic is no longer the visual
authority. This phase **disconnects the old aesthetic from application-wide
control without redesigning anything**. Nothing here is meant to change how a
screen looks.

---

## 1. Root cause of visual persistence

One sheet holds two unrelated things, and the app imports it whole.

`design-system/ppbf.css` is 3,575 lines and contains, in the same file and the
same unlayered `:root`:

- **neutral mechanics** — the spacing scale, the radius scale, the √φ type
  ladder, the tap-target floor, the reset, form-control geometry;
- **the Leather & Brass identity** — leather, brass, cork, chalkboard, aged
  paper, stains, patina, wood, room walls, lamps, stamps, creases.

`apps/web/app/globals.css:15` imports that sheet, and its `:root` then **aliases
the app's legacy variable names onto it** (`--canvas-tan: var(--canvas-warm)`,
`--black: var(--hide-950)`, and so on). Its own comment states the intent:
pointing the old names at design-system values "re-themes the whole app without
editing a single page."

That is the mechanism. It also runs in reverse: *while the aliases point at
Leather & Brass values, every page in the app is Leather & Brass whether or not
anyone touches it.* You cannot retire the aesthetic by editing pages, and you
cannot delete the sheet without taking the mechanics with it.

There is a second, compounding effect. `ppbf.css` is **unlayered** while
Tailwind's utilities sit in `@layer`. Layer order resolves before specificity,
so any ppbf class beats a same-property Tailwind utility regardless of how the
class list is written. Re-measured at this SHA: **45 call sites** put a
`min-h-[…]` utility on an element that also carries `.btn`, out of **582**
`.btn` uses. The utility loses at all 45.

---

## 2. The measured split — what is mechanics, what is identity

`var()` call sites across `apps/web/app` and `apps/web/components`: **7,952**.

| Class | Family | Call sites |
|---|---|---:|
| **Mechanics** | `--s0…--s9` spacing | 4,089 |
| | `--t-*` type ladder | 977 |
| | `--r-*` radius | 759 |
| | `--tap` touch floor | 59 |
| | **subtotal** | **5,884** |
| **Identity** | `--bone/hide/brass/patina/rust/paper/canvas-*` | 1,665 |
| | `--locked / --cleared / --restricted / --monitor` | 114 |
| | **subtotal** | **1,779** |

Class-level identity: **499** `mat-leather`, **27** `on-canvas`, **5**
`mat-brass`, **0** `mat-cork`, **0** `aged-*` in app source.

**74% of token usage is neutral mechanics.** That is the single most important
number in this document: the foundation is not something to be written, it is
something to be *extracted*. It already exists and 5,884 call sites depend on
it under exactly these names.

The 114 safety tokens are the boundary case the owner direction calls out
explicitly. `--locked` is not decoration — it is the safety gate's red, and
`docs/FRONTEND_STYLE_CONTRACT.md` Law 2 exists to stop it being spent on
furniture. Safety semantics survive; their *palette* is the new system's to
choose.

---

## 3. Old-system files

| File | Lines | Disposition |
|---|---:|---|
| `design-system/ppbf.css` | 3,575 | split (see §5) |
| `design-system/fonts.css` | 54 | `@font-face` for Alfa Slab One, Oswald, Special Elite, Caveat — legacy personalities |
| `design-system/fonts/*.woff2` | — | the shipped faces |
| `apps/web/app/globals.css` | 2,428 | alias layer; the disconnection point |
| `design-system/components/`, `screens/`, `foundations/`, `index.html`, `manifest.json` | — | showroom previews, legacy reference |
| `apps/web/components/uiStyles.ts` | — | pre-design-system helper, already "do not extend" |

`ppbf.css` has a clean internal seam. Sections `MATERIALS` (289–625),
`ON CANVAS` / `ON PLASTER` (870–1045), `ROOMS` (1218–1393), and everything from
`WOOD` (1394) to `LIGHT` (1723+) — wood, fixtures, ledger, nameplate, keytag,
photo, clipping, crease, aging — are **pure aesthetic**. `TOKENS` (30–270),
`RESET` (271–286), `TYPE` (626–675), `CONTROLS` (788–869) and `LAYOUT` (1195)
are where the mechanics live, mixed with identity only inside the `:root` token
block.

---

## 4. Neutral mechanics that must survive

Structural, accessibility and responsive behaviour, to be carried into the
foundation under **the same token and class names**, because renaming them is a
7,952-site edit:

box sizing and reset · accessible focus · `--tap` minimum control size ·
spacing scale · radius scale · √φ type ladder · form-control geometry and
normalisation · disabled-state affordance · screen-reader utilities ·
reduced-motion · responsive/layout primitives (`--split-minor`,
`--split-major`) · loading / error / empty-state distinction · status semantic
*hooks* without a prescribed palette · non-colour status channel (glyph +
uppercase label, Law 3) · print legibility.

### The room problem — flagged for a decision

`room--*` appears in **99 files** (78 `room--office`, 27 `room--floor`, 16
`room--lit-center`, 12 `room--board`, 10 `room--clinic`, 9 `room--night`, 7
`room--file`). It is **both** things at once:

- **aesthetic** — `.room--office` paints a stained plank wall, `.room--clinic`
  varnished cabinetry under a green-shaded lamp;
- **structural** — `buildingMap.ts` files every door under a `room:`, and
  `buildingMapRooms.test.ts` fails when the door's room and the page's painted
  room disagree. `roomBaseClass.test.ts` additionally requires `.room` and
  `.room--X` always to appear together.

So the room *taxonomy* is a functional part of the navigation registry, while
the room *materials* are retiring aesthetic. **Phase 1 keeps the taxonomy and
the class names, and changes nothing about either.** Whether the new visual
system keeps "rooms" as a concept is Jason's call, not mine — it would
invalidate a nav contract enforced by two tests, so it is listed in §11.

---

## 5. Proposed architecture

```
design-system/
  legacy/
    ppbf-leather-brass.css   ← the aesthetic sections, moved verbatim
    legacy-fonts.css         ← moved from fonts.css
    README.md                ← the warning banner
  foundation/
    ppbf-foundation.css      ← mechanics, extracted verbatim
  current/
    ppbf-theme.css           ← the seam. Phase 1: re-exports legacy.
  ppbf.css                   ← becomes: @import foundation; @import current
```

`ppbf.css` **keeps its path and keeps working**. Every existing consumer —
`globals.css`, the showroom previews, `manifest.json`, `build-manifest.mjs` —
resolves unchanged. That is deliberate: a path change and a content change in
one step would make any regression impossible to attribute.

`current/ppbf-theme.css` is the whole point. Today it re-exports the legacy
sheet, so **Phase 1 is visually a no-op**. When the new system is authored, it
replaces that one import, and the app stops being Leather & Brass in one
reviewable line — without a 99-file edit.

### globals.css, before and after

**Before:** `@import tailwindcss` → `@import ppbf.css` (mechanics + aesthetic,
unlayered) → `:root` aliases legacy app names onto Leather & Brass values.

**After:** `@import tailwindcss` → `@import ppbf.css` (→ foundation + current
theme) → the same `:root` alias block, **annotated as a closed vocabulary**:
existing aliases keep resolving so no page breaks, and the anti-regression
guard refuses any *newly introduced* use of them.

That is the "compatibility required by existing pages remains temporarily
supported" requirement, done by guard rather than by deletion.

---

## 6. Anti-regression guard

A new test that classifies legacy vocabulary and fails on **newly introduced**
use while tolerating untouched debt:

- vocabulary: `room--*` materials, `mat-leather*`, `mat-brass*`, `mat-cork*`,
  `aged-*`, legacy-only font families, and the deprecated `:root` aliases;
- baseline: the measured counts in §2 recorded as a frozen ceiling per family,
  so existing debt passes and any increase fails;
- output: exact file and exact token/class, not a bare count;
- **must be demonstrated RED** by a deliberate known-bad mutation, then GREEN
  once removed. No mutation evidence, no claim that it works.

---

## 7. The one mechanical risk, stated plainly

**Three guard tests read `design-system/ppbf.css` with `readFileSync` and do
not resolve `@import`:** `designSystemClasses.test.ts:17,106`,
`familyPlateGround.test.ts:82`, `plateVariant.test.ts:45`. `designSystemClasses`
exists precisely because "a merge deleted 1,562 lines of ppbf.css and nothing
noticed."

Splitting the sheet **will** make those three fail, because the rules they look
for will no longer be in that file's text. They are controls, so they get
corrected, not bypassed: a small shared reader that concatenates the sheet with
the files it imports. Correcting a guard's implementation is legitimate; the
proof that it is still a control is that it must **still go red when a rule is
genuinely deleted**, and that mutation is part of the evidence.

If that correction turns out not to be clean, the split does not proceed and I
report it rather than weakening a guard to fit the plan.

---

## 8. Open visual PRs

| PR | Branch | Classification |
|---|---|---|
| **#573** | `grok/store-public-ground` | **FUNCTIONALLY REUSABLE / VISUALLY REWORK** — puts `/store` on the family ground, i.e. built on the retired aesthetic. Its structure and tests stand; its materials do not. Do not merge unchanged. |
| **#556** | `admin-visual-set-1` | **FUNCTIONALLY REUSABLE / VISUALLY REWORK** — adds `<WorkAxis />` plus three tests. The foot is a semantic list (`role="list"`, "The work axis"), not a material, so it largely survives; its styling follows the new system. |
| **#534** | `css-layer-collision-audit` | **UNRELATED — and now a prerequisite.** It measures the unlayered-CSS collision set with Tailwind as the oracle. That measurement is *more* useful after the split, not less. |
| #559, #507, #545, dependabot ×5 | — | **UNRELATED** to the visual system. |

None is closed or rewritten. Classification only, per the direction.

---

## 9. Explicitly not in this phase

No redesign. No page conversions. No new aesthetic. No change to APIs, auth,
permissions, schema, migrations, readiness/RPE behaviour, SHADOW logic, training
holds, safeguarding, medical logic, data semantics, route purpose, or any real
application action. No deploy. No merge without Jason's normal flow.

**Visual appearance is UNVERIFIED** and stays that way: this repo has no
screenshot baselines by design — Chromium shaping noise measured larger than a
real regression — so "it still looks the same" cannot be asserted from source or
tests here. Phase 1 is built to be a visual no-op precisely because that claim
cannot be checked automatically.

---

## 10. Verification to be run

Re-measured collision counts · legacy vocabulary counts · foundation usage ·
`npm run typecheck` · `npm run lint` · full `npm test` · production build ·
relevant E2E · RED mutation proof for every new guard, and for the corrected
readers in §7.

---

## 11. Owner decisions — ANSWERED 2026-08-23

All four were decided the same day. Recorded here rather than left as open
questions, because the guards below now encode them.

**1. Rooms — retired as a VISUAL concept.** Screens are no longer required to
paint `room--office`, `room--clinic` and the rest. The taxonomy stays in
`buildingMap.ts` as *structural metadata*, explicitly so the visual reset does
not turn into a routing rewrite. The new system does not have to look like
rooms.

*Implemented:* `buildingMapRooms.test.ts`'s "does not let the roomless set
grow" is retired — deleted rather than weakened, since a test that no longer
expresses a rule should not be left in a shape that implies it does. The drift
check for surfaces that still paint one is untouched, and
`legacyVisualVocabulary.test.ts` now caps `room--` at 143 occurrences across 88
files. Rooms may leave; they may not spread.

**2. Fonts — the personality faces retire with the aesthetic.** Archive first;
delete only after the new system is integrated and verified. Neutral body/data
typography is preserved until the new system specifies replacements.

*Implemented:* `design-system/fonts.css` → `design-system/legacy/legacy-fonts.css`;
the `.woff2` files stay on disk. A guard fails on any app file naming a retired
face in code (comments are stripped first — `app/layout.tsx` explains in prose
which face arrives by which route, and a guard that cannot tell an explanation
from a dependency earns an allowlist, which is what eventually hides a real
one). **There are five faces, not four**: `UnifrakturCook` ships from the same
folder and the same sheet for the clinic masthead. It is archived with the
other four; say so if it was meant to survive.

**One live binding is recorded, not removed.** `app/layout.tsx` loads
`oswald-var.woff2` through `next/font` as `--font-tactical-display`, which
`globals.css` reads for `--font-stencil` and `--font-ui`. That is a real
rendering dependency, and cutting it now would change how the app looks — which
decision 2 defers. It is pinned to exactly one binding and is the line to
delete when the new system supplies a display face.

**3. Safety palette — semantics preserved, colours not.** `locked`,
`restricted`, `monitor`, `cleared` keep their meanings; their Leather & Brass
values are not preserved for compatibility. Every state keeps a non-colour
channel. No replacement palette is to be invented before the Grok board is
approved.

*Implemented:* `safetySemanticsSurviveTheThemeSwap.test.ts` requires the
incoming theme — whatever it is — to define all four rungs and their ink pairs
in a document-wide `:root`, and to keep `.badge` and its uppercase label. **It
asserts no colour at all**, deliberately: pinning a hex would be inventing the
palette one test at a time. The old values still render today because
`current/` still imports the archive; they leave when it does.

**4. `PRODUCT_CAPABILITIES.json` — yes, as a separate bounded PR**, contents
unaltered. Not folded into the visual reset.

*Status:* not in this PR, by instruction.

## 12. Superseded — the questions as originally posed

1. **Do "rooms" survive as a concept?** The taxonomy is wired into
   `buildingMap.ts` and enforced by two tests across 99 files. Keeping the
   names costs nothing now; dropping them later is a nav-contract change.
2. **Do the four shipped display faces retire with the aesthetic?** Alfa Slab
   One, Oswald, Special Elite and Caveat are the golden-era personalities, and
   they ship as `.woff2` in this repo. Body/data faces (Roboto Condensed, Geist
   Mono) are self-hosted through `next/font` and are neutral enough to keep.
3. **What replaces the safety palette?** `--locked`, `--cleared`,
   `--restricted`, `--monitor` carry meaning, not decoration, and one of them —
   `--locked` — is reserved by a locked 2026-08-19 decision for
   `MEDICALLY_NOT_ALLOWED` alone. The new system must supply colours that keep
   those four separable, including in greyscale.
4. **Is `PRODUCT_CAPABILITIES.json` entering the repo?** It is owner-approved
   and currently untracked, and it is the only canonical statement of approved
   product direction the visual work could be checked against.
