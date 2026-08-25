# Provenance — Grok plate binary ship, 2026-08-25

Historical record only. `README.md` in this directory is the authoritative
document for what a plate must be and how one enters the repository; where the
two ever disagree, `README.md` wins.

This file previously carried a Google Drive link, a OneDrive path, and a "land
command" that unzipped a package and copied the plates in. Those instructions
are retired: the bytes are now committed here, and by the standard `README.md`
states, a delivery is bytes on a branch — a link to a zip is not one, and no AI
lane in this project can read a drive from its sandbox anyway.

What is kept is the producer's own manifest, because it is the independent
statement of what each file was supposed to be. Every row below was confirmed
against the committed bytes by `apps/web/src/design/plateBinaries.test.ts`:
dimensions and byte counts match exactly, all twelve carry both JPEG markers,
and all twelve are 4:4:4.

| File | Declared | Declared bytes |
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

`plate-01-office-01.jpg` and `plate-04-board-01.jpg` replaced already-committed
plates of the same name; the other ten are new files. The producer's note asked
that `plate-02a-floor-landscape-01`, `plate-03-clinic-01`, `plate-05-file-01`
and `plate-07-warm-ground-01` be left alone, and they were.

Of the twelve, only the two `plate-08` Bell files were wired to a room in the
landing PR. The rest sit on disk undeclared, which is legal — the gate requires
every CSS-declared URL to exist, not the reverse — and inert until an owner
decides which variant each room takes.
