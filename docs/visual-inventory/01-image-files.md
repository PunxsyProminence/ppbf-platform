# Visual inventory 01 — image files

**Scope:** every committed binary/vector image FILE in this repository. One of four
inventory slices; this one owns image files only — not CSS-drawn surfaces, not SVG
authored inline inside components, not fonts.

**Measured on:** `origin/main` at `a11ea7c166f7659e4c5bb63337d44323069febaa`
("Give the guardian's consent controls the targets they claimed to have (#525)",
2026-08-20). Measured in a clean worktree at that exact SHA.

**How the numbers were produced.** Dimensions come from parsing the JPEG SOF
segment and the PNG IHDR chunk directly in Node, reusing the marker walk already
in `apps/web/src/design/plateBinaries.test.ts`. ICO entries come from the icon
directory (and from the embedded PNG's own IHDR where an entry is PNG-encoded).
SVG "dimensions" are `viewBox` user units — an SVG has no pixel size. Nothing here
is repeated from a README; every figure was re-read off the bytes. This sandbox has
no ImageMagick, no Pillow and no ffmpeg, which is why the parse is hand-rolled.

**Search method for references.** `git grep` across `.ts .tsx .js .jsx .mjs .css
.json .md .html`, plus a reverse sweep that extracts every image-shaped path string
in the codebase and checks it resolves. Both directions, because an orphan file and
a dangling reference are different defects.

**Excluded, as instructed:** `node_modules`, `.next`, build output. Worth stating
plainly — `git ls-files` and an on-disk `find` returned the *same 23 files*, so
there is no untracked or generated image hiding in the tree.

---

## Summary

### By format

| Format | Files | Bytes | Share of image weight |
|---|---:|---:|---:|
| `.jpg` | 8 | 530,155 | 45.6% |
| `.png` | 2 | 584,323 | 50.3% |
| `.svg` | 12 | 22,338 | 1.9% |
| `.ico` | 1 | 25,931 | 2.2% |
| **Total** | **23** | **1,162,747** (1.11 MiB) | |

No `.webp`, no `.avif`, no `.gif` anywhere in the repository.

Note the shape of that table: **two PNG files outweigh all eight room plates
combined**, and one of those two PNGs is an orphan.

### By purpose

| Purpose | Files | Where | Grok's lane? |
|---|---:|---|---|
| Room background plates (wall, layer 0) | 8 | `apps/web/public/plates/` | **YES — this is the lane** |
| Placeholder illustrations awaiting real photographs | 6 | `apps/web/public/gym/` | **NO** — see the judgement below |
| App chrome (favicon, tab icon, social card) | 3 | `apps/web/app/` | **NO** |
| Framework scaffold leftovers — **orphans** | 5 | `apps/web/public/` | **NO** — delete candidates |
| Documentation figure — **orphan** | 1 | `apps/web/seed-data/…/` | **NO** |

**In Grok's scope: 8 files. Out of scope: 15.**

### Orphans found — 6

Nothing here is deleted; this is a report.

| File | Bytes | Why it is an orphan |
|---|---:|---|
| `apps/web/public/next.svg` | 1,375 | `create-next-app` scaffold. Zero references. |
| `apps/web/public/vercel.svg` | 128 | `create-next-app` scaffold. Zero references. |
| `apps/web/public/file.svg` | 391 | `create-next-app` scaffold. Zero references. |
| `apps/web/public/globe.svg` | 1,035 | `create-next-app` scaffold. Zero references. |
| `apps/web/public/window.svg` | 385 | `create-next-app` scaffold. Zero references. |
| `apps/web/seed-data/shadow-research/2026-08-07/fig_intake_seed.png` | 228,649 | Figure shipped with the research seed package. Listed in that package's manifest as a companion figure; not read by its importer. |

The five scaffold SVGs total 3,314 bytes — trivial weight, but they are still public
URLs served under the gym's domain, and `vercel.svg` in particular is another
company's logo sitting in a nonprofit's public directory. The `fig_intake_seed.png`
orphan is the one that costs something: 228 KB, larger than any room plate.

**No dangling references in the other direction.** Every image path declared in CSS
or code resolves to a file that exists. The historical defect recorded in the plates
README — eight `.png` URLs in the sheet resolving to nothing — is fixed and stays
fixed. Image-shaped strings that look unresolved (`ring.jpg`, `me.png`,
`portrait.jpg`, `frame-001.jpg`) are all test fixture literals in
`gymWallModule.test.tsx` and `gymPhotos.test.ts`, never real asset paths.

---

## The judgement: what Grok should and should not be asked to make

The brief asked which of these Grok would ever produce a replacement or variant of.
Three distinct answers, and the middle one is the one that is easy to get wrong.

### 1. The 8 room plates — Grok's lane, and the only one

These are exactly what `docs/GROK-VISUAL-LANE.md` describes: real JPEG wall plates,
layer 0, no lettering, a photographed material a room stands in. Every variant slot
`-02` and beyond is open and unused. If Jason orders an image, this is where it goes.

### 2. The 6 `public/gym/` files — images, but explicitly NOT Grok's

This is the trap. They are image files in a public directory, six of them, currently
placeholders — which reads like an obvious "generate the real ones" job. It is not.

`apps/web/src/shared/gymPhotos.ts` reserves these slots for **photographs of the
actual building**, and states the standing rules in its own header: *"no stock
photography, no fake-photorealistic imagery, and no people — not even drawn ones."*
An image model producing a convincing gym interior is precisely the
fake-photorealistic imagery that rule forbids, and it would be a picture of a
building that does not exist, presented on the page a parent reads before deciding
whether to trust this gym with their child.

The release mechanism confirms it. A gym slot fills when a person who *can see the
picture* commits the file or uploads it at `/admin/gym-photos` — the module calls
that act "the only review a photograph can honestly get." Generated output has no
such person behind it.

Two further blocks, either of which is sufficient on its own: these are hand-authored
**vector** SVGs in the design system's palette, and Grok's lane is raster JPEG; and
each one carries the words `PLACEHOLDER ILLUSTRATION` baked into the image, against a
lane law of **zero lettering**.

**These six get replaced by a camera, not by a model.**

### 3. App chrome and the orphans — out of scope for different reasons

- `favicon.ico` / `icon.svg` — brand identity at 16px. `icon.svg` is a 771-byte
  hand-authored reduction of the `.seal` roundel in `design-system/ppbf.css`, with a
  comment explaining which parts survive the downscale. It is a design-system
  derivative that must stay locked to the seal; a generated variant would drift from
  it. Vector, and tiny.
- `opengraph-image.png` — 1200×630, and it is **entirely lettering**: the wordmark,
  a two-line slab headline, a strapline, and `501(C)(3) NONPROFIT · FREE FOR ALL
  FAMILIES`. It is typography and brand chrome rendered to a raster, not a
  photograph. Zero lettering is a lane law, so this is the clearest possible
  out-of-scope case. If it ever changes, it changes as a typographic layout.
- The 5 scaffold SVGs — the correct action is deletion, not regeneration. Nothing
  should be drawn to replace them.
- `fig_intake_seed.png` — a two-panel matplotlib chart. It must be **regenerated from
  the data**, never redrawn by an image model. A hand-made picture of a bar chart is
  a fabricated result.

---

## Detail

### `apps/web/public/plates/` — 8 room plates

**All eight verified against the bytes, not the README.** Every plate: valid SOI,
valid EOI (not truncated), 3 colour components all sampled `1x1` = **true 4:4:4**,
baseline (non-progressive), JFIF APP0 only, no EXIF and no ICC profile. All are
comfortably inside the 400 KB per-plate budget — the largest, `plate-02a`, uses 32%
of it.

| File | Pixels | Bytes | Subsampling | CSS selector |
|---|---|---:|---|---|
| `plate-01-office-01.jpg` | 1280×720 | 105,959 | 4:4:4 | `.room--office` |
| `plate-02a-floor-landscape-01.jpg` | 1280×720 | 129,817 | 4:4:4 | `.room--floor` |
| `plate-02b-floor-portrait-01.jpg` | 405×720 | 43,945 | 4:4:4 | `.room--floor` @ `orientation: portrait` |
| `plate-03-clinic-01.jpg` | 1280×720 | 52,209 | 4:4:4 | `.room--clinic` |
| `plate-04-board-01.jpg` | 1280×720 | 33,455 | 4:4:4 | `.room--board` |
| `plate-05-file-01.jpg` | 1280×720 | 78,933 | 4:4:4 | `.room--file` |
| `plate-06-night-01.jpg` | 1280×720 | 46,687 | 4:4:4 | `.room--night` |
| `plate-07-warm-ground-01.jpg` | 1280×720 | 39,150 | 4:4:4 | `.on-canvas` (T7 family surfaces) |

**Referenced from:** CSS `url()` only, all eight declared exactly once, in the PLATES
block of `design-system/ppbf.css` (lines 3474–3491). Consumed as a `--plate` custom
property painted by `.room::after`. **No plate is ever an `<img>`**, which is correct
and load-bearing: a plate that fails to load is simply an unpainted background layer,
and the room still renders from gradients with no network.

**README verification — one discrepancy, cosmetic.** Every dimension in
`apps/web/public/plates/README.md` matches the SOF exactly. Every size matches to the
nearest KiB except one: `plate-01-office-01.jpg` is 103.48 KiB and the README says
104 KB. Rounding, not a substituted file. Everything load-bearing in that README —
geometry, 4:4:4, budget, one-declaration-site — is true.

**What each plate actually depicts** (Grok needs this to make a matching variant):

| Plate | Material |
|---|---|
| 01 office | Horizontal wood plank panelling, warm mid-brown, visible grain and knots, soft vignette. |
| 02a floor | Grey-brown industrial brick, two caged wall lamps at the outer edges throwing light pools into the outer thirds. Dark. |
| 02b floor (portrait) | Red-brown brick, flat and evenly lit, no fixtures. |
| 03 clinic | Painted panelled joinery, muted sage green, low sheen, centre panel almost featureless. |
| 04 board | Dark grey plaster upper wall over a dark timber dado rail and pale wainscot along the bottom third. |
| 05 file | Grey concrete wall with a large empty cork noticeboard and a gooseneck lamp lighting it from upper left. |
| 06 night | Near-black textured plaster with one warm pool of lamplight. |
| 07 warm ground | Cream/bone plaster, very fine texture, almost no incident. The quietest plate in the set. |

**Two composition observations for whoever writes the next order.** Neither is a
gate failure — the test suite passes and no lane law in `GROK-VISUAL-LANE.md` is
mechanically broken — but both are the kind of thing a set-level review is for:

- **02a and 02b are not the same wall.** They are the two orientations of one room
  (`.room--floor`), but 02a is grey-brown brick with industrial caged lamps and 02b
  is flat red-brown brick with no fixtures. Brick colour and lighting both differ.
  Rotating a tablet changes the wall's material, which sits awkwardly against the
  lane's *"a set, not six prompts — six images look like one building on one day."*
  A re-ordered 02b matched to 02a is the single most defensible plate order available.
- **06 night puts its brightest area dead centre.** The composition law asks for a
  quiet centre with interest in the outer thirds. 06 is low in *detail* at centre but
  high in *luminance* there. Under a panel it may read as a glow behind the content
  rather than as a wall. Worth a look on the live URL before anyone treats it as
  settled.

### `apps/web/public/gym/` — 6 placeholder illustrations

**What they are:** commissioned placeholder illustrations, by owner decision
2026-08-06 — hand-authored vector SVG drawn in the design system's palette, building
only, no people, each visibly labelled `PLACEHOLDER ILLUSTRATION` inside the image
and described as an illustration in its alt text. They exist so the wall reads as a
wall while the real photographs are being taken.

All six share `viewBox="0 0 1220 754"` (≈1.618:1), no `width`/`height` attributes, so
they scale to their frame. All are pure vector primitives — `rect`, `line`, `circle`,
`path`, `text`. **No embedded raster, no data URIs** in any of them.

| File | viewBox | Bytes | Slot | Surfaces |
|---|---|---:|---|---|
| `entrance.svg` | 1220×754 | 2,836 | "The front door" | public |
| `floor.svg` | 1220×754 | 3,467 | "The floor" | public, dashboard |
| `ring.svg` | 1220×754 | 2,448 | "The ring" | public, dashboard |
| `bags.svg` | 1220×754 | 3,385 | "The bags" | public, dashboard |
| `wraps-bench.svg` | 1220×754 | 2,677 | "Where you wrap up" | public, dashboard |
| `wall.svg` | 1220×754 | 3,440 | "The wall" | dashboard |

**Referenced from:** the manifest at `apps/web/src/shared/gymPhotos.ts`
(`GYM_PHOTO_SLOTS[].file`), rendered as a bare `<img src="/gym/…">` by
`apps/web/components/PhotoSlot.tsx` (line 70 — a deliberate `<img>`, not a Next
`<Image>`, with an eslint disable and a comment pointing at `ProfilePortrait`'s
reasoning). Reaches the page via `GymWallModule.tsx`, `app/page.tsx`,
`app/public/page.tsx` and `app/admin/customize/page.tsx`. `entrance.svg` carries the
gym's name as drawn lettering, which is fine for an illustration and is exactly what
disqualifies this class of file from the plate lane.

An admin upload at `/admin/gym-photos` overrides the manifest per slot with an
org-scoped private blob, so a real photograph can land without a git client.

### `apps/web/app/` — 3 chrome assets

None of these three is referenced by any code, and that is correct, not a defect:
Next.js 16.3.1 App Router discovers `favicon.ico`, `icon.svg` and `opengraph-image.png`
in `app/` **by filename convention** and emits the `<link rel="icon">` and OG meta
tags itself. `apps/web/app/layout.tsx` declares `metadata` with `title` and
`description` and deliberately no `icons` block. Grep finds nothing; the framework
still ships them.

| File | Dimensions | Bytes | Notes |
|---|---|---:|---|
| `favicon.ico` | 4 entries: 16×16, 32×32, 48×48 (32-bit BMP/DIB) + 256×256 (embedded PNG) | 25,931 | Type 1 icon. The 256 entry is 7,821 of those bytes. |
| `icon.svg` | viewBox 0 0 64 64 | 771 | Hand-authored. Rounded ink-leather tile, double red ring, slab `P`. Colours `#14100D` / `#A81E22` match the design-system tokens. |
| `opengraph-image.png` | 1200×630 | 355,674 | 8-bit truecolour, non-interlaced, no alpha, valid IEND. **Largest image in the repository.** |

`opengraph-image.png` is 355 KB of flat brand typography on a two-tone ground — a
composition with very few distinct colours. That it is a 355 KB truecolour PNG rather
than a palette-indexed one is an encoding-efficiency observation for whoever owns
that asset. It is out of the visual lane either way, and it is not on a hot path
(social scrapers fetch it, users do not).

### `apps/web/seed-data/shadow-research/2026-08-07/fig_intake_seed.png`

**It is a real image, and it is not test fixture data.** 3,346×1,367, 8-bit
truecolour **with alpha**, non-interlaced, valid IEND, 228,649 bytes. It is a
two-panel matplotlib figure: a grouped bar chart titled *"647 claims lose the PROVEN
label"* comparing current citation-count tiers against proposed quality-weighted
tiers, beside a horizontal bar chart titled *"Coverage fails where the evidence is
transferred"* showing per-topic share of boxing-specific evidence against a 20% floor.

It is documentation *about* the seed package — an analysis figure — sitting inside the
package directory. It is **not** part of it:

- `README_RESEARCH_INTAKE_SEED.md` lists it in its "What is in the package" manifest
  only as a companion figure, explicitly not read by the importer.
- `apps/web/scripts/import-shadow-research.mjs` reads five explicitly named CSVs from
  a frozen `FILES` map. It never reads the directory, so it never sees the PNG.
- Nothing anywhere in the repository mentions the filename.

So it loads nothing, is displayed nowhere, and is served nowhere — `seed-data/` is not
`public/`. It is an orphan by every test, though a defensible one: it is the evidence
behind the tier decisions the package encodes, and deleting it would lose that. The
honest options are to reference it from the seed README or to move it under `docs/`.
**Out of scope for Grok regardless** — a chart is regenerated from data, never drawn.

---

## Verification

`npm test` from `apps/web` at `a11ea7c1`, in a clean worktree at that SHA:

```
Test Suites: 539 passed, 539 total
Tests:       6917 passed, 6917 total
Time:        136.435 s
```

Matches the stated baseline of 539 / 6917 exactly. This inventory adds one Markdown
file and changes no code, CSS, test or asset, so the baseline is unchanged by
construction as well as by measurement.

The plate laws in `apps/web/src/design/plateBinaries.test.ts` are inside that run:
SOI, EOI, minimum size, 400 KB budget, 4:4:4 on every colour component, declared
geometry, filename-versus-orientation, and CSS-declaration-resolves-to-a-real-file.
The independent parse written for this inventory agrees with all of them on all eight
plates.
