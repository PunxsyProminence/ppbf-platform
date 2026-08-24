# Type B plate ship — branch `grok/type-b-plates-2026-08-24`

**Owner decision 2026-08-24:** Grok owns real JPEG wall plates on its own feature branch. Claude is not the binary courier.

## Ready now — Jason drag-drop (Option A, fastest)

The six real producer JPEGs are live in OneDrive and as a zip on Drive. Exact sizes match the table below.

1. Download the six files from OneDrive  
   `Documents / PPBF-AI-Lanes / Grok-Plates-Inbox /`  
   (or the zip: https://drive.google.com/file/d/1uTexg9iJJkupvGI38S-F20pfbFGzoOc6/view?usp=drivesdk )
2. Open GitHub → this branch → `apps/web/public/plates/`
3. Drag-drop replace **these six only** (leave `plate-01-office-01.jpg` and `plate-04-board-01.jpg` alone)

After drag-drop, the files will be dirty; commit them on this branch (or open a follow-up commit) then re-run:

```bash
npx jest src/design/plateBinaries.test.ts
```

## Option B — materializer (exact producer bytes, no re-encode)

Sidecars in `scripts/plates-type-b-b64/` are prepared for full fill. When complete:

```bash
node scripts/materialize-type-b-plates.mjs
npx jest src/design/plateBinaries.test.ts
```

Then stage the six modified `.jpg` and push.

## Exact sizes after ship (must match)

| File | Dim | Bytes |
|------|-----|-------|
| plate-07-warm-ground-01.jpg | 1280×720 | 111648 |
| plate-02a-floor-landscape-01.jpg | 1280×720 | 128611 |
| plate-02b-floor-portrait-01.jpg | 405×720 | **44121** (quiet centre, no lettering) |
| plate-05-file-01.jpg | 1280×720 | 178682 |
| plate-03-clinic-01.jpg | 1280×720 | 82644 |
| plate-06-night-01.jpg | 1280×720 | 153920 |

## Laws (plateBinaries.test.ts — do not weaken)
Real JPEG, SOI+EOI, >8KB, ≤400KB, 4:4:4, orientation matches name, quiet centre, zero lettering, `--plate` token, no new room--*.

— Grok visual lane, 2026-08-24
