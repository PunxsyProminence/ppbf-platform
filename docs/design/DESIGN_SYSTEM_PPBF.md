# DesignSystem_PPBF — the app-layer binding

**This is not the design system.** `design-system/README.md` is, and it stays
canonical for the visual language: the eight Laws, the six rooms, the type
ladder, the palette, motion, sound, the paper and light systems. Nothing about
*what the language is* belongs in this file.

This file covers the one thing that document does not: **how `apps/web`
actually consumes it.** The import chain, what the app's own sheet adds on top
and why, which shells wire rooms into pages, which patterns are shared versus
re-typed per page, and where the shipped app has drifted from what the previews
show.

If you are adding to the visual language, edit `design-system/README.md`.
If you are describing how the app binds to it, edit this file.

---

## 1. The import chain

One line does all of it — `apps/web/app/globals.css:15`:

```css
@import "tailwindcss";                       /* line 1 */
@import "../../../design-system/ppbf.css";   /* line 15 */
```

So the sheet the design-system previews render against and the sheet the app
ships are **the same file**. A token value cannot drift between them, because
there is only one copy. `ppbf.css` itself `@import`s `fonts.css`, which resolves
the five self-hosted `.woff2` faces — no CDN, and the floor kiosk renders
offline.

### The cascade-layer interaction, which is load-bearing

`@import "tailwindcss"` puts Tailwind's utilities inside a cascade layer.
`ppbf.css` is imported **unlayered**. Unlayered rules beat layered ones
regardless of specificity, so:

> **A `.room--*` class beats a Tailwind `bg-[var(--canvas-tan)]` utility on the
> same element.**

That is not a quirk to work around — it is why the room system works at all. It
is also the trap: declaring a room on an element that was coloured for cream
will put a plank or cork wall behind cream-tuned content, and the utility you
expected to win will not. `design-system/README.md` records that this was
verified by rendering it, not reasoned about.

Practical rule for a new page: pick the room first, then colour the content for
that room's ground. Do not expect a Tailwind background utility to override one.

---

## 2. What `globals.css` adds on top, and why

Almost all of it is **aliases**, and that is the single most useful thing to
know about this file. Its own header (lines 3–14) says so:

> Everything in the `:root` block that follows is an ALIAS. The app's ~61 pages
> style themselves with Tailwind arbitrary values reading these legacy names
> (`bg-[var(--canvas-tan)]`, `text-[var(--safety-locked)]`), so pointing the old
> names at design-system values re-themes the whole app without editing a single
> page.

| Addition | Where | Why it is not in `ppbf.css` |
|---|---|---|
| Legacy token aliases (`--canvas-tan`, `--safety-locked`, `--status-*`, `--skeleton-bg`, …) | `globals.css:17`–~220 | They carry the ~61 pages written *before* the design system. They are a migration shim, not a second vocabulary. |
| `--status-danger`, `--status-info` | `globals.css:61-62` | `uiStyles.ts` had always referenced these and **neither existed in either sheet**. Anything reaching for them got an invalid substitution — a badge rendering white on transparent. Latent only because the affected exports were unused. |
| Interactive tap floor | `globals.css:223`–`327` | `ppbf.css` sets `min-height` only on `.btn`. The app needed a default across every interactive target, in `@layer base`. |
| Gym-floor 55px targets | `globals.css:296` | Law 5 applied to the app's own components: a child in gloves, a cracked screen. |
| Hard-offset shadows | `globals.css:175` | No design-system equivalent exists, so these stay app-local. |
| Tailwind spacing-step generation | `globals.css:838`–`920` | Maps Fibonacci space onto Tailwind's `--spacing-*` so `.p-4` resolves to a system value. The comment notes the steps **left out** matter more than the ones included. |
| Button hierarchy | `globals.css:920`–`1160` | `ppbf.css` defines `.btn`; the app adds the tier system (ghost / danger / middle / canvas restatement / press / disabled) on top. |
| Retro components, Wall of Names, chalkboard, gym wall, printed paper | `globals.css:489`, `1162`, `1363`, `1500`, `1631` | App-specific compositions built *from* system materials rather than new materials. |

**Adding new work:** use the `ppbf.css` tokens directly (`--hide-*`, `--brass-*`,
`--t-*`, `--s*`). The aliases exist to carry legacy pages, not to be extended.

### One theme, deliberately

`globals.css:22-25` — there is no second palette and no `[data-theme]` override.
Law 6's ink ground is available per-surface via `.mat-leather` / `.on-canvas`,
but that is a material choice per screen, not a user toggle. Do not add a theme
switcher without revisiting that decision.

---

## 3. The shells — and a documented one that does not exist

`design-system/README.md:139-151` lists three shells that wire rooms into pages.
**Only two of them are real.**

| Shell | Path | Status |
|---|---|---|
| `RoleSessionGate` | `apps/web/components/RoleSessionGate.tsx` | Real — **62** pages use it |
| `RoleStandaloneView` | `apps/web/components/RoleStandaloneView.tsx` | Real, takes a `room` prop |
| `BoardMemberDashboard` | `apps/web/components/BoardMemberDashboard.tsx` | Real, sets `.room--board` on its `<main>` |
| `FeatureSurface` | — | **DOES NOT EXIST IN THE REPO** |

`FeatureSurface` is named twice in the canonical README (lines 130 and 145) as
the shell carrying `room="file"` for research and knowledge-graph. It is not in
the repo, and three pages reference it in past tense as scaffolding they *used
to* borrow:

- `app/guardian/page.tsx:18` — "the FeatureSurface scaffold this page used to borrow"
- `app/source-control/page.tsx:86` — "the FeatureSurface cream scaffold it launched on"
- `app/source-control/publication-workflow/page.tsx:80`

It was removed and the README was not updated. **The README's app-wiring table
is stale on this row** — a correction that belongs in `design-system/README.md`,
not here, and is left for whoever owns that file.

### Rooms are mostly *not* applied through the prop

| How a room is declared | Count |
|---|---|
| Via a `room="…"` prop on a shell | **14** (8 `floor`, 3 `clinic`, 1 each `office` / `night` / `file`) |
| `.room--*` class written directly on the page | **68** |

The prop-based path the README describes is the minority. Most pages carry the
class themselves. Neither is wrong — but a reader of the README alone would
expect the opposite ratio, and anyone changing shell behaviour should know that
it reaches roughly a fifth of the room-bearing surfaces.

---

## 4. Shared versus re-typed

`apps/web/components/` holds **86** components. The gap is not in *how many*
exist — it is that the two most-repeated visual patterns have no component at
all.

| Pattern | Shared component | Pages re-typing it inline | Consolidation |
|---|---|---|---|
| Role gating | `RoleSessionGate` | — | Already shared; 62 call sites |
| Alert block (`.alert` + `.alert-icon` + `.alert-body` + title + msg) | **none** | **46** | Highest-value extraction |
| Empty state (`.empty` + glyph + title + msg + action) | **none** | **33** | Second |

Every alert in the app is four nested elements typed out by hand, 46 times. The
markup is identical each time; only the variant class and the two strings
change. Same for the empty state.

This is why `components/designSystemClasses.test.ts` exists and why it fails CI
on an invented class: with no component owning the markup, the only thing
standing between a typo and a silently unstyled alert is that test.

---

## 5. Known drift

The previews are hand-authored mockups. `design-system/README.md` says so
plainly, and warns that "a preview stays correct-looking long after the page it
describes stopped matching it." What follows is the drift measured in the
shipped app, not in the previews.

### Motion: clean

**Zero** literal durations or `transition: …ms` values in `app/` or
`components/`. Every animation runs through the Fibonacci `--m-*` tokens. This
is the part of the system the app honours most completely.

### Hardcoded colours: 40 occurrences across 14 files

These bypass the token layer, so a palette change will not reach them:

`app/board/dashboard/page.tsx`, `app/admin/communications/page.tsx`,
`app/admin/page.tsx`, `app/admin/macro-analytics/page.tsx`,
`app/admin/data-quality/page.tsx`, `app/admin/curriculum/page.tsx`,
`app/admin/shadow/page.tsx`, `app/admin/retro-lab/page.tsx`,
`app/coach/decision-loop/page.tsx`, `app/coach/operations/page.tsx`,
`app/research/page.tsx`, `app/shadow/page.tsx`, `components/WallDisplay.tsx`,
`components/ParentHub.tsx`

`components/CoachWorkspace.tsx:1715` also carries raw
`rgba(212,175,74,.22)` / `rgba(0,0,0,.28)` — brass and ink written out longhand
rather than read from `--brass-*` / `--hide-*`.

### Pending states: two spinners, one off-vocabulary

`design-system/README.md` bans a **bare** spinner: "colour-and-motion-only,
which is exactly what Law 3 bans," and prescribes pairing `.skeleton` or
`aria-busy` with a `.working` text cue.

Both `animate-spin` sites in the app **do** carry a text cue, so neither is a
Law 3 violation:

| Site | Text cue | Verdict |
|---|---|---|
| `components/ParentHub.tsx:473` | `<p className="working">Loading your children…</p>` | Correct — uses the system's own class |
| `components/CoachWorkspace.tsx:1718` | `<p className="t-muted">Loading athletes…</p>` | Accessible, but uses `t-muted` instead of `.working` |

The second is a vocabulary drift rather than an accessibility defect. Worth
correcting so the pending state is greppable as one thing, but it is not
shipping a bare spinner to anyone.

---

## 6. Extraction candidates, ranked

By how many call sites each would consolidate:

1. **`<Alert variant title>` — 46 call sites.** The variant list is closed and
   already enforced: `alert--critical`, `alert--info`, `alert--success`,
   `alert--warning`, `alert--tight`. A component would make the enum a TypeScript
   union instead of a string the CI test has to police after the fact.
2. **`<EmptyState glyph title message action>` — 33 call sites.** The README
   makes an explicit product claim about these ("No pending reviews — all
   athletes cleared" beats a blank screen; every empty list should have an action
   or next step). With the markup hand-typed 33 times, that claim is a
   convention rather than a guarantee.
3. **A pending-state primitive** pairing `.working` with `.skeleton` or
   `aria-busy` — only 2 spinner sites today, but extracting it is what stops the
   third from being written with `t-muted` again.

None of these changes a pixel. Each one converts a convention the CI test
currently polices into something the type system enforces at the call site.

---

## Where to put things

| Kind of change | File |
|---|---|
| A Law, a room, a token value, a material, a type or motion decision | `design-system/README.md` + `design-system/ppbf.css` |
| How `apps/web` consumes any of that; drift; extraction candidates | this file |
| A new preview | `design-system/foundations/` or `components/`, then `npm run design:manifest` |

`design-system/manifest.json` is generated, never hand-edited.
