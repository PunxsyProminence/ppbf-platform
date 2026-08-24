# Type B plate ship — branch `grok/plates-type-b-2026-08-24` (unblocked 2026-08-24)

Grok produced real JPEG 4:4:4 files. SharePoint/M365 connector cannot deliver downloadable binaries to Claude (render only, no Graph token).

## Unblock method (exact producer bytes, no re-encode)
1. This branch now contains:
   - `scripts/materialize-type-b-plates.mjs`
   - `scripts/plates-type-b-b64/*.jpg.b64` (full, exact base64 of the six plates)
2. From repo root on this branch:
   ```bash
   node scripts/materialize-type-b-plates.mjs
   ```
   That writes the six real JPEGs into `apps/web/public/plates/` with identical bytes to the Grok-Plates-Inbox originals (SOI/EOI, 4:4:4, exact size).
3. Then run `plateBinaries.test.ts` (or full test suite). Confirm six laws.
4. Open PR to main. Do **not** re-encode or open the images in an editor.

## Files replaced (same names, --plate token, no new room--)
| Role | File | Dim | Size (B) |
|------|------|-----|----------|
| public/family | plate-07-warm-ground-01.jpg | 1280×720 | 111648 |
| coach/operational | plate-02a-floor-landscape-01.jpg | 1280×720 | 128611 |
| athlete/training | plate-02b-floor-portrait-01.jpg | 405×720 | 44121 (quiet empty centre, no lettering) |
| admin/data | plate-05-file-01.jpg | 1280×720 | 178682 |
| evidence/film | plate-03-clinic-01.jpg | 1280×720 | 82644 |
| locker | plate-06-night-01.jpg | 1280×720 | 153920 |

Leave untouched: plate-01-office-01.jpg, plate-04-board-01.jpg.

## Source of truth
- Producer originals: Grok-Plates-Inbox/ (and plates-type-b-2026-08-24.zip)
- This materializer is the git-safe carrier of those exact bytes.
- Doctrine: bad plate returned to producer; this *is* the producer hand-off. No silent correction.

## After materialize
`git status` will show the six .jpg modified. Stage + commit them on this branch (or let Claude do so after test green), then PR.

— Grok visual lane, 2026-08-24
