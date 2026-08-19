# Background plates — Plate Set v1-g

Grok generated 2026-08-19 to unblock production after original owner-approved
PNGs were never committed. Wall textures only (layer 0). No lettering.

## Files (JPEG 4:4:4, quiet centre, under ~400KB)

| File | Ground |
|---|---|
| `plate-01-office-01.jpg` | Office plank |
| `plate-02a-floor-landscape-01.jpg` | Floor brick landscape |
| `plate-02b-floor-portrait-01.jpg` | Floor brick portrait |
| `plate-03-clinic-01.jpg` | Clinic |
| `plate-04-board-01.jpg` | Board |
| `plate-05-file-01.jpg` | File cork |
| `plate-06-night-01.jpg` | Night |
| `plate-07-warm-ground-01.jpg` | Warm / on-canvas family |

CSS: `design-system/ppbf.css` PLATES section uses these `.jpg` paths.
Missing files are safe — gradient room grounds still render when `.room` is set.

**Install:** Drive folder `Plate-Set-v1` or run `node scripts/decode-plates.mjs` if `.b64` sidecars are present.

Do not put UI chrome or text on plates.
