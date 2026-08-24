# Type B plate ship — branch `grok/type-b-plates-2026-08-24`

**Owner decision 2026-08-24:** Grok owns real JPEG wall plates on its own feature branch. Claude is not the binary courier.

## Status — 2026-08-24 18:15 EDT (Grok handoff)

**Validated producer JPEGs are ready** in OneDrive:
`Documents/PPBF-AI-Lanes/Grok-Plates-Inbox/`

Exact sizes + SHA-256 (must match plateBinaries.test.ts + GOLDEN-ERA-V1-CONTRACT §9):

| File | Bytes | SHA-256 |
|------|------:|---------|
| plate-02a-floor-landscape-01.jpg | 128611 | 410022d6e7ddccfdd231ffbffc8b66de7df8001bc047253665070a35fd024c68 |
| plate-02b-floor-portrait-01.jpg | 44121 | b3828428a637f1b506f787f3ca1da290c4ed3f3bc3e045bc77a616d845aa2c65 |
| plate-03-clinic-01.jpg | 82644 | e2b4564a8f6a7c8f0ae0dbc3a57189ce58bb7465da017627cfb3ce08a3653cdb |
| plate-05-file-01.jpg | 178682 | 4cd52259c0a4ea4c8b468e28ad30211795fc4f10d43430d04bd0a86507ef465e |
| plate-06-night-01.jpg | 153920 | 9fe30999c4f13629700fc3674c02ffdbe6aaf497feec69df149959579976f448 |
| plate-07-warm-ground-01.jpg | 111648 | 44cf1db174f1a9045ae3da496e185f2b83636642e7d8ac21105a454a3d57d3b3 |

Left untouched: plate-01-office-01.jpg, plate-04-board-01.jpg.

**Current branch still has the previous-generation plates** (different byte sizes). Real binaries have been downloaded into the Grok sandbox artifacts/plates/ and match the table above, but the remote sandbox currently has no capacity for shell (HADES_NO_CAPACITY / boot timeout), so GitHub binary push of the six JPEGs cannot complete this turn.

## Next action (Grok or Jason, ~2 min once capacity returns)
1. Download the six from OneDrive Grok-Plates-Inbox (or use the sandbox artifacts/plates/ copies).
2. Replace only the six files under `apps/web/public/plates/` on this branch.
3. Confirm `plateBinaries.test.ts` green (4:4:4, SOI/EOI, sizes, orientation).
4. Merge after Claude function review + ChatGPT SHA audit.

## Laws (do not weaken)
Real JPEG, SOI+EOI, >8KB, ≤400KB, 4:4:4, orientation matches name, quiet centre, zero lettering, `--plate` token, no new room--*.

No b64 materializer path remains. Claude is not the courier.

## Parallel ship already open
- **PR #598** — Golden Era V1 theme seam (text-only, ready for review). Makes Golden Era the active rendered authority TODAY so Jason can use the app with existing plates while Type B walls land.

— Grok visual lane, 2026-08-24
