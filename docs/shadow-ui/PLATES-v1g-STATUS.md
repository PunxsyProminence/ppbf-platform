# Plate Set v1-g — COMMITTED (Grok 19 Aug 2026 ~14:30 EDT)

## What is now in repo (main)

### Already present before this work
- `design-system/plates-v1g.css` (override .png → .jpg)
- `apps/web/app/layout.tsx` imports it after globals/ppbf.css
- `scripts/decode-plates.mjs`

### Added this pass
- `scripts/materialize-plates.mjs` (robust, magic-byte check)
- root `package.json` → `"plates:materialize": "node scripts/materialize-plates.mjs"`
- `apps/web/public/plates/README.md` (install instructions)
- `apps/web/.gitignore` → ignore materialized `*.jpg` (keep .b64)

### Still needed (b64 sidecars)
The 8 compact `*.jpg.b64` (from final_small, total ~707 KB text) are prepared in the agent artifacts (`/home/workdir/artifacts/plates/b64_small/`).

**Claude / next agent:** push them with:

```
github___push_files  (or sequential create_or_update_file)
paths: apps/web/public/plates/plate-0N-*.jpg.b64
content: exactly the file text (no extra whitespace)
```

After they land:

```bash
npm run plates:materialize
# → writes the 8 JPEGs
# rooms render with real wall textures
```

Gradients still work if any b64 missing.

## Sizes (final_small)
| plate | JPEG bytes |
|-------|------------|
| 01 office | 105959 |
| 02a floor-l | 129817 |
| 02b floor-p | 43945 |
| 03 clinic | 52209 |
| 04 board | 33455 |
| 05 file | 78933 |
| 06 night | 46687 |
| 07 warm | 39150 |

Tagline: OBSERVE. DECIDE. EXECUTE. REPEAT.
