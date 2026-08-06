# Visual Build Map — the remaining visual work, ordered for efficiency

**Date:** 2026-08-06 · **Built against:** `claude/page-visuals-display-7kaqiu` (PR #240)
· **Predecessors:** the Golden Era pass (Phases 1–5, merged) converted every page
to the design system; this map is what remains *after* that.

**The efficiency argument, up front.** The expensive per-page work is done — all
68 routes already speak Leather & Brass. What remains is mostly **layer work**:
one component or one token fixed in `ppbf.css` and adopted everywhere in the
same PR. A layer touches many files shallowly; a page touches one file deeply.
Layers first, pages only where a page is genuinely missing a surface. Within a
layer, clusters are independent and can run in parallel.

Legend: 🔓 unblocked, can run now · 🔒 blocked on owner input · ⚙ needs an
environment this repo's cloud sessions don't have (dev server + DB).

---

## Layer 1 — The vocabulary (sheet components + same-PR adoption) 🔓

The gaps every Golden Era batch recorded, still open (verified 2026-08-06).
Rule: **nothing lands in `ppbf.css` without its adopters in the same commit** —
a class with no consumer is the `.marquee` lesson again.

Each cluster is independent → parallelizable, one agent each.

| Cluster | Add to sheet | Adopt in | Why it pays |
|---|---|---|---|
| **1a. Stat tile** | `.stat` (label + big mono figure + note) | `RoleSummaryPanels` (all four role KPI rows), `BoardSummaryPanel`, admin hub KPI tiles, athlete progression stats | Every dashboard hand-composes the same three classes; this is the single most-repeated visual pattern in the app |
| **1b. Compact controls** | `.btn--sm`, compact danger lever | Coach review queue rows, admin feedback triage, capability console row actions | Queue rows currently choose between oversized `.btn` and hand-rolled `h-9` |
| **1c. Notices** | `.notice--cleared`, `.alert--tight` | The four hand-assembled confirmation strips (admin pages), inline field errors in compact panels | Same utility string copy-pasted five times and drifting |
| **1d. Type rungs** | `.t-data--lg/--xl`, `.stamp--sm` | KPI figures (removes the `text-[length:var(--t-xl)]` workaround), planned-markers in heading rows | Closes the two documented inline-style workarounds |
| **1e. Ground restatements** | `.on-plaster`, `.mat-paper .t-label` (+ `--card-ink` token) | Board headers on the plaster wall, paper panels inside ink pages, TrainingCard seal | Ends per-page hand-composition on light grounds |
| **1f. Kiosk range** | `.range--kiosk` | The three floor sliders (athlete workspace) | Law 5 currently enforced by hand at each site |

**Output:** one PR (or one per cluster if reviewed separately). Pure
CSS + className swaps; no logic. Test surface already exists.

## Layer 2 — Legibility (contrast fixes, statically checkable) 🔓

The spots the batch reports flagged and nobody fixed. All are token swaps whose
ratios can be computed without a browser (the contrast test infra in
`src/design` already does this):

- `RoleSpecificShadow` prompt line inside on-canvas ParentHub (~2.9:1)
- Evidence-tier bubbles on `/shadow` (stamp ink on light tiers)
- Cork-wall (`room--file`) headings on `/research`, `/knowledge-graph`
- `.working` and `.alert` on canvas (no restatement; invisible bone-on-cream)

**Output:** one small PR. Then ⚙ `npm run sweep` on the owner's machine
confirms against the rendered app — the one step this environment cannot do.

## Layer 3 — Motion & pending-states audit 🔓 (small)

- Panels that still pop instead of settle (grep for transitions off the
  Fibonacci tokens)
- `aria-busy` + `.working` on every submit that lacks a pending state
- Bell/seal ceremony QA notes for the owner to verify on real data

## Layer 4 — Surfaces (page work — only where a page misses a thing)

| Surface | Status | Notes |
|---|---|---|
| **4a. Parent digest module** | 🔓 | The roadmap's "strongest retention mechanic." In-app panel on the parent hub: what the kid worked on, coach recognition, a wall photo. Reads existing data; the one genuinely new visual surface left |
| **4b. Before/after frame** | 🔓 | Athlete card: first-session vs now, empty until history exists. Build the frame; it fills itself |
| **4c. Words on the wall** | 🔒 coach sayings | Module is small; inventing quotes is forbidden. Blocked on the owner collecting real ones |
| **4d. Print parity QA** | ⚙ | `@media print` rules exist per room; need a browser pass per key surface (board packet, guardian report, certificates) |
| **4e. Real photographs** | 🔒 photos | Slots + upload path shipped. Owner points a camera; `/admin/customize` does the rest. Staff card needs a committed file |

## Layer 5 — The external kit (Canva, parallel to everything) 🔓

- Pick the social-card candidate (four corrected drafts exist) → make it a
  reusable template
- Recruiting flyer (canvas ground) and grant-packet cover (ink ground) from
  the same corrected brief
- Both packs (`BRAND_DESIGN_BRIEF.md` + `CANVAS_CONTEXT_PACK.md`) are current
  as of this PR — paste both into any tool

---

## The recommended run order (combo)

```
now, in parallel:   L1 (six clusters fan out) · L5 (Canva, owner picks)
next:               L2 → owner runs sweep ⚙ → fix what it finds
then:               L3 (small) · L4a parent digest · L4b before/after
whenever ready:     L4c sayings 🔒 · L4e photos 🔒 · L4d print QA ⚙
```

L1 and L2 are the highest leverage per hour and fully unblocked. L4a is the
biggest single user-visible addition. Everything 🔒 costs the owner minutes,
not the codebase anything.

**What the owner owes the map:** real gym photos, one staff photo (committed),
coach sayings, one `npm run sweep` run, and a Canva candidate pick.
