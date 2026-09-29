> **HISTORY (2026-09-28):** a completed patch: no `.png` plate path remains in the sheets, and `ppbf.css` is now two imports. Current source: `apps/web/public/plates/README.md`.

# One-line CSS plate path patch

In `design-system/ppbf.css` around the Plate Set v1 block (~3398):

Replace every `/plates/plate-….png` with `/plates/plate-….jpg` for the eight inventory files.

Also ensure portrait media query for floor uses `plate-02b-floor-portrait-01.jpg`.
