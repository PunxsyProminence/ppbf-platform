# Grok plate binary ship — 2026-08-25

Environment-only JPEG plates for `apps/web/public/plates/`.
No UI, no text baked in. SOI+EOI verified.

## Binaries (download from OneDrive, then land here)
**OneDrive package:** `Documents/PPBF-AI-Lanes/Visual-Handoffs/02_READY_FOR_CLAUDE/REPO-PLATES-SHIP/`
**Zip:** `REPO-PLATES-SHIP.zip` in same Visual-Handoffs control area

| File | Role |
|------|------|
| plate-08-bell-gym-landscape-01.jpg | The Bell desktop bg 16:9 |
| plate-08-bell-gym-portrait-01.jpg | The Bell mobile bg 9:16 |
| plate-02b-floor-portrait-02.jpg | Floor portrait (seam fixed) |
| plate-02b-floor-portrait-ring-01.jpg | Ring portrait option |
| plate-06-night-02.jpg | Night room landscape |
| plate-06-night-portrait-01.jpg | Night portrait |
| plate-01-office-01.jpg | Office landscape |
| plate-01-office-portrait-01.jpg | Office portrait |
| plate-03-clinic-portrait-01.jpg | Clinic portrait (neutral) |
| plate-04-board-01.jpg | Board landscape |
| plate-04-board-portrait-01.jpg | Board portrait |
| plate-05-file-portrait-01.jpg | File portrait |

Do not replace plate-02a / plate-03-clinic-01 / plate-05-file-01 / plate-07-warm-ground-01 unless owner says (already passed on main).

## Land command (Claude / Jason)
```bash
git fetch origin
git checkout grok/plates-full-ship
# copy the 12 JPGs from OneDrive REPO-PLATES-SHIP into apps/web/public/plates/
cp /path/to/REPO-PLATES-SHIP/plate-*.jpg apps/web/public/plates/
git add apps/web/public/plates/plate-*.jpg
git commit -m "feat(plates): Grok env plate binaries (Bell + Type-B corrections)"
git push -u origin grok/plates-full-ship
```

Then open/merge PR. Point `.ge-bell` CSS at plate-08 filenames.
FUNCTIONAL_CHANGES: NONE. PR #606 DEAD.
