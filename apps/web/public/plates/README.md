# Background plates — Plate Set v1

Owner-approved 2026-08-16 and **frozen**. Do not regenerate the approved set.
Do not invent a new visual system here.

Files in this directory are **layer 0 only**: the photographed wall a room
stands in. Real UI composites on top in code. No plate carries lettering, and
no plate substitutes for a stamp, a ticket, or passbook content.

## Expected filenames

The CSS resolves these exact paths (`design-system/ppbf.css`, PLATES section).
A file that is absent simply is not painted — see *Missing files* below.

| File | Ground | Applied to |
|---|---|---|
| `plate-01-office-01.png` | 1 Office | `.room--office` |
| `plate-02a-floor-landscape-01.png` | 2a Floor | `.room--floor` |
| `plate-02b-floor-portrait-01.png` | 2b Floor | `.room--floor` under `@media (orientation: portrait)` |
| `plate-03-clinic-01.png` | 3 Clinic | `.room--clinic` |
| `plate-04-board-01.png` | 4 Board | `.room--board` |
| `plate-05-file-01.png` | 5 File | `.room--file` |
| `plate-06-night-01.png` | 6 Night | `.room--night` |
| `plate-07-warm-ground-01.png` | 7 Warm ground | `.on-canvas` (family surfaces only — T7) |

The `-01` suffix is a variant slot. See *Adding a variant*.

## Format

- **PNG**, or maximum-quality JPEG **with chroma subsampling disabled** — the
  dark leather and ink wells band badly under 4:2:0.
- Sized for the largest realistic viewport. The layout is capped at 1600px
  wide, so **2560×1440** covers landscape comfortably; portrait plates want
  roughly **1440×2560**.
- **Under ~400KB each.** Each route fetches only its own plate and it caches
  after first visit, so the budget is per-plate, not cumulative — but the gym
  tablet is the constraint and it is not always on good signal.
- Composed with a **quiet centre**: lower contrast and detail through the
  middle where panels land, visual interest in the outer thirds and top edge.
  A busy wall through the centre fights every panel edge placed on it.

## Missing files are safe

A plate is one more `background-image` layer, and a layer whose URL fails is
simply not painted. With this directory empty the app renders exactly as it
did before Plate Set v1: the gradient wall and the lit pools that
`design-system/ppbf.css` builds from scratch.

That is deliberate and load-bearing. The room section of that file states every
room is zero-asset *"so the floor tablet still renders them with no network"*.
Plates are an enhancement over that ground, never a replacement — which is also
why a plate must never be an `<img>` and never carries text.

## Adding a variant

Rooms are reused heavily — office covers 42 pages, floor 22 — so a single wall
repeats a great deal. A second plate for a room is a new file plus one
declaration in the PLATES section of `design-system/ppbf.css`. Nothing else
changes.

If more than one variant per room is ever wired, selection must be
**deterministic** (derived from the route, for instance), never random: a
screen that changes appearance between loads breaks screenshot comparison,
print reproducibility, and a coach's sense that they are on the page they were
on a moment ago.

## Rules that hold regardless

- **T7 — family surfaces take the warm plate or none.** `/guardian`,
  `/parent` and `/public` must not declare any room; every room is non-warm.
  Enforced by `apps/web/components/familyPlateGround.test.ts`.
- **Print strips every plate.** Handled in the `@media print` block; plates
  are pseudo-element backgrounds and `*` does not match pseudo-elements, so
  they are named explicitly there.
- **`prefers-reduced-data` falls back to the gradient wall.**
