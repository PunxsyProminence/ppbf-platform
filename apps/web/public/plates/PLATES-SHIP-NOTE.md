# Type B plate ship — branch `grok/type-b-plates-2026-08-24`

**Owner decision 2026-08-24:** Grok owns real JPEG wall plates on its own feature branch. Claude is not the binary courier.

## Get the six real JPEGs onto this branch (pick one)

### Option A — Jason drag-drop (fastest, real binaries)
1. Download the six files from OneDrive  
   `Documents / PPBF-AI-Lanes / Grok-Plates-Inbox /`  
   (or the zip: https://drive.google.com/file/d/1uTexg9iJJkupvGI38S-F20pfbFGzoOc6/view?usp=drivesdk )
2. Open GitHub → this branch → `apps/web/public/plates/`
3. Drag-drop replace these six only (leave plate-01-office and plate-04-board alone)

### Option B — materializer (exact producer bytes, no re-encode)
When the `scripts/plates-type-b-b64/*.jpg.b64` sidecars are fully present:
```bash
node scripts/materialize-type-b-plates.mjs
npx jest src/design/plateBinaries.test.ts
```
Then stage the six modified `.jpg` and push.

## Exact sizes after ship

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
