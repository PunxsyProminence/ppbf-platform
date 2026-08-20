# Background plates — Plate Set v1-g

Delivered and installed 2026-08-19. These are the files the CSS resolves. They
are committed as real JPEGs; there is no decode or materialize step.

Files here are **layer 0 only**: the photographed wall a room stands in. Real UI
composites on top in code. No plate carries lettering, and no plate substitutes
for a stamp, a ticket, or passbook content.

## History worth keeping

An earlier "Plate Set v1" was recorded here as owner-approved and frozen, in PNG
at 2560×1440. **Those files never existed** — not in this repository, and not in
the folder they were attributed to. The CSS referenced eight `.png` paths that
resolved to nothing for as long as the reference stood, and a README described a
set nobody could open.

Two delivery attempts then failed, and both are worth recording so nobody
repeats them:

- base64 sidecars relayed through a chat channel arrived as **11–41 byte stubs**;
- one that looked plausible at 2.3KB had a valid JPEG **header**, no EOI
  **trailer**, and was 600×360 against a 1920×1080 spec — a truncated file that a
  header-only check installs silently.

Binary assets enter this repository by real file upload. Never by re-encoding
through a text channel. Two documents describing the base64 route --
`PLATES-INSTALL.md` and `PLATES-v1g-STATUS.md` -- were deleted on 20 Aug:
every claim in them was false by then (the override sheet, both decode
scripts and the layout import were all gone, and `.jpg` was never actually
gitignored), but they still read as instructions, and instructions for a
dead route are how the next channel repeats a solved mistake.
`docs/GROK-VISUAL-LANE.md` is the live contract; the laws below are
enforced by `apps/web/src/design/plateBinaries.test.ts`. Every file below was verified on install: start-of-image
**and** end-of-image markers present, dimensions parsed from the SOF segment,
size within budget.

## Installed set

| File | Ground | Applied to | Dimensions | Size |
|---|---|---|---|---|
| `plate-01-office-01.jpg` | 1 Office | `.room--office` | 1280×720 | 104 KB |
| `plate-02a-floor-landscape-01.jpg` | 2a Floor | `.room--floor` | 1280×720 | 127 KB |
| `plate-02b-floor-portrait-01.jpg` | 2b Floor | `.room--floor` under `@media (orientation: portrait)` | 405×720 | 43 KB |
| `plate-03-clinic-01.jpg` | 3 Clinic | `.room--clinic` | 1280×720 | 51 KB |
| `plate-04-board-01.jpg` | 4 Board | `.room--board` | 1280×720 | 33 KB |
| `plate-05-file-01.jpg` | 5 File | `.room--file` | 1280×720 | 77 KB |
| `plate-06-night-01.jpg` | 6 Night | `.room--night` | 1280×720 | 46 KB |
| `plate-07-warm-ground-01.jpg` | 7 Warm ground | `.on-canvas` (family surfaces only — T7) | 1280×720 | 38 KB |

The `-01` suffix is a variant slot. See *Adding a variant*.

## Format

- **JPEG**, chroma subsampling disabled (4:4:4). The dark leather and ink wells
  band badly under 4:2:0.
- v1-g ships at **1280×720** landscape / 405×720 portrait, below the 2560×1440
  the original spec called for. On a large desktop display these upscale. That is
  acceptable here: the plate sits behind a gradient wall and carries no detail a
  viewer reads, and the gym tablet is the constraint that matters. Replacing a
  plate with a higher-resolution file is one file swap and no code change.
- **Under ~400KB each.** Each route fetches only its own plate and it caches after
  first visit, so the budget is per-plate, not cumulative.
- Composed with a **quiet centre**: lower contrast and detail through the middle
  where panels land, visual interest in the outer thirds and top edge. A busy wall
  through the centre fights every panel edge placed on it.

## Missing files stay safe

A plate is one more `background-image` layer, and a layer whose URL fails is
simply not painted. With this directory empty the app renders the gradient wall
and the lit pools that `design-system/ppbf.css` builds from scratch.

That is deliberate and load-bearing. The room section of that file states every
room is zero-asset *"so the floor tablet still renders them with no network"*.
Plates are an enhancement over that ground, never a replacement — which is also
why a plate must never be an `<img>` and never carries text.

## Adding a variant

Rooms are reused heavily — office covers 40 routes, floor 31 — so a single wall
repeats a great deal. A second plate for a room is a new file plus one
declaration in the PLATES section of `design-system/ppbf.css`. Nothing else
changes.

If more than one variant per room is ever wired, selection must be
**deterministic** (derived from the route, for instance), never random: a screen
that changes appearance between loads breaks screenshot comparison, print
reproducibility, and a coach's sense that they are on the page they were on a
moment ago.

## Rules that hold regardless

- **One source of truth.** Plate URLs are declared once, in the PLATES section of
  `design-system/ppbf.css`. An override sheet that restated all eight
  declarations was removed on install; do not reintroduce one.
- **T7 — family surfaces take the warm plate or none.** `/guardian`, `/parent`
  and `/public` must not declare any room; every room is non-warm. Enforced by
  `apps/web/components/familyPlateGround.test.ts`.
- **Print strips every plate.** Handled in the `@media print` block; plates are
  pseudo-element backgrounds and `*` does not match pseudo-elements, so they are
  named explicitly there.
- **`prefers-reduced-data` falls back to the gradient wall.**
- **A plate only paints where the base `.room` class is applied.** `--plate` is
  declared by `.room--*` but consumed by `.room::after`, so a page carrying only
  the modifier gets no plate and no light — the defect fixed in #498.
