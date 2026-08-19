# Plate Set v1-g — real images (no stubs)

## The problem you reported
`.b64` files on main are 11–41 byte stubs. Paths in previous handoffs pointed at Grok sandbox only.

## The fix (pick one)

### Option A — Recommended (one file, zero external assets)
1. Copy `scripts/materialize-plates.mjs` into your repo root `scripts/materialize-plates.mjs`
   (this 708 KB file embeds all 8 real JPEGs as base64 string literals)
2. Add to `apps/web/package.json`:
   ```json
   "plates:materialize": "node ../../scripts/materialize-plates.mjs",
   "prebuild": "npm run plates:materialize"
   ```
   (adjust relative path if your scripts/ lives elsewhere)
3. Ensure `design-system/plates-v1g.css` is imported after ppbf.css in `app/layout.tsx`
4. Run: `npm run plates:materialize`
5. 8 real JPGs appear in `apps/web/public/plates/`
6. Commit + push + deploy

### Option B — Direct binaries
Copy the 8 `.jpg` files from `apps/web/public/plates/` in this package straight into the same path in the repo and commit them.

### Option C — Real b64 sidecars (replace the stubs)
Copy the 8 `*.jpg.b64` files (44–173 KB each, real content) into `apps/web/public/plates/`, then run `node scripts/decode-plates.mjs`.

## CSS (already prepared)
`design-system/plates-v1g.css` contains:
```css
.room--office { --plate: url("/plates/plate-01-office-01.jpg"); }
.room--floor  { --plate: url("/plates/plate-02a-floor-landscape-01.jpg"); }
.room--board  { --plate: url("/plates/plate-04-board-01.jpg"); }
.room--file   { --plate: url("/plates/plate-05-file-01.jpg"); }
.room--clinic { --plate: url("/plates/plate-03-clinic-01.jpg"); }
.room--night  { --plate: url("/plates/plate-06-night-01.jpg"); }
@media (orientation: portrait) {
  .room--floor { --plate: url("/plates/plate-02b-floor-portrait-01.jpg"); }
}
.on-canvas { --plate: url("/plates/plate-07-warm-ground-01.jpg"); }
```

## Files in this package
- scripts/materialize-plates.mjs   ← embeds all 8 real JPEGs
- design-system/plates-v1g.css
- apps/web/public/plates/*.jpg     ← real images
- apps/web/public/plates/*.jpg.b64 ← real base64 (not stubs)
- scripts/decode-plates.mjs

Tagline: OBSERVE. DECIDE. EXECUTE. REPEAT.
