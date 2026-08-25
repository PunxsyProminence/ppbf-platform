# Full plate ship — land now (2026-08-25)

## Files in this folder (12 real JPEGs)
plate-08-bell-gym-landscape-01.jpg   # The Bell desktop 1280×720
plate-08-bell-gym-portrait-01.jpg    # The Bell mobile  810×1440
plate-01-office-01.jpg               # Office upgrade
plate-01-office-portrait-01.jpg      # Office portrait (new)
plate-02b-floor-portrait-02.jpg      # Floor portrait seam fix
plate-02b-floor-portrait-ring-01.jpg # Floor ring option
plate-03-clinic-portrait-01.jpg      # Clinic portrait
plate-04-board-01.jpg                # Board upgrade
plate-04-board-portrait-01.jpg       # Board portrait
plate-05-file-portrait-01.jpg        # File portrait
plate-06-night-02.jpg                # Night landscape
plate-06-night-portrait-01.jpg       # Night portrait

## Land (2 minutes)

1. Create branch:
   git fetch origin
   git checkout -b grok/plates-full-ship-2026-08-25 origin/main

2. Copy ALL 12 files into:
   apps/web/public/plates/

3. One CSS change (Bell stand-in → real plate-08):
   File: design-system/current/ppbf-golden-era.css
   Replace the two .ge-bell.on-canvas::after background-image urls with:
     landscape → /plates/plate-08-bell-gym-landscape-01.jpg
     portrait  → /plates/plate-08-bell-gym-portrait-01.jpg

4. Commit + push + open PR to main.

Leave alone: plate-02a-floor-landscape-01, plate-03-clinic-01, plate-05-file-01, plate-07-warm-ground-01.

FUNCTIONAL_CHANGES: NONE
