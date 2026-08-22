# Grok order brief — the visual inventory, compiled

**20 Aug 2026.** Compiled from four independent inventory passes:
`01-image-files.md`, `02-css-drawn.md`, `03-glyphs-and-photos.md`,
`04-room-coverage.md`. Each was measured, not estimated; where they overlapped
they agreed.

Read with `docs/GROK-VISUAL-LANE.md`, which is the contract. This is the work
list; that is the law.

## What exists, by type

| Type | Count | Notes |
|---|---:|---|
| Room background plates (JPEG) | **8** | All verified 4:4:4, SOI+EOI, correct geometry |
| Placeholder illustrations (SVG) | **6** | `public/gym/` — reserved for real photographs |
| Brand marks | **2** | `favicon.ico`, `icon.svg` |
| Social card (PNG) | **1** | `opengraph-image.png` — entirely lettering |
| Research figure (PNG) | **1** | Orphaned; referenced by nothing |
| Scaffold leftovers (SVG) | **5** | `create-next-app` defaults, zero references |
| **Total image files** | **23** | 1.11 MiB. Two PNGs outweigh all eight plates |
| CSS-drawn visual constructs | **110** | Materials, rooms, lamps, rivets, stamps, marks |
| Glyph marks (literal Unicode) | **~20** | No icon library. 171 hand-declared call sites |
| Inline SVG in the app | **1** | The TrainingCard seal |
| Photograph slots | **12** | **Zero currently hold a photograph** |

## The line that must not be crossed

**Twelve slots need a camera, not a generator.** Three of the four passes
found this independently, from different directions.

- six frames of the actual building at 220 N Jefferson St
- the head coach's portrait on `/public`, under "who would be coaching your
  kid" — renders genuinely empty today
- five portrait surfaces fed by `account_profiles`, where most of the faces
  are minors

**The trap:** the six `public/gym/*.svg` placeholders look exactly like a
"generate the real ones" job. They are not. `gymPhotos.ts` reserves those
slots for photographs of the actual building and explicitly forbids
fake-photorealistic imagery, and each file carries `PLACEHOLDER ILLUSTRATION`
baked in against the zero-lettering law. Generating gym interiors would undo a
deliberate decision and put invented pictures of a real nonprofit's building
in front of families.

**Do not commission member portraits either.** `.plate`'s engraved-initials
state is the *primary* state by design, not a fallback: privacy rules mean
most viewers never see a child's face. That is a designed absence, not a
missing asset.

## Orders, ranked

### 1. Re-shoot `plate-02b-floor-portrait-01.jpg` — it is the wrong wall

`02a` and `02b` are both `.room--floor` and they are **not the same room**.
02a is grey-brown brick with caged industrial lamps; 02b is flat red-brown
brick with no fixtures at all. **Rotating a tablet changes the material of the
wall.**

This breaks the contract's own rule — variants come from a shared root
reference, one building on one day — and it is the gym floor, which is the
tablet room. Highest-confidence order available, and it fixes a defect rather
than adding polish.

### 2. Two more office walls

`.room--office` serves **40 routes** on one plate — 38.8% of the room-bearing
building, and the landing room for admin, staff and volunteers. By route
prefix it partitions cleanly **15 / 12 / 13**, so the worst wall goes 40 → 15.

Deliver as `plate-01-office-02.jpg` and `plate-01-office-03.jpg`.

### 3. One more floor wall, as a landscape + portrait pair

**31 routes.** Deliver both orientations from the same root reference so the
rotation defect in order 1 is not repeated. A coach-desk / floor-side split
divides 14 / 17.

### 4. Replace `plate-04-board-01.jpg`

The crudest CSS ground of the six sits under it — a single `linear-gradient`
with a hard stop at 52% putting plaster over wainscot. Most improvement per
file of any single replacement.

### 5. A clinic portrait recut

Nine routes does not justify a second wall, but four of those nine carry Law 5
kiosk controls on upright tablets. `plate-03-clinic-portrait-01.jpg`.

### 6. Re-shoot all eight at full resolution

Shipped at 1280×720 against a 2560×1440 spec. The README already records this
as a known, accepted gap and notes a swap is one file and no code change.

### 7. The PPBF crest — a design, not a raster

The sheet calls the roundel "the most repeated mark in the whole body of
reference art". `.seal` and its four variants are applied **zero** times, and
`TrainingCard.tsx` hand-rolled its own — the only inline `<svg>` in the app.
The deliverable here is a design to be redrawn as SVG markup, not a JPEG.

## Composition notes for any order

- **`plate-06-night` puts its brightest area dead centre.** Low detail there,
  so it passes the letter of the quiet-centre law, but high luminance exactly
  where panels land. Worth correcting on any night re-shoot.
- Every plate is **layer 0 only** — the photographed wall a room stands in.
  Real UI composites on top in code.
- **Zero lettering, ever.** A plate sits behind real text, cannot be
  translated, and is invisible to a screen reader.

## What Grok must NOT make

104 of 110 catalogued visual constructs are **drawn in CSS deliberately** and
would be worse as files: heavier, non-responsive, no light/dark adaptation,
and they break the zero-asset guarantee that lets a gym tablet render a room
with no network. Materials, lamps, rivets, rope, frames, stamps, badges,
gauges, ledgers, torn-note edges, grain and noise are all drawn.

Also out of scope: favicons and brand identity, the OpenGraph card (entirely
lettering), the orphaned research figure (regenerate from data), and the five
scaffold SVGs (delete, do not redraw).

## Route-derived variant selection — BUILT, #541

**Corrected 2026-08-22.** This section previously read "No route-derived
variant selection exists anywhere in this repository… That is Claude's job,
not Grok's, and it should be built before the first variant is ordered." That
was true when this brief was compiled on 20 Aug and **became false the same
day**: PR #541 built exactly that mechanism, hours later. Nobody came back to
update the text. Left standing it would send the visual lane to build
something that already ships.

What exists now:

- `apps/web/components/plateVariant.ts` — hashes the pathname and emits a token
  list (`2of2 1of3 4of4 …`). Deterministic by construction; `plateVariant.test.ts`
  fails the build if `Math.random`, `Date`, a counter or a session id appears
  in that path.
- `apps/web/components/PlateVariantGround.tsx` — one `display: contents` marker
  in the root layout, so every room can read the attribute without gaining a
  box.
- `design-system/ppbf.css` — a "Route-derived variants" block that reads the
  attribute and sets `--plate` per route.

**So a second office plate is now one file plus one CSS declaration.**
`apps/web/public/plates/README.md` states it directly: *"No TypeScript is
edited."* The determinism requirement still holds — a screen that changes
between loads breaks screenshot comparison, print reproducibility, and a
coach's sense of being on the page they were on a moment ago — and it is now
enforced by a test rather than by instruction.

### What #541 does NOT provide, stated so the next reader does not overclaim

#541 proves **deterministic route → *slot* selection**. It does not provide
**route → *specifically named plate* assignment**, and the two are easy to
conflate.

The attribute carries slot tokens only — `data-plate-variant="2of2 1of3 4of4
…"`. It carries no route identity. So a rule can say *"whichever office doors
land in slot 2-of-2 take `plate-01-office-02.jpg`"*, and it cannot say
*"`/coach/workout-templates` takes the chalkboard wall."* Which plate a given
route receives is decided by the hash, not by intent, and the split is
deliberately not authored — `plateVariant.ts` says so directly: *"nothing in
this file changes, ever, for art."*

That is a real constraint on ordering work, not a defect: it was a deliberate
design decision to keep plate counts in the sheet rather than in TypeScript. It
means a brief that wants a **named** wall on a **named** route needs either a
new mechanism or a room reassignment, and neither is a one-line change. Say
which of the two a request needs before ordering the plate.

---
OBSERVE. DECIDE. EXECUTE. REPEAT.
