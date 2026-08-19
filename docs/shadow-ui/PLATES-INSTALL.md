# Plate Set v1-g — offline install (Claude: no Drive needed)

**Why this exists:** Claude sandbox cannot reach Google Drive (proxy 403s google.com). Plates ship in-repo as base64 sidecars.

## One command (from repo root)

```bash
node scripts/decode-plates.mjs
```

Writes the 8 JPEGs into `apps/web/public/plates/`:

- plate-01-office-01.jpg
- plate-02a-floor-landscape-01.jpg
- plate-02b-floor-portrait-01.jpg
- plate-03-clinic-01.jpg
- plate-04-board-01.jpg
- plate-05-file-01.jpg
- plate-06-night-01.jpg
- plate-07-warm-ground-01.jpg

Sources: `apps/web/public/plates/*.jpg.b64` (already committed).

## CSS

`design-system/ppbf.css` PLATES block must use `.jpg` (not `.png`).  
If still `.png`, do the one-liner replace of the 8 declarations (and the portrait media query).

## After materialize (recommended for CI / production builds)

```bash
node scripts/decode-plates.mjs
git add apps/web/public/plates/*.jpg
git commit -m "assets(plates): materialize Plate Set v1-g JPEGs for production"
```

Or run decode in a postinstall / CI step so binaries stay out of git history if preferred. For fastest deploy, track the JPGs once.

## Shell reminder

Base `.room` class must be present so `::before` (light) and `::after` (plate) attach.  
Rooms must be distinct per ROOM-PURPOSE-DNA.md.

Tagline: **OBSERVE. DECIDE. EXECUTE. REPEAT.**
