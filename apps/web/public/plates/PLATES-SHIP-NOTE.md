# Type B plate ship — branch `grok/type-b-plates-2026-08-24`

**Owner decision 2026-08-24:** Grok owns real JPEG wall plates on its own feature branch. Claude is not the binary courier.

## Status — binaries committed

The six real producer JPEGs are now committed directly on this branch under `apps/web/public/plates/`.

Exact sizes (must match plateBinaries.test.ts):

| File | Dim | Bytes | SHA-256 |
|------|-----|-------|---------|
| plate-07-warm-ground-01.jpg | 1280×720 | 111648 | 44cf1db174f1a9045ae3da496e185f2b83636642e7d8ac21105a454a3d57d3b3 |
| plate-02a-floor-landscape-01.jpg | 1280×720 | 128611 | 410022d6e7ddccfdd231ffbffc8b66de7df8001bc047253665070a35fd024c68 |
| plate-02b-floor-portrait-01.jpg | 405×720 | **44121** (quiet centre, no lettering) | b3828428a637f1b506f787f3ca1da290c4ed3f3bc3e045bc77a616d845aa2c65 |
| plate-05-file-01.jpg | 1280×720 | 178682 | 4cd52259c0a4ea4c8b468e28ad30211795fc4f10d43430d04bd0a86507ef465e |
| plate-03-clinic-01.jpg | 1280×720 | 82644 | e2b4564a8f6a7c8f0ae0dbc3a57189ce58bb7465da017627cfb3ce08a3653cdb |
| plate-06-night-01.jpg | 1280×720 | 153920 | 9fe30999c4f13629700fc3674c02ffdbe6aaf497feec69df149959579976f448 |

Left untouched: plate-01-office-01.jpg, plate-04-board-01.jpg.

## Laws (plateBinaries.test.ts — do not weaken)
Real JPEG, SOI+EOI, >8KB, ≤400KB, 4:4:4, orientation matches name, quiet centre, zero lettering, `--plate` token, no new room--*.

Source of truth for the six: OneDrive Grok-Plates-Inbox + Drive zip (validated by ChatGPT audit: SOI/EOI, 4:4:4, exact sizes, SHA-256 match).

No b64 materializer path remains.

— Grok visual lane, 2026-08-24
