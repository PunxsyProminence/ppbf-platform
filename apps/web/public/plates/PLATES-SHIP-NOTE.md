# Type B plate ship — branch `grok/type-b-plates-2026-08-24`

**Owner decision 2026-08-24 (visual/plate delivery governance):**  
Grok owns the complete approved visual path, including real JPEG wall-plate binaries.  
Claude is **not** the binary courier. This PR is the Grok producer hand-off.

## How the real JPEGs land (exact producer bytes)

```bash
# from repo root on this branch
node scripts/materialize-type-b-plates.mjs
```

The materializer + `scripts/plates-type-b-b64/*.jpg.b64` carry the six exact 4:4:4 JPEGs Grok produced. It writes them to `apps/web/public/plates/` with SOI + EOI checks. **No re-encode.**

Then run:
```bash
# apps/web
npx jest src/design/plateBinaries.test.ts
```

After green, stage the six modified `.jpg` and commit them on this branch (or let the next push do so).

## Exact sizes (must match after materialize)

| Role | File | Dim | Bytes |
|------|------|-----|-------|
| public/family | plate-07-warm-ground-01.jpg | 1280×720 | 111648 |
| coach/operational | plate-02a-floor-landscape-01.jpg | 1280×720 | 128611 |
| athlete/training | plate-02b-floor-portrait-01.jpg | 405×720 | **44121** (quiet empty centre, no lettering) |
| admin/data | plate-05-file-01.jpg | 1280×720 | 178682 |
| evidence/film | plate-03-clinic-01.jpg | 1280×720 | 82644 |
| locker | plate-06-night-01.jpg | 1280×720 | 153920 |

Leave untouched: `plate-01-office-01.jpg`, `plate-04-board-01.jpg`.

## Laws (unchanged, enforced by plateBinaries.test.ts)

- Real JPEG: SOI + EOI, >8 KB, ≤400 KB
- 4:4:4 (no chroma subsampling)
- Geometry matches filename orientation
- Quiet centre, zero lettering, one room material
- Token: `--plate` (not `.plate`)
- No new `room--*` classes

## What this PR does / does not

- Does: ship exact producer Type B plates on a Grok feature branch (new governance path).
- Does not: touch schema, APIs, auth, AGENT_KERNEL, functional code, or weaken the byte gate.
- Does not: invent rooms or re-encode images.

— Grok visual lane, 2026-08-24
