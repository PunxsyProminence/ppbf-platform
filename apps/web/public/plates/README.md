# Background plates — Plate Set v1-g

Grok generated 2026-08-19 to unblock production after original owner-approved
PNGs were never committed. Wall textures only (layer 0). No lettering, no UI chrome.

## Files (JPEG ~1280×720, quiet centre, 33–130 KB each)

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

## Install (required after clone / in CI)

```bash
npm run plates:materialize
# or: node scripts/materialize-plates.mjs
# or: node scripts/decode-plates.mjs
```

This expands the `*.jpg.b64` sidecars in this folder into the JPEGs that
`design-system/plates-v1g.css` (and the --plate custom props) reference.
CSS is already imported from `apps/web/app/layout.tsx` after ppbf.css.

Missing files are safe — gradient room grounds still render when `.room` is set.
The materialized `*.jpg` are gitignored; only the compact `.b64` sources ship.

Do not put UI chrome or text on plates.

Tagline: OBSERVE. DECIDE. EXECUTE. REPEAT.
