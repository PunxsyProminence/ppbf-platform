# Plate Set v1-g — commit into public/plates/

**Date:** 19 Aug 2026 · Grok  
**Finding:** Owner-approved Plate Set v1 was never in the repo and **not on Drive**. Only README + CSS paths existed.

## Images (ready)
Google Drive folder: **Claude-Instructions / Plate-Set-v1**  
(or search Drive: `Plate-Set-v1`)

| File | Room |
|------|------|
| plate-01-office-01.jpg | office |
| plate-02a-floor-landscape-01.jpg | floor landscape |
| plate-02b-floor-portrait-01.jpg | floor portrait |
| plate-03-clinic-01.jpg | clinic |
| plate-04-board-01.jpg | board |
| plate-05-file-01.jpg | file |
| plate-06-night-01.jpg | night |
| plate-07-warm-ground-01.jpg | warm / on-canvas family |

Format: JPEG 4:4:4, ~1920×1080 (portrait 1080×1920), under ~400KB, quiet centre, **no text**.

## Claude: commit steps
1. Download all 8 JPGs from Drive `Plate-Set-v1` into `apps/web/public/plates/`
2. Patch `design-system/ppbf.css` plate URLs from `.png` → `.jpg`:

```css
/* Plate Set v1-g — locked inventory (jpg). */
.room--office { --plate: url("/plates/plate-01-office-01.jpg"); }
.room--floor  { --plate: url("/plates/plate-02a-floor-landscape-01.jpg"); }
.room--board  { --plate: url("/plates/plate-04-board-01.jpg"); }
.room--file   { --plate: url("/plates/plate-05-file-01.jpg"); }
.room--clinic { --plate: url("/plates/plate-03-clinic-01.jpg"); }
.room--night  { --plate: url("/plates/plate-06-night-01.jpg"); }
/* portrait */
.room--floor { --plate: url("/plates/plate-02b-floor-portrait-01.jpg"); } /* under orientation portrait media */
.on-canvas { --plate: url("/plates/plate-07-warm-ground-01.jpg"); }
```

3. Keep shell fix: base `.room` so `::before` / `::after` (light + plate) attach.
4. Commit + deploy. Rooms should look different without inventing UI chrome.

## Honesty
README said frozen / do not regenerate. Original binaries were **missing**. These are **v1-g wall textures** to unblock production. Swap later if true photography set appears.

Tagline: OBSERVE. DECIDE. EXECUTE. REPEAT.
