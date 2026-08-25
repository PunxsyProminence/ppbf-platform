# Grok plate binary ship — 2026-08-25 (READY)

Environment-only JPEG plates for `apps/web/public/plates/`.
No UI, no text baked in. SOI+EOI verified.

## Download the 12 real JPEGs (1 click)

**Google Drive zip:**  
https://drive.google.com/file/d/1RRIYsHYYSWB7til-Wy_fLJumvaNkBCAt/view?usp=drivesdk

File: `REPO-PLATES-SHIP-FINAL-2026-08-25.zip` (~1.5 MB)  
MD5: `955d39af48a10b787114242f329d58b5`

Also on OneDrive: `Documents/PPBF-AI-Lanes/Visual-Handoffs/02_READY_FOR_CLAUDE/REPO-PLATES-SHIP/`

## Exact files + sizes

| File | Dim | Bytes |
|------|-----|-------|
| plate-08-bell-gym-landscape-01.jpg | 1280×720 | 189771 |
| plate-08-bell-gym-portrait-01.jpg | 810×1440 | 99891 |
| plate-01-office-01.jpg | 1280×720 | 148739 |
| plate-01-office-portrait-01.jpg | 810×1440 | 186248 |
| plate-02b-floor-portrait-02.jpg | 810×1440 | 189337 |
| plate-02b-floor-portrait-ring-01.jpg | 810×1440 | 82185 |
| plate-03-clinic-portrait-01.jpg | 810×1440 | 119124 |
| plate-04-board-01.jpg | 1280×720 | 72943 |
| plate-04-board-portrait-01.jpg | 810×1440 | 104274 |
| plate-05-file-portrait-01.jpg | 810×1440 | 222851 |
| plate-06-night-02.jpg | 1280×720 | 86167 |
| plate-06-night-portrait-01.jpg | 810×1440 | 80048 |

## Land command (Jason — 2 min)

```bash
git fetch origin
git checkout grok/plates-full-ship
# unzip the Drive package, then:
cp REPO-PLATES-SHIP-FINAL/plate-*.jpg apps/web/public/plates/
rm -f apps/web/public/plates/_smoke_binary_test.jpg
git add apps/web/public/plates/plate-*.jpg
git add -u apps/web/public/plates/_smoke_binary_test.jpg
git commit -m "feat(plates): land Grok env JPEGs (Bell + Type-B corrections)"
git push
```

Or drag-drop the 12 JPGs via GitHub web UI onto this branch under `apps/web/public/plates/`.

Then point `.ge-bell` CSS at plate-08 filenames. Run `plateBinaries.test.ts`.

Do not replace plate-02a / plate-03-clinic-01 / plate-05-file-01 / plate-07-warm-ground-01.

FUNCTIONAL_CHANGES: NONE. PR #606 DEAD.
