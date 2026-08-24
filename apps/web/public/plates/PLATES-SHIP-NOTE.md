# Type B plate ship — branch `grok/plates-type-b-2026-08-24` (unblocked 2026-08-24)

Grok produced real JPEG 4:4:4 files. SharePoint/M365 connector returns renderings only (no downloadable binary, no Graph token in Claude env). Reconstructing from renders is forbidden by plateBinaries doctrine.

## Unblock options (exact producer bytes)

### Option A — preferred: self-contained materializer (no external download if script is present)
If `scripts/materialize-type-b-plates.mjs` is on the branch (embedded version ~934 KB):
```bash
node scripts/materialize-type-b-plates.mjs
```
It writes the six exact JPEGs. Sanity: SOI + EOI.

### Option B — Google Drive (if GitHub materializer not yet full)
- Zip of the six JPEGs + README: https://drive.google.com/file/d/13SfD1RhWQG8yNrEVvZOBQoEDr6m-UkLU/view?usp=drivesdk
- Self-contained materializer (drop into scripts/ then run): https://drive.google.com/file/d/1TkoZNvB7hCmv6XP7NNGENIrg0T4dOagR/view?usp=drivesdk

Download the .mjs, place at `scripts/materialize-type-b-plates.mjs`, run it. Exact bytes, no re-encode.

### Option C — Jason drag-drop
The six files are also in Grok-Plates-Inbox. Drag-drop into GitHub web UI on this branch under `apps/web/public/plates/` (replace existing).

## Exact sizes (must match after materialize)
| Role | File | Dim | Size (B) |
|------|------|-----|----------|
| public/family | plate-07-warm-ground-01.jpg | 1280×720 | 111648 |
| coach/operational | plate-02a-floor-landscape-01.jpg | 1280×720 | 128611 |
| athlete/training | plate-02b-floor-portrait-01.jpg | 405×720 | 44121 |
| admin/data | plate-05-file-01.jpg | 1280×720 | 178682 |
| evidence/film | plate-03-clinic-01.jpg | 1280×720 | 82644 |
| locker | plate-06-night-01.jpg | 1280×720 | 153920 |

Leave untouched: plate-01-office-01, plate-04-board-01.

## Claude steps
1. Checkout branch `grok/plates-type-b-2026-08-24`
2. Obtain materializer (A or B) → run it
3. Confirm sizes + `plateBinaries.test.ts` green
4. Stage the six .jpg, commit if dirty, open PR to main

## Doctrine
This is the producer hand-off of exact bytes. No silent correction. Token `--plate`. No new room--*.

— Grok visual lane, 2026-08-24 13:05 EDT
