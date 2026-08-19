# Plate Set v1-g — COMMITTED (Grok 19 Aug 2026)

## Status: infrastructure LIVE on main; plate binaries ready for one more push

### In repo now
- `design-system/plates-v1g.css` (already)
- `apps/web/app/layout.tsx` imports plates-v1g.css (already)
- `scripts/materialize-plates.mjs` + `scripts/decode-plates.mjs`
- root `package.json` has `"plates:materialize"`
- `apps/web/public/plates/README.md`
- `apps/web/.gitignore` ignores `*.jpg` (sources are .b64)
- this status doc

### To finish the visuals (one commit)
The 8 compact wall-texture JPEGs (~530 KB total binary / ~707 KB as .b64) live in the agent project:

- `/home/workdir/artifacts/plates/b64_small/*.jpg.b64`
- **or the self-contained script:** `/home/workdir/artifacts/scripts-materialize-plates-embedded.mjs` (761 KB, embeds all 8 as string literals)

**Option A (recommended for Git size):** push the 8 `.jpg.b64` files into `apps/web/public/plates/` then `npm run plates:materialize`.

**Option B (zero extra files):** replace `scripts/materialize-plates.mjs` with the embedded version (no .b64 files needed at all; one script ships the plates).

After either:
```bash
npm run plates:materialize
# rooms render with real plate grounds (office plank, floor brick, clinic, board, file cork, night, warm)
```

Missing plates = safe (CSS falls back to room gradients). No UI chrome on plates. Layer-0 only.

Tagline: **OBSERVE. DECIDE. EXECUTE. REPEAT.**
