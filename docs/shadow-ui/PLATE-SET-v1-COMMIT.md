# Plate Set v1-g — commit into public/plates/

**Date:** 19 Aug 2026 · Grok  
**Finding:** Owner-approved Plate Set v1 was never in the repo and **not on Drive**. Only README + CSS paths existed.

## Images (ready, in-repo)

**No Drive required.** Base64 sidecars live in `apps/web/public/plates/*.jpg.b64`.

Run from repo root:

```bash
node scripts/decode-plates.mjs
```

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

Format: JPEG, quiet centre, **no text**. (Full-res 1920 variants also generated; current commit uses compact web-ready sizes that still cover at `background-size: cover`.)

## Claude: commit steps
1. `node scripts/decode-plates.mjs`  (decodes the .b64 already in repo)
2. Patch `design-system/ppbf.css` plate URLs from `.png` → `.jpg` (one-liner on the 8 declarations + portrait media query):

```css
/* Plate Set v1-g — locked inventory (jpg). */
.room--office { --plate: url("/plates/plate-01-office-01.jpg"); }
.room--floor  { --plate: url("/plates/plate-02a-floor-landscape-01.jpg"); }
.room--board  { --plate: url("/plates/plate-04-board-01.jpg"); }
.room--file   { --plate: url("/plates/plate-05-file-01.jpg"); }
.room--clinic { --plate: url("/plates/plate-03-clinic-01.jpg"); }
.room--night  { --plate: url("/plates/plate-06-night-01.jpg"); }
/* portrait */
@media (orientation: portrait) {
  .room--floor { --plate: url("/plates/plate-02b-floor-portrait-01.jpg"); }
}
.on-canvas { --plate: url("/plates/plate-07-warm-ground-01.jpg"); }
```

3. Keep shell fix: base `.room` so `::before` / `::after` (light + plate) attach.
4. Optionally `git add apps/web/public/plates/*.jpg` and commit so production build has binaries without a decode step.
5. Deploy. Rooms should look different without inventing UI chrome.

See also: `docs/shadow-ui/PLATES-INSTALL.md`

## Honesty
README said frozen / do not regenerate. Original binaries were **missing**. These are **v1-g wall textures** to unblock production. Swap later if true photography set appears.

Tagline: OBSERVE. DECIDE. EXECUTE. REPEAT.
