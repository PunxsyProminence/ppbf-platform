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

**Source of truth in repo:** the `.jpg.b64` sidecars (base64 of the full-quality JPEG).

**Materialize (required for build / local / deploy):**
```bash
node scripts/decode-plates.mjs
```
This writes the 8 `.jpg` files next to the sidecars. Safe to re-run. The web build already runs this automatically before `next build`.

CSS: `design-system/plates-v1g.css` (imported from `apps/web/app/layout.tsx`) overrides any `.png` paths in `ppbf.css` to these `.jpg`.

Missing files are safe — gradient room grounds still render when `.room` is set.

Do not put UI chrome or text on plates.
