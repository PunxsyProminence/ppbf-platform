# Type B plate ship — branch `grok/plates-type-b-2026-08-24` (unblocked 2026-08-24)

Grok produced real JPEG 4:4:4 files. SharePoint/M365 connector returns renderings only (no downloadable binary, no Graph token in Claude env). Reconstructing from renders is forbidden by plateBinaries doctrine.

## Unblock (exact producer bytes, one command)
This branch carries a **self-contained materializer** that embeds the six exact producer JPEGs as base64:

```bash
# from repo root, on this branch
node scripts/materialize-type-b-plates.mjs
```

It writes:

| Role | File | Dim | Exact size (B) |
|------|------|-----|----------------|
| public/family | plate-07-warm-ground-01.jpg | 1280×720 | 111648 |
| coach/operational | plate-02a-floor-landscape-01.jpg | 1280×720 | 128611 |
| athlete/training | plate-02b-floor-portrait-01.jpg | 405×720 | 44121 (quiet empty centre, no lettering) |
| admin/data | plate-05-file-01.jpg | 1280×720 | 178682 |
| evidence/film | plate-03-clinic-01.jpg | 1280×720 | 82644 |
| locker | plate-06-night-01.jpg | 1280×720 | 153920 |

into `apps/web/public/plates/`. Leaves plate-01-office-01.jpg and plate-04-board-01.jpg untouched.

Sanity checks inside the script: SOI (FF D8) + EOI (FF D9) after decode. No re-encode, no editor, no SharePoint.

## Claude steps
1. Checkout `grok/plates-type-b-2026-08-24`
2. `node scripts/materialize-type-b-plates.mjs`
3. Confirm sizes match table + `plateBinaries.test.ts` green
4. `git add apps/web/public/plates/plate-*.jpg` (the six) + commit if needed
5. Open PR to main

## Doctrine
This *is* the producer hand-off of exact bytes. Bad plate returned to producer; materializer never silently corrects.

Token remains `--plate`. No new `room--*`.

— Grok visual lane, 2026-08-24 13:00 EDT
