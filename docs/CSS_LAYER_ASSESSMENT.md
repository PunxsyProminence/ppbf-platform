# Can `design-system/ppbf.css` move into `@layer components`?

**Assessment only. No CSS and no application code was changed by this work.**

Baseline: `origin/main` at `a11ea7c1`. Verified on that commit before writing:
`npm test` from `apps/web` — 539 suites / 6917 tests, exit 0. `npm run typecheck` —
exit 0, read as its own exit code, not through a pipe.

Nothing in this document was seen rendered. The sandbox proxy blocks outbound
HTTPS, so no claim here about a visual outcome has been confirmed in a browser.
Every statement is reasoning from source and from the CSS cascade rules, plus one
local Tailwind compile used only to read what the compiler emits.

---

## Verdict

**Staged — and the staging order is the opposite of the obvious one.**

The flip is mechanically sound. It is not safe as a first commit and it is not
off the table. The correct sequence is *empty the collision set first, flip
last*, so that the commit that adds `layer(components)` is a provable no-op at
every site rather than a bet on 300-odd of them.

The single largest risk is not visual. It is that **the repository's own cascade
tests parse the stylesheet text and would stay green while being wrong** about
the sheet the app actually ships. Details in §7.

---

## 1. Is `ppbf.css` genuinely unlayered? Yes — the premise is correct

Three independent confirmations:

1. **The sheet itself declares no layer.** `grep -n "@layer" design-system/ppbf.css`
   returns only prose matches inside comments — no `@layer` at-rule anywhere in
   3,498 lines. The only at-rules that open a block are `@media`, `@keyframes`,
   and one `@import` (`./fonts.css`, line 28).

2. **The import site adds none.** `apps/web/app/globals.css` line 15:

   ```css
   @import "../../../design-system/ppbf.css";
   ```

   A plain import, directly after `@import "tailwindcss";` on line 1. No
   `layer()` function, no wrapping block. `app/layout.tsx` line 3 imports
   `./globals.css` and nothing else; there is no second CSS entry point in the
   app.

3. **The built output confirms it.** In the local build chunk
   `apps/web/.next/static/chunks/31n4l8vuysepk.css` (179,923 bytes) the layer
   at-rules sit at these byte offsets:

   | offset | at-rule |
   |---:|---|
   | 0 | `@layer properties{` |
   | 1823 | `@layer theme{` |
   | 4909 | `@layer base{` |
   | 9596 | `@layer components;` (empty declaration) |
   | 9614 | `@layer utilities{` |

   `.room` appears at offset **87055** — far past the close of every layer block,
   i.e. unlayered, and *after* the utilities layer in source order as well. So
   ppbf.css wins twice over: once for being unlayered, once on order.

   (That chunk is a local build artifact and may be older than `a11ea7c1`; it is
   cited for structure, not for content.)

**So the premise holds and the three cited defects are consistent with it.**
Nothing already wraps the sheet, and nothing needs to be un-wrapped first.

One nuance worth stating, because it changes what "the fix" even means: the sheet
has **eleven consumers, not one**. `design-system/index.html` and the ten preview
files under `design-system/screens/` and `design-system/components/` `<link>` it
directly, `design-system/build-manifest.mjs` parses it, and
`scripts/verify-package-integrity.mjs` structurally validates it. Only the web app
sees Tailwind at all. That argues for making the change at the *import site* in
`globals.css` rather than inside the sheet — which is exactly where the test
hazard in §7 comes from.

---

## 2. The Tailwind setup

- **Version:** `tailwindcss@4.3.2` installed (`package.json` asks `^4.3.3`), with
  `@tailwindcss/postcss@^4` as the only PostCSS plugin (`postcss.config.mjs`).
  Next 16.3.1, Turbopack.
- **Import style:** CSS-first, `@import "tailwindcss"` — **v4**, not v3
  directives. There is no `tailwind.config.*` anywhere in the app.
- **Layers it defines:** compiling `@import "tailwindcss"` with the installed
  compiler emits, in order: `properties`, `theme`, `base`, `components`
  (declared, empty), `utilities`. `components` therefore already exists and
  already sits below `utilities` — the proposed target layer is real and ordered
  correctly. No reordering statement is needed.
- **Where reset CSS lands:** Preflight is inside `@layer base`. There is no
  third-party CSS in the pipeline.

Three facts read off that same compile, because the whole assessment turns on
them:

| utility | compiles to |
|---|---|
| `min-h-screen` | `min-height: 100vh` |
| `bg-[var(--hide-950)]` | `background-color: var(--hide-950)` — **colour only**, no `background-image` reset |
| `text-[color:var(--bone-200)]` | `color: var(--bone-200)` |

---

## 3. The cascade today

Effective precedence, weakest to strongest, for normal (non-`!important`)
declarations:

```
@layer properties        Tailwind --tw-* @property fallbacks
@layer theme             Tailwind design tokens
@layer base              Preflight, + globals.css's TWO @layer base blocks
@layer components        (empty)
@layer utilities         every Tailwind utility in the app
--- unlayered ---------- everything below beats everything above
  design-system/ppbf.css     3,498 lines, all of it
  apps/web/app/globals.css   ~2,370 of its 2,428 lines
```

`globals.css` is **not** layered consistently, and the inconsistency is
deliberate and documented. It uses `@layer base` exactly twice — at line 280 (the
44px interactive-target floor and the `[data-surface="kiosk"]` 55px floor) and at
line 364 (link and focus colours). Everything else in the file, including the
entire `:root` alias block and the `.btn` / `.btn--secondary` override family, is
unlayered on purpose. Its own comment at line 989 says so:

> This sheet is UNLAYERED and @imports ppbf.css at its top, so every rule here is
> later in source order than the rule it has to beat.

Two consequences that matter for the change:

- **`globals.css` is not at risk.** Its unlayered rules currently beat ppbf.css on
  source order at equal specificity. If ppbf.css moves into a layer they beat it
  on layer instead — strictly more robust, not less. Nothing in `globals.css`
  loses ground.
- **The `@layer base` blocks do not move relative to ppbf.css.** `base` is below
  `components` either way, so the interactive-target floor keeps losing to
  ppbf.css exactly as it does today. **The flip does not fix that floor.** It only
  helps the call sites that state their own `min-h-*` utility.
- **The design tokens do not move either.** ppbf.css's `:root` currently beats
  Tailwind's `@layer theme`; in `components` it still beats `theme`.
  `globals.css`'s unlayered `:root` still beats both. The φ type ladder that
  `src/design/typeLadder.test.ts` guards is untouched by the flip.

---

## 4. What `@layer components` would actually flip

### Method and its limits

I extracted every simple single-class rule from ppbf.css with its declared
properties, then scanned all 1,327 non-test `.ts`/`.tsx` files under `apps/web`
for `className` string literals (8,144 of them), and matched, per element, a ppbf
class against a Tailwind utility touching the same property.

**These numbers are approximate.** A string-literal scan misses computed class
names and template-literal composition, and my utility→property map is coarse.
A concurrent agent owns the authoritative bucketing and count; where its number
differs from mine, its number is the real one. The value here is not the total —
it is which buckets are load-bearing and which are provably inert.

Coarse total: **~1,141 unique (file, line, ppbf class, utility) collisions.**
After filtering out matches where the two sides resolve to the *same value*, the
population that would actually change is far smaller — roughly 400, split as
below.

### 4a. Geometry — ~60 sites change, all in the direction the author asked

| count | ppbf rule | utility | today | after |
|---:|---|---|---|---|
| 98 | `.room` `min-height: 100vh` | `min-h-screen` | 100vh | **100vh — no-op** |
| 22 | `.btn--lever` `min-height: 38px` | `min-h-[44px]` | 38px | 44px |
| 24 | `.btn` `min-height: 44px` | `min-h-[var(--tap)]` | 44px | 55px |
| ~14 | `.textarea` `min-height: 46px` | `min-h-[56px]`…`min-h-[144px]` | 46px | 56–144px |
| 1 | `.btn` `min-height: 44px` | `min-h-[44px]` | 44px | **no-op** |

The 98 `.room` / `min-h-screen` pairs are the largest single bucket in the whole
scan and they are **provably inert** — `min-h-screen` compiles to the identical
`100vh`, which the ppbf.css comment says was chosen for exactly that reason.

The 22 `.btn--lever` sites are the *good* half of the change: `.btn--lever` is
still 38px on `a11ea7c1` (ppbf.css line 2206), below the 44px WCAG floor, and it
beats the `@layer base` floor `globals.css` states for it. Twenty-two call sites
already ask for 44px and are being overruled. The flip fixes all of them at once.
Note how `a11ea7c1` fixed the guardian consent case instead: it changed the
*markup* to a class with the right floor. That is the repository's established
remediation, and it is per-site.

The `.btn` → 55px and `.textarea` → larger buckets are real layout movement on
~38 controls. Each is a control growing to the size its own call site requested,
so none is a regression in intent — but 38 controls changing height is visible,
and `.btn--kiosk` / `.input--kiosk` already exist for that job, which means those
call sites are arguably the thing that should change, not the cascade.

Not counted above: `h-[89px]`-style *height* utilities beside a ppbf `min-height`
do not collide at all — `height` and `min-height` are different properties and
the larger already wins today.

### 4b. Colour — ~330 sites change, and this is the real exposure

Of 409 elements carrying both a `text-[color:…]` utility and a ppbf rule that
sets `color`, **330 resolve to different values on the two sides.**

| count | ppbf value | utility value |
|---:|---|---|
| 112 | `.t-body` `--bone-200` | `--bone-300` |
| 52 | `.t-data` `--bone-200` | `--bone-400` |
| 33 | `.t-body` `--bone-200` | `--bone-100` |
| 18 | `.t-data` `--bone-200` | `--bone-300` |
| 17 | `.t-muted` `--bone-400` | `--bone-300` |
| 14 | `.t-body` `--bone-200` | `--bone-400` |
| 12 | `.t-eyebrow` `--brass-400` | `--brass-200` |
| 12 | `.t-body` `--bone-200` | `--brass-300` |
| **10** | **`.room--board` / `.room--file` `--hide-900`** | **`--bone-200`** |
| ~50 | assorted | `--brass-300`, `--locked-ink`, `--restricted-ink`, `--bone-600`, `--hide-700` |

Most of these are within-ramp shifts — a developer asked for a dimmer or brighter
tone on the bone ramp and never got it. Individually small; collectively they move
the contrast of a large fraction of the app's body text at once, on a codebase
whose comments record at least two prior contrast sweeps. Every one of them needs
re-measuring, and a few are outright suspect: three sites on `app/page.tsx` name
`var(--bone-600)`, **which does not exist** — `globals.css` line 2400 states the
bone ramp ends at `--bone-400`. Today ppbf.css wins and the invalid token is
harmless; after the flip those three elements resolve to `unset` and inherit.

**The ten that are certain damage** are the board and file rooms:

```
apps/web/app/board/page.tsx:7
apps/web/app/board/dashboard/page.tsx:20
apps/web/app/board/compliance-monitoring/page.tsx:168
apps/web/app/board/escalation-monitoring/page.tsx:117
apps/web/app/admin/board-seats/page.tsx:340
apps/web/components/BoardMemberDashboard.tsx:123, :145
apps/web/components/BoardRoleGate.tsx:135
apps/web/app/audit/page.tsx:96
apps/web/app/simulator/page.tsx:46
```

Each is `<main className="room room--board … text-[color:var(--bone-200)]">`.
`.room--board` deliberately states `color: var(--hide-900)` because the board
room's top half is light paper (`#C9BBA0`). After the flip these ten surfaces
render bone-200 (`#EFE6D0`) ink on that paper — light on light. This is not
speculative: `apps/web/components/RoleStandaloneView.tsx` lines 199–205 document the
exact rule being relied on —

> The ink colour goes for the same reason: `.room` states `--bone-200`, and
> `.room--board` and `.room--file` deliberately state `--hide-900` over it.

— and the shell strips the utility for precisely this reason. Ten page-level
`<main>` elements never got the same treatment.

### 4c. `.room` specifically — the biggest surface, and mostly a false alarm

`.room` is on ~80 files and 98 `className` sites, and it sets `min-height`,
`color`, `background-color`, `background-image` and `background-blend-mode`. It
looks like the top risk. Measured, it is not:

- **`min-height`** — 98 collisions with `min-h-screen`, all resolving to the same
  `100vh`. Inert.
- **`color`** — 82 collisions, of which 78 are `text-[color:var(--bone-200)]`,
  the identical value `.room` already sets. Inert. Four are `--bone-300`, a mild
  dim. The dangerous ten are the *modifier* inversions in §4b, not `.room` itself.
- **`background-color`** — 83 collisions, all with the same utility,
  `bg-[var(--hide-950)]`, and **all 83 are invisible.** Two independent reasons:
  1. Every room modifier's background-image stack ends in a fully opaque
     `linear-gradient(...)` whose blend mode against the background colour is
     `normal` — `.room--office` `linear-gradient(178deg, #543516, #3E2713, #2A1B0C)`,
     `--floor` `(168deg, #5E2D21 …)`, `--clinic` `(172deg, #55371B …)`,
     `--file` `(178deg, #C89757 …)`, `--night` `(180deg, #1B1410, #0F0C0A)`.
     `.room--board`'s bottom layer *is* `multiply`, but the opaque
     `linear-gradient(180deg, #C9BBA0 … #33200F)` sits above it at `normal` and
     covers both. An opaque image layer hides the background colour entirely.
  2. `bg-[var(--hide-950)]` compiles to `background-color` only. It never touches
     `background-image`, so the gradient wall it would have to defeat is still
     there. And `.room::after` paints an opaque JPEG plate at `z-index: -1`,
     which per CSS painting order lands *above* the element's own background —
     the door-register test states this explicitly.
  Also note `.room--night` already sets `--hide-950`, so seven of the 83 are
  doubly inert.

  These 83 are the "dead background utilities" family the brief mentions. They
  are dead, they would stay dead, and the flip does not resurrect them.
- **`.room > *`** — sets `position: relative; z-index: 1`, which today overrules
  any `absolute` / `sticky` / `z-*` utility on a direct child. Across the 80
  room-painting files only 4 use such a utility anywhere at all (9 tokens), and
  most of those will not be direct children. Low exposure, but the one bucket in
  this section I could not settle statically.

**So `.room` is not the biggest single risk. `.t-*` typography is.** The
`.t-body` / `.t-data` / `.t-muted` / `.t-eyebrow` family accounts for ~300 of the
~330 real colour flips and ~16 font-size flips, and it is spread thin across the
whole app rather than concentrated where a reviewer would look.

### 4d. Provably inert buckets, for completeness

- 33 × `.empty-msg` `margin: 0 auto var(--s5)` vs `mx-auto` — both resolve the
  inline margins to `auto`. No-op.
- 21 × `.field` `display: block` vs the `block` utility. Same value. No-op.
- 57 of the apparent `.t-body` font-size hits are `font-semibold`, which sets
  `font-weight`; `.t-body` does not. Scanner artefact, not a collision.

---

## 5. Rules that must outrank utilities

### 5a. Law 2 safety colour — the strongest argument for an exemption

`.badge` reads `--badge` / `--badge-ink`, set by `.badge--cleared` /
`--monitor` / `--restricted` / `--locked` (ppbf.css 779–782). `.stamp*` and
`.alert--*` work the same way. Law 2 says saturated colour means a participant's
safety state and nothing else; a page that recolours a locked badge is not
expressing a preference, it is misreporting whether a child may participate.

**Today no markup in the app does this** — I found zero elements carrying a
`badge`, `stamp` or `alert` class alongside any `text-[…]` or `bg-[…]` utility,
scanning every quoted string in every non-test `.ts`/`.tsx` file, template
literals included.
So the flip breaks nothing here *now*. What it does is permanently remove the
mechanism that makes it impossible: after the flip, one `bg-[var(--cleared)]` on a
`.badge--locked` silently wins, in a codebase where a wrong safety colour is a
child-safety defect and not a style bug. Also newly beatable: the `--badge` custom
property itself, via an arbitrary-property utility.

This is the one place where "a Tailwind utility can now beat this" is the wrong
outcome on principle rather than on inventory.

### 5b. The `!important` blocks move the *opposite* way — and nobody expects it

For `!important` declarations the cascade **inverts layer order**, and unlayered
`!important` is the weakest author `!important` there is. ppbf.css has two such
blocks: the `@media print` treatment (2,810–2,881, including the four `.badge--*`
safety-ladder rules at 2,861–2,864) and
`@media (prefers-reduced-motion) { * { transition: none !important } }` (1,192).

Today a Tailwind `!`-suffixed utility beats both. Move ppbf.css into `components`
and ppbf.css beats the utility instead. That direction is arguably correct — but
it is a second, opposite-signed behaviour change riding along inside a change
everyone will describe as "utilities now win," and it is not what a reviewer will
have in their head. Exposure is currently one `!`-utility in the app
(`app/knowledge-graph/page.tsx:187`), so this is a comprehension risk more than a
breakage risk. It still belongs in the PR description of whoever does this.

### 5c. Not at risk, despite looking like it

- **The 44px interactive-target floor** (`globals.css` `@layer base`, line 280).
  `base` sits below `components` either way, so its relationship to ppbf.css is
  unchanged. It is worth saying out loud that the flip does **not** fix it: the
  floor still loses to `.btn--lever`'s 38px on every control that does not state
  its own utility.
- **The φ type ladder.** `globals.css`'s unlayered `:root` keeps beating both
  Tailwind's `theme` and a layered ppbf.css. `typeLadder.test.ts` is unaffected.
- **`globals.css`'s `.btn` override family.** Strictly strengthened (see §3).
  Its explanatory comment at line 989 becomes stale and would need rewriting —
  cheap, but it is the file's own account of why it works.

---

## 6. The partial options, assessed honestly

**(a) Layer only part of the sheet.** Mechanically easy — two `@layer components`
blocks with a gap, or a file split. But it puts an invisible cascade seam inside
a 3,498-line stylesheet with no marker at the point of edit. An author adding a
rule 40 lines below the seam gets different behaviour from one adding it 40 lines
above, and nothing in the editor says which. **Worse than doing nothing.**

**(b) Layer everything except one named guardrail block.** Better, because the
exemption is nameable and contiguous: the Law 2 status region plus the two
`!important` `@media` blocks. It says the true thing — *these rules are not
overridable, everything else is* — and it survives review because the boundary
has a reason. It needs a test that fails if a rule crosses the line, or the seam
rots within a quarter. **This is the right end state. It is not the right first
move**, because it still lands all ~330 colour flips in one commit.

**(c) `@layer` plus explicit `!important` on the must-win rules.** The worst of
the three. Because `!important` inverts layer order, a guardrail written as
`!important` inside `components` becomes unbeatable *even by an explicit
`!`-utility at the call site* — strictly more rigid than today, where the call
site can still win. It also puts `!important` into a sheet whose own comment
records that "Nothing uses `!important`." Rejected.

---

## 7. Recommendation: staged, in this order

The flip is the *last* commit, not the first. Sequenced this way, each step is
independently reviewable and the final step changes nothing on screen.

**Step 0 — fix the test harness before anything else. This is the blocker.**

`apps/web/app/parent/consent/targetGeometry.test.tsx` is a real cascade resolver:
it parses both sheets, records which rules are layered, and computes the winner.
It decides "layered" by whether a rule sits **textually inside an `@layer` block
in the file it parsed**.

The safe way to do the flip — `@import "…/ppbf.css" layer(components);` in
`globals.css`, leaving the sheet untouched for its ten non-app consumers —
**changes nothing in the text this test reads.** The test would keep parsing
ppbf.css as unlayered, keep asserting `expect(resolved.layered).toBe(false)`,
keep asserting that `.btn--lever min-h-[44px]` resolves to `38px`, and keep
passing — while the shipped app resolved all of it the other way. A green test
certifying a false model of the cascade is worse than no test.

Wrapping inside the sheet instead makes the test go red immediately, which is the
honest failure mode — but that is the variant that touches the ten preview
consumers, and `design-system/build-manifest.mjs` slices the `:root` block from
`':root {'` to the first `'\n}'`, so any re-indentation of that block breaks
manifest generation.

Either way: teach the resolver to read the **import site**, not the file. Then it
tells the truth under both variants. Six other test files carry the same premise
in prose only (`components/roomBaseClass.test.ts`,
`src/design/typeLadder.test.ts`, and the `admin/platform`, `admin/door-register`,
`admin/consent`, `notices` page tests) and their comments need updating with the
change.

**Step 1 — empty the colour bucket.** Resolve the ~330 differing colour sites at
the call site, the way `a11ea7c1` and `RoleStandaloneView.tsx` already do it:
where the ppbf value is the reviewed one, delete the losing utility; where the
utility is the intent, delete or override the ppbf rule for that surface. Start
with the ten `.room--board` / `.room--file` inversions, which are unambiguous.
Each site resolved this way is a site where the eventual flip changes nothing.

**Step 2 — empty the geometry bucket.** 22 `.btn--lever` sites want 44px:
either raise `.btn--lever` to 44px in ppbf.css (which fixes the remaining `.btn--lever` sites that state no utility at
all — 51 in the app — and is probably the right answer on its own merits)
or move them to `.btn`. The 24 `.btn` + `min-h-[var(--tap)]` sites should say
`.btn--kiosk`, which is what that class is for. The ~14 textareas should carry
their height where the reader can see it.

**Step 3 — name the guardrails.** Bracket the Law 2 status region and the two
`!important` `@media` blocks as the exempt set, with a test that fails if a rule
enters or leaves it (option (b)).

**Step 4 — flip.** `@import "../../../design-system/ppbf.css" layer(components);`
in `globals.css`, guardrails exempt. By this point the diff is a no-op at every
known site and the value is prospective: from here forward the cascade behaves
the way every developer already assumes, and defects 1–3 cannot recur.

### What a reader should check before acting

1. **Do not do steps 1–4 while step 0 is outstanding.** Every later step is
   unverifiable without it.
2. **Get the real collision count from the concurrent scanner**, not from §4 of
   this document. My numbers are a string-literal scan; computed and
   template-literal class names are invisible to it, and the direction of that
   error is *undercounting*.
3. **Re-measure contrast** after step 1. The bone-ramp shifts are individually
   small and collectively cover a large share of the app's body text.
4. **Check `.room > *`** by hand on the four files that use positioning utilities
   inside a room — that bucket is the one I could not settle from source.
5. **Confirm `@font-face` and `@keyframes` behaviour under a layer** in the
   target browsers before step 4. ppbf.css `@import`s `fonts.css`, so a
   `layer(components)` import pulls the `@font-face` rules into the layer too.
   Spec-legal and fine in current engines; the gym-floor kiosk is the machine
   that matters and it was not available here.
6. **Nothing in this document was seen rendered.** Every "invisible" and
   "no-op" above is a cascade computation. Before step 4 lands, the 83 `.room`
   background sites and the ten board/file surfaces deserve one look at a
   deployed URL, which is a thing only Jason can do.

---

## Appendix — what was run

- `git fetch origin main`; assessed at `a11ea7c1`.
- `npm test` in `apps/web` → 539 suites / 6917 tests, exit 0.
- `npm run typecheck` in `apps/web` → exit 0 (raw exit code, not piped).
- One throwaway Tailwind compile in a scratch directory outside the repository,
  used only to read what `min-h-screen`, `bg-[var(…)]` and `text-[color:var(…)]`
  emit and to confirm the layer statement. It compiled `@import "tailwindcss"`
  alone; it did not touch, import, or modify any file in this repository.
- Collision scanning was done with throwaway scripts in a scratch directory.
  Nothing was written to `scripts/` or `apps/web/scripts/`.
- **No speculative flip was applied at any point.** The working tree contains
  exactly one added file: this one.
