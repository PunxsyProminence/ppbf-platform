# Background plates

Layer 0 only: the photographed wall a room stands in. Real UI composites on
top in code; no plate carries lettering or substitutes for a stamp, ticket, or
passbook content. A plate is a `background-image` layer on `.room::after` /
`.on-canvas::after` — never an `<img>`. Missing files are safe by design: with
this directory empty, the gradient wall in `design-system/ppbf.css` renders
every room with no network.

## Installed set (Plate Set v1-g)

| File | Applied to | Dimensions | Size |
|---|---|---|---|
| `plate-01-office-01.jpg` | `.room--office` | 1280×720 | 104 KB |
| `plate-02a-floor-landscape-01.jpg` | `.room--floor` | 1280×720 | 127 KB |
| `plate-02b-floor-portrait-01.jpg` | `.room--floor`, `@media (orientation: portrait)` | 405×720 | 43 KB |
| `plate-03-clinic-01.jpg` | `.room--clinic` | 1280×720 | 51 KB |
| `plate-04-board-01.jpg` | `.room--board` | 1280×720 | 33 KB |
| `plate-05-file-01.jpg` | `.room--file` | 1280×720 | 77 KB |
| `plate-06-night-01.jpg` | `.room--night` | 1280×720 | 46 KB |
| `plate-07-warm-ground-01.jpg` | `.on-canvas` (family surfaces only — T7) | 1280×720 | 38 KB |

## Requirements — enforced by `apps/web/src/design/plateBinaries.test.ts`

- Complete JPEG: start-of-image **and** end-of-image markers, and > 8 KB.
  (Truncated files and relay stubs pass header-only checks; this one doesn't.)
- **≤ 400 KB** per plate. The budget is per-plate: each route fetches only its
  own plate and it caches.
- **No chroma subsampling (4:4:4).** Dark leather and ink wells band under 4:2:0.
- Geometry is one of **1280×720 / 2560×1440** (landscape) or **405×720 /
  810×1440** (portrait); orientation must match the filename (`-portrait-` in
  the name means taller than wide; never square).
- Every `/plates/` URL declared in `design-system/ppbf.css` exists here.

Binary assets enter this repository **by real file upload on the producer's
feature branch, never re-encoded through a chat channel** (`AGENT_KERNEL.md`,
"Working channel"; `docs/GROK-VISUAL-LANE.md`).

## Who ships the real JPEG (owner decision 2026-08-24)

**Grok owns the complete approved visual implementation path, including the
real JPEG wall-plate binaries.**

```
Jason approves plate/design
  → Grok generates the exact ordered asset
  → Grok prepares/verifies the actual JPEG
  → Grok uploads the REAL JPEG directly to its own feature branch
    under apps/web/public/plates/
  → Grok makes only the required approved visual/CSS/test changes
  → Grok opens the PR
  → Claude independently reviews function/security boundaries
  → ChatGPT independently audits PR scope, binary evidence, claims, SHA, CI
  → required CI green on the exact PR head
  → merge → staging
  → Jason live visual review
  → separate release decision
```

**Retired:** Grok → OneDrive Grok-Plates-Inbox → Claude picks up / relays /
commits the binary. Claude is **not** the binary courier. Do not ask Claude to
retrieve, reconstruct, re-encode, or commit plate binaries on Grok's behalf.

The OneDrive folder `Documents / PPBF-AI-Lanes / Grok-Plates-Inbox /` may remain
for provenance/archive. It is no longer a mandatory shipping step.

## Adding a variant

The `-01` suffix is the variant slot. Selection is deterministic from the
route: `apps/web/components/PlateVariantGround.tsx` (one `display: contents`
marker in the root layout) hashes the route and writes
`data-plate-variant="2of2 1of3 …"`; the PLATES section of
`design-system/ppbf.css` states how many plates a room has. To add a second
office plate, drop `plate-01-office-02.jpg` here on a Grok feature branch and
add one rule to the route-derived variants block:

```css
:where([data-plate-variant~="2of2"]) .room--office {
  --plate: url("/plates/plate-01-office-02.jpg");
}
```

No TypeScript is edited. `apps/web/components/plateVariant.test.ts` fails a
variant rule that drops `:where()` (it must stay at specificity (0,1,0) so the
portrait override still wins) or that lands after the orientation block. A
portrait variant goes *inside* the orientation block, after its generic rule.

## Authoritative locations

- Plate URLs and all plate styling: **PLATES section of
  `design-system/ppbf.css`** — the single source of truth; no override sheets.
- Byte gate: `apps/web/src/design/plateBinaries.test.ts` (do not weaken)
- Variant-rule gate: `apps/web/components/plateVariant.test.ts`
- T7 (family surfaces take the warm plate or none):
  `apps/web/components/familyPlateGround.test.ts`
- Producer contract: `docs/GROK-VISUAL-LANE.md`
