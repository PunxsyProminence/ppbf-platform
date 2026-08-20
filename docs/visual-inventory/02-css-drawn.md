# 02 — What `design-system/ppbf.css` DRAWS

**Baseline commit:** `a11ea7c166f7659e4c5bb63337d44323069febaa` (`origin/main`)
**Sheet:** `design-system/ppbf.css`, 3,498 lines
**Scope counted:** `apps/web` (excluding `node_modules`, `.next`, build output)
**Test baseline verified on this SHA:** `npm test` from `apps/web` → **539 suites / 6917 tests, all passing**. Nothing in this branch touches code, so it is unchanged.

This is an inventory, not a review. It proposes no CSS changes.

---

## The headline for Grok

`ppbf.css` references **exactly 8 external image files** — the eight room plates
— and **5 font files**. That is the complete list of things it loads. Every
other visual in the sheet is *drawn*: 3,498 lines producing 81 linear
gradients, 73 radial gradients, 22 repeating-linear-gradient textures, 2 conic
gradients, 85 box-shadow stacks, 44 `background-blend-mode` composites, 13
`mix-blend-mode` overlays, 12 `clip-path` silhouettes, 26 text-shadow effects
and 11 keyframe animations — from two ~500-byte SVG `feTurbulence` noise
generators and colour tokens. No sprite sheet, no texture PNG, no icon font.

That is deliberate and load-bearing. The ROOMS section of the sheet states
every room is zero-asset **"so the floor tablet still renders them with no
network."** `apps/web/public/plates/README.md` restates it: a plate is *"an
enhancement over that ground, never a replacement."*

**So the default answer to "should Grok draw this?" is no.** The sheet already
draws it, and an image file would be heavier, fixed-aspect, unable to adapt to
the two grounds (ink leather / warm canvas), and would break the offline
guarantee. Grok's surface here is narrow and specific, and it is already
correctly identified: **wall plates, layer 0 only.**

### Sheet-level counts

| | Count |
|---|---|
| Class selectors defined in the sheet | **334** |
| Applied in `apps/web` markup | **204** |
| Never applied in `apps/web` markup | **130** |
| External image files referenced | **8** (all present, all wired) |
| External image files missing | **0** |
| Font files referenced | **5** (all present) |

Counting method: every `.class` selector was extracted from the sheet with
comments stripped, then matched against string literals reachable from a
`className` / `class` / `*ClassName` binding in `apps/web` — including strings
nested inside template-literal `${…}` interpolations. Ambiguous single words
(`tile`, `seal`, `photo`, `tag`, `mark`, `place`, `bell`, `desk`, `skeleton`,
`motto`, `nameplate`, `tally`, `clipping`, `redacted`, `stain`, `peek`,
`gloves`, `keytag`, `woodframe`, `signboard`) were counted **only** inside a
class binding, because each is also ordinary English that appears constantly in
this repo's prose comments. A naive grep reports 104 hits for `tile` and 218
for `photo`; the real class-application count for both is **zero**. Where a
class appears only as a *selector* in `apps/web/app/globals.css` (a stylesheet
rule, not applied markup) it is recorded as a CSS reference, not a usage.

---

## THE THREE-GROUP SPLIT

### Summary

The catalogue below names **110 distinct visual constructs**. They sort as:

| Group | Count | What it means |
|---|---|---|
| **1 — DRAWN, leave alone** | **104 of 110 constructs** | CSS does this well. An image would be worse. Do not commission. |
| **2 — DRAWN, photography would be better** | **6 constructs → 5 orders** | The CSS ground *stays* — it is the offline floor. A photographic plate goes over it. |
| **3 — NOT DRAWN, genuinely needs art** | **4 absences** | No CSS construct is involved. The sheet names a slot and it is empty, or nothing exists at all. |

The group-2 constructs are `.room--office`, `.room--board`, `.room--file`,
`.room--floor`, `.mat-cork` and `.mat-slate`. Note that none of them *leaves*
group 1: their gradient grounds must keep working when a plate fails to load.
Group 2 is an addition, never a replacement.

Grok's next order comes out of groups 2 and 3, and those two overlap heavily —
**both funnel into the plate mechanism that is already built and already
working.** There is no second delivery route to invent.

---

### GROUP 2 — DRAWN, but a photographic version would be better (5)

Ordered by leverage. Every one of these ships through `--plate` on
`.room::after`, which already exists; nothing needs new wiring except a
filename.

**2.1 — The office wall, more variants.** `.room--office` is applied in **39
files** — by a wide margin the most reused wall in the building. It is
currently one plate, `plate-01-office-01.jpg`, seen on every one of those
pages. The CSS ground beneath it (three stacked layers: a dark seam, a lit top
edge, long grain streaks, `background-size: 100% 74px`) is a genuinely good
plank wall, but 39 pages of one photograph is the single most visible
repetition in the app. *Ask: `plate-01-office-02` and `-03`, same room, same
day, different part of the wall.*

**2.2 — The board room wainscot.** `.room--board` (**8 files**) is the crudest
of the six grounds by a distance: one `linear-gradient(180deg, …)` with a hard
stop at 52% putting plaster above and stained wainscot below, plus a
53px-pitch `repeating-linear-gradient` for panel styles. It reads as two flat
fields meeting on a line. It is also the room where the light must stay
believable, because `.on-plaster` flips header ink to dark against it. This is
the ground that photography improves most per file. *Ask: a replacement for
`plate-04-board-01.jpg` with a real wainscot cap rail and plaster above it.*

**2.3 — Cork, in the file room and as a material.** `.room--file` (**3 files**)
and `.mat-cork` (**zero files**) both build cork from exactly three
fixed-position radial-gradient specks tiled at 17px, 27px and 11px. Real cork
is irregular at every scale; three repeating dots are the most obviously
synthetic texture in the sheet. `.room--file` already has
`plate-05-file-01.jpg` doing this job; `.mat-cork` — the panel-scale material —
has no photographic path at all and is currently unused, so it is worth
knowing but not worth commissioning until something consumes it. *Ask: a file
room variant; do not commission a cork swatch.*

**2.4 — The brick floor at desktop width.** `.room--floor` (**21 files**)
builds masonry from five stacked repeating-linear-gradients — horizontal joints
at 37px, vertical joints at 89px, alternate courses offset by half a brick at
`background-position: 0 37px`, plus per-brick tonal variation on a 356px cycle.
The comment on it is right that mortar must blend `normal` rather than
`multiply`, and the `--mortar` token was already darkened to 1.75:1 so the
joints stop drawing a lit grid. It is convincing at tablet size. At 2560px it
reads as a pattern, because the cycle repeats seven times across the viewport.
It already has both landscape and portrait plates, which is correct. *Ask:
higher-resolution replacements before new variants.*

**2.5 — The chalkboard at full-screen size.** `.mat-slate` is applied in **2
files** (`components/Chalkboard.tsx`, `app/admin/shadow/page.tsx`) but one of
them is a whole screen. It is `--grain-fine` over a radial highlight over a
two-stop vertical gradient, with a 70px inset shadow for vignette. What it
cannot do is the thing that makes a real gym chalkboard read as one: ghosting —
decades of imperfectly erased writing. That is genuinely photographic and
genuinely out of reach in CSS. Lowest leverage of the five, listed because it
is the only *material* (rather than wall) where photography clearly wins.
*Ask: only if the chalkboard screen is a priority.*

---

### GROUP 3 — NOT DRAWN, genuinely needs art (4)

**3.1 — The empty variant slots.** Every plate on `main` sits at `-01`. The
CSS's own PLATES comment says *"Rooms are reused heavily (office 42 pages,
floor 22), so the set is expected to grow,"* and the README calls `-01` *"a
variant slot."* The slot is named, documented, tested, and empty. Measured
reuse today: office **39 files**, floor **21**, board **8**, clinic **7**, file
**3**, night **2**, plus `.on-canvas` at **12**. The three heavily reused rooms
are where a second variant pays.

**3.2 — Resolution.** All eight plates shipped at 1280×720 (405×720 portrait)
against a spec that called for 2560×1440. The README accepts this explicitly —
*"the plate sits behind a gradient wall and carries no detail a viewer reads,
and the gym tablet is the constraint that matters"* — and notes that replacing
one is *"one file swap and no code change."* It remains a real, known,
already-costed gap. Straight swaps, same eight filenames.

**3.3 — The gym photograph slots.** `apps/web/public/gym/` holds six **SVG
placeholders** (`ring.svg`, `bags.svg`, `wraps-bench.svg`, `floor.svg`,
`wall.svg`, `entrance.svg`) standing in for real photographs of the actual gym,
against a manifest in `apps/web/src/shared/gymPhotos.ts` whose comments read
*"a file name under `apps/web/public/gym/`, or null while nobody has taken
one."* These are **loaded, not drawn**, so they sit at the edge of this
report's slice — but they are the clearest "nothing exists" in the codebase.
Note the constraint: these are of *this* gym, so they are a camera job, not
necessarily a generation job.

**3.4 — The PPBF crest.** The sheet's SEAL section calls the roundel *"the most
repeated mark in the whole body of reference art, and the system had no
component for it."* `.seal` and its four variants (`--sm`, `--lg`, `--green`,
`--ink`) are applied in **zero** files. The one place that needed a roundel —
`components/TrainingCard.tsx` — hand-rolled its own 52px inline `<svg>` with a
`textPath` roundel reading `PPBF · LOGGED`, and it is the **only** prod `.tsx`
in `apps/web` containing an inline `<svg>` at all. So the platform has a crest
mark, drawn once, in one component, not using the system's own class.

To be precise about which half is missing: the CSS construct `.seal` is **Group
1** — it is well drawn and should not change. What does not exist anywhere in
this repository is the *crest design* it would render.

**Important qualifier for Grok on 3.4:** the sheet keeps the seal zero-asset on
purpose — `.seal` styles inline SVG markup that ships in the page, so it stays
crisp at any size, takes `currentColor`, prints, and works offline. If a crest
is commissioned, the deliverable is **a design to be redrawn as SVG markup**,
not a JPEG or PNG to be referenced. A raster crest would be a regression.

**Explicitly do NOT commission:** member portraits. `.plate > img` is fed by
real member photography through `components/ProfilePortrait.tsx`, and the
sheet's PLATE section is emphatic that the no-photo state — an engraved brass
plate with the member's initials — *"is the more important of the two states,
not the fallback,"* because under the privacy rules most viewers never see a
child's face. There is no missing asset here. There is a designed absence.

---

### GROUP 1 — DRAWN, leave alone (104 of 110 constructs)

Everything below is drawn from scratch and should stay drawn. The recurring
reasons, stated once so the catalogue does not repeat them:

- **Two grounds.** Law 6 gives the app ink leather and warm canvas, and most
  of these restate themselves per ground (`.on-canvas`, `.on-plaster`,
  `.mat-paper` overrides). A raster cannot do that.
- **Print.** Two `@media print` blocks collapse every ground to white and every
  voice to black ink, while preserving the safety ladder's hue. A background
  image is dropped by most printers and would leave the layout blank.
- **Arbitrary geometry.** These surfaces take `border-radius: inherit`, stretch
  to any panel size, and tile. A photograph is one aspect ratio.
- **Meaning.** Badges, stamps and gauges carry status under Laws 2, 3 and 7.
  They must recolour per ground, survive greyscale, and be readable by a screen
  reader. They are never decoration.
- **Weight.** The two grain generators are SVG data URIs of a few hundred bytes
  each, reused **51 times** across the sheet.

---

## THE CATALOGUE

Usage = distinct `apps/web` markup files applying the class (occurrences in
parentheses). `—` means zero.

### Textures — the substrate everything else is built on

| Token | Depicts | How it is built | Usage |
|---|---|---|---|
| `--grain` | coarse surface tooth | SVG data URI, 180×180, `feTurbulence` fractalNoise `baseFrequency=0.78`, 4 octaves, desaturated by `feColorMatrix` | 51 references inside the sheet |
| `--grain-fine` | fine paper/brass tooth | same, 120×120, `baseFrequency=1.6`, 3 octaves | (included above) |

Both are applied as the **first** `background-image` layer and composited with
`background-blend-mode: overlay`, so they modulate whatever gradient sits
beneath rather than lying on top of it. This one trick is what makes 12
different materials read as materials. **Group 1.**

Secondary textures, all `repeating-linear-gradient`: leather cracks (two
crossing passes at 78° and 146°, multiply-blended), wood grain (94°), plank
seams (180°), brick courses (5 layers), wainscot panels (90°), brass rope
twist (112°), cage wire on the floor lamp, ledger ruling, graph-paper grid,
legal-pad ruling. **Group 1.**

### Materials — `.mat-*` and the grounds

| Class | Depicts | How it is built | Usage |
|---|---|---|---|
| `.mat-leather` | oiled hide, the standard panel face | grain + warm radial at 28%/8% + black radial at 82%/96% + 170° three-stop ramp; blend `overlay, screen, multiply, normal` | **98 files** (336) |
| `.mat-leather--raised` | lifted hide, tiles and cells | grain + top-lit radial + 168° ramp; inset bone highlight, inset black, drop shadow | **49 files** (147) |
| `.mat-leather--worn` | hand-me-down hide, cracked | as raised, plus two crossing multiply-blended crack gradients, darker and less saturated | — (selector-only in `globals.css`) |
| `.mat-stitch` | saddle stitching | `::after` inset 6px, 1.5px dashed bone rule, `border-radius: inherit` | — |
| `.mat-brass` | polished brass, ceremonial only | 158° seven-stop ramp through brass-900→200→500→800→400→900; inset specular + inset black + drop | — |
| `.mat-brass--dark` | dark brass | five-stop 158° ramp | — (selector-only) |
| `.mat-brass--patina` | oxidised workaday brass | same ramp shape in `--patina-*`; Law 1 reserves true brass for the crest | **5 files** (5) |
| `.mat-slate` | chalkboard | fine grain + soft white radial highlight + 180° ramp; 70px inset vignette | **2 files** (4) |
| `.mat-cork` | cork noticeboard | grain + three fixed radial specks tiled 17/27/11px + 180° ramp; 40px inset | — |
| `.mat-paper` | stamped paper on hide | fine grain + 178° cream ramp, overlay-blended; carries **13 ink restatements** so every type voice is legible on it | **41 files** (124) |
| `.mat-wood` | stained oak furniture | grain + 94° grain streaks + 170° ramp; lit top bevel, inset shadow, drop | **9 files** (15) |
| `.mat-wood--dark` | dark-stained board | as above, darker, ink set to `--brass-200` | — (selector-only) |
| `.on-canvas` | the warm second ground | fine grain + soft top radial on `--canvas-warm`; restated at `body.ppbf.on-canvas` to beat specificity | **12 files** (26) |
| `.on-plaster` | light plaster wall above wainscot | ink restatement only, for four voices | **2 files** (2) |
| `.clipping` | newsprint cutting | fine grain + grey-cream ramp, 2-column body at 9px, `rotate: 1deg` | — |
| `.stain` `--sm` `--lg` | rust / dried spill | three offset radial gradients in `--rust-*`, organic `border-radius`, `mix-blend-mode: multiply`, plus an `::after` drip | — |

**Paper stock system** — four composable axes (stock × age × soil × damage):

| Class | Depicts | Usage |
|---|---|---|
| `.pap` | bond, the base stock | **7 files** (12) |
| `.pap--card` | index / card stock, brighter and stiffer | **3 files** (4) |
| `.pap--news` | newsprint, greyer and thinner | — |
| `.pap--onion` | carbon copy, translucent and bluish | — |
| `.pap--kraft` | buff envelope stock | — |
| `.pap--graph` | engineering grid, 13px blue rules both axes | — |
| `.pap--ruled` | legal pad, 20px rules + red margin at 33px | — |

All **Group 1.** These are gradients that must tile to any panel size and
multiply-compose with the age and soil layers below. A photograph of paper
cannot compose.

### Rooms — wall, light, shadow

`.room` supplies `min-height: 100vh`, the wood ground, grain, and
`isolation: isolate`. `.room::before` (z-index 0) paints the **light**: two
fixture pools thrown from 20%/-12% and 80%/-12%, a broad warm wash across the
middle where work sits, and a floor-level darkening from 50%/112%. Content sits
at z-index 1. `.room::after` (z-index **-1**) paints the **plate**.

The z-index -1 is the whole compositing trick and is worth Grok understanding:
per CSS painting order a negative-z-index pseudo-element lands *above* the
element's own background but *below* both the light and the content. So the
photographic plate covers the gradient wall, and **the CSS lamps still fall
across the photograph**. `isolation: isolate` on `.room` is required or the -1
layer escapes upward.

| Room | Wall depicts | How the ground is built | Plate | Usage |
|---|---|---|---|---|
| `.room--office` | horizontal stained plank wall | grain + 91° grain streaks + 180° seam/lit-edge pair at 74px pitch + 178° ramp | `plate-01-office-01.jpg` | **39 files** (63) |
| `.room--floor` | brick and mortar, offset courses | grain + per-brick tonal variation + horizontal joints (37px) + two vertical joint passes offset half a brick (89px) + 168° ramp | `plate-02a` / `-02b` portrait | **21 files** (25) |
| `.room--board` | painted wainscot below, plaster above | grain + one 180° ramp with a hard 52% stop + 53px panel styles | `plate-04-board-01.jpg` | **8 files** (11) |
| `.room--file` | cork wall, wood rail | grain + three radial specks + 178° ramp | `plate-05-file-01.jpg` | **3 files** (5) |
| `.room--clinic` | varnished cabinetry | grain + 87px cabinet stiles + 172° ramp; **own `::before`** with a cool green-shade pool | `plate-03-clinic-01.jpg` | **7 files** (8) |
| `.room--night` | the original ink ground | grain + warm top radial + 180° ramp; **own `::before`**, floor darkening only | `plate-06-night-01.jpg` | **2 files** (9) |
| `.room--lit-center` | one overhead lamp instead of two | replaces `::before` with a single 50%/-12% pool | — | **10 files** (16) |
| `.on-canvas` | the family ground | (see materials) | `plate-07-warm-ground-01.jpg` | **12 files** (26) |

Each room also declares its own light constants (`--sx --sy --sh-len --sh-blur
--sh-op`) so every panel standing in it agrees where the lamp is.

Grounds are **Group 1** (they are the offline floor and must stay). Plates are
**Groups 2 and 3**.

### Light and fixtures

| Class | Depicts | How it is built | Usage |
|---|---|---|---|
| `.lamp` | hanging fixture, shade + pool | `::before` is the shade — an asymmetric `border-radius: 50% 50% 42% 42% / 78% 78% 30% 30%` over a patina ramp; `::after` is a 233×178 radial pool, `mix-blend-mode: screen` | **16 files** (16) |
| `.lamp--green` | banker's shade, the clinic lamp | green ramp + cool pool | **9 files** (10) |
| `.lamp--caged` | wire-caged floor fixture | adds a 9px-pitch multiply-blended wire pass over the shade | — |
| `.light-at--*` (7) | where the light is | set `--sx` / `--sy`, the unit direction a shadow travels | — (all 7) |
| `.light--*` (9) | what kind of light — bulb, caged, pendant, gooseneck, banker, window, skylight, overcast, ambient | set `--sh-len` / `--sh-blur` / `--sh-op` | — (all 9) |
| `.lift-0` … `.lift-4` | how far off the surface an object sits | box-shadow offsets computed from the light tokens via `calc()` | `.lift-1` **4 files** (5); other four — |
| `.lit-edge` | a lit top edge on the side light comes from | inset highlight + directional drop | — |

**Group 1, unambiguously.** This is a parametric lighting model, not a picture.
Baking light into a plate would double-light every room, because `.room::before`
paints over the plate by design. Note the scale of the gap: **21 of the 22
light-model classes are defined and never applied.**

### Hardware and furniture

| Class | Depicts | How it is built | Usage |
|---|---|---|---|
| `.frame` / `.frame-in` | riveted brass frame around a panel | seven-stop 158° brass ramp, 14px padding; child gets an inset well | **16 files** each (17) |
| `.frame--patina` | the same in oxidised brass | patina ramp | — |
| `.rivet` + `--tl/tr/bl/br` | cast brass rivet | 11px circle, off-centre `radial-gradient(circle at 34% 28%)` through 4 brass stops, inset dark bottom + drop | **16 files** (68) |
| `.rivet--patina` | oxidised rivet | patina stops | — |
| `.rope` / `--v` | twisted brass rope trim | 112° `repeating-linear-gradient` in 4 brass bands at 5px pitch; inset highlight and shadow sell the twist | **1 file** (8) — `app/page.tsx` |
| `.rope--frayed` | worn rope | patina bands + an irregular `clip-path` | — |
| `.woodframe` | wooden frame with a bevel | grain + 94° grain + 168° ramp; 14px inset top bevel, 34px drop | — |
| `.signboard` | routed hanging sign | grain + 170° ramp, stencil face, dual text-shadow for routing | — |
| `.nameplate` (+3) | engraved brass plate screwed to a board | fine grain + 174° ramp deliberately capped inside brass-400..800 (no specular white — *"a full highlight sweep reads as moulded plastic"*); `::before`/`::after` are the two screws | — (all 4) |
| `.keytag` / `--expired` | hanging brass luggage tag | fine grain + 172° ramp, `rotate: -2deg`, `::before` grommet | — |
| `.plate` (+4) | portrait plate — engraved initials before a photo exists | nameplate material at 89px square; `.plate-initials` in the display voice with an engraved (light-above) text-shadow; two screws; `.plate--cornered` adds a 3px dyed bevel | **2 files** (3) |
| `.tag` | leather luggage-tag navigation | grain + 168° ramp; `::before` is a brass grommet ring, `::after` a dashed stitch inset | — |
| `.gauge` (8 parts) | brass-bezelled analogue dial, 144×89 (consecutive Fibonacci = a golden rectangle) | bezel = brass ramp; face = inner radial well; `.gauge-ticks` = `repeating-conic-gradient` masked to an annulus; `.gauge-arc` = `conic-gradient` danger band, same mask; `.gauge-needle` rotates on `--deg`; `.gauge-hub` is a brass boss | **3 files** each (3); `.gauge-arc` — |
| `.ledger` (+`-val`, `-id`, `.rule-v`) | ruled paper record, red-ink action line | table borders in ink at 0.7/0.26 alpha, mono voice, stencil caption | **15 files** (20) |
| `.note-torn` | ragged lower edge | 22-point `clip-path` polygon | **6 files** (8) |
| `.pin` / `.pin--brass` | pushpin / brass tack | 14px circle, off-centre radial through red or brass stops | **7** / **5 files** |
| `.tile` (+3) | navigation tile, dashed inner border, hover lift | grain + top-lit radial + 168° ramp, `::after` dashed inset | — |
| `.stat` (+3) | KPI cell — a number that leads nowhere | same material as `.tile`, deliberately without `cursor:pointer` or the hover lift | **6 files** (14) |
| `.plaque` | small engraved label | translucent black on a brass hairline, mono voice | **15 files** (25) |
| `.photo` | sepia print in a white border | 178° cream ramp, 21px bottom border for the caption, `rotate: -1deg`; `.photo-plate` is the no-image fallback in grain + hide ramp; `filter: sepia(.55)` on the contents | — |
| `.seal` (+4) | the PPBF roundel, rubber-stamped | 89px circle, double rule via border + inset ring, `rotate: -7deg`, curved text via inline SVG `<textPath>`, worn-ink `::after` | — |
| `.skeleton` (+2) | a blank ruled form waiting to be filled | fine grain + 21px ruling; `::after` is one slow 100° light sweep, not a shimmer loop | — |
| `.picktray` / `.pickrow--picked` | bulk-selection tray; a card pulled half out of a drawer | brass-edged sticky bar; selected row takes a 3px inset brass edge, never a colour fill (Law 2) | **1 file** each |
| `.corner-rope` | a member's own corner tape | 108° repeating gradient through `--corner-deep/-edge/-mid` | **2 files** (2) |
| `.corner-wash` | 6% dye on a member's own panel | `color-mix` at exactly 6% — measured, because at 12% the canvas muted voice drops below 4.5:1 | — |

All **Group 1.** The brass hardware in particular is geometric, scales to any
size, prints as a rule rather than a fill (the print block sets
`border-color: #000` on `.frame` and hides `.rivet` and `.rope` outright), and
would be strictly worse as bitmaps.

### Marks

| Class | Depicts | How it is built | Usage |
|---|---|---|---|
| `.stamp` | Law 7 — governance speaks in ink | 3px `currentColor` border, `rotate: -6deg`, stencil caps; `::after` is a **screen-blended** grain overlay, not a mask, because masking cost ~50% of the ink's contrast and Law 3 forbids distress buying legibility | **30 files** (50) |
| `.stamp--flat` | the same, unrotated | `rotate: 0deg` | **24 files** (40) |
| `.stamp--brass` | brass ink | colour only | **17 files** (33) |
| `.stamp--sm` / `--lg` / `--green` | metadata / heading / approval scale | border-width and type-size steps | **3 files** each |
| `.stamp--kiosk` | gym-floor scale (Law 5) | `--t-md` type, `--tap` min-height, flex for glyph + label | **2 files** (7) |
| `.stamp--press` | long-press reward — presses in harder | `scale(.96)` + saturate/contrast on `:active` | — |
| — | stamp on 7 dark materials | 21 selectors restate stamp ink to the `-ink` rungs, because *"a dark pigment on a dark hide is not a stamp, it is a smudge"* | (mechanism) |
| `.badge` + 5 rungs | the safety ladder — cleared / monitor / restricted / locked, plus the deliberately unsaturated `--filed` for administrative states | `color-mix` fill and border off one `--badge` token, pill radius, inset highlight; `.on-canvas` restates all three channels | `.badge` **73 files** (258); cleared **50**, monitor **40**, locked **39**, restricted **38**, filed **25** |
| `.redacted` | Layer 17 grant privacy bar | near-black fill + grain overlay, `color: transparent` | — |
| `.mark--blood` | old blood oxidised to brown | two radials in `--rust-*`, organic `border-radius`, multiply, plus an `::after` spatter fleck | — |
| `.mark--sweat` | a salt ring | `mix-blend-mode: color-burn` with a harder tide line — *"it lifts colour out of the paper rather than adding any"* | — |
| `.mark--coffee` | cup ring, darker at the rim | single annular radial, multiply | — |
| `.mark--oil` | chain oil, dark and translucent | one radial, organic radius | — |
| `.mark--sm` / `--lg` | scale | `scale: .62` / `1.7` | — |
| `.tally` | four strokes and a slash | hand voice, rust ink | — |
| `.tcard-stamp` (+2) | one impression per logged session | 34px square, deterministic per-`nth-child` rotation so a card never reshuffles between reloads; **effort is ink density, never hue** — alpha ramps `.66→.88` because a `.52` floor measured 4.35:1 and failed AA | **1 file** |

All **Group 1**, and the badge and stamp families emphatically so: they carry
safety meaning under Laws 2, 3 and 7, must survive greyscale printing and a
photocopier, and restate themselves across seven dark materials and two
grounds. They are the last thing in the sheet that should ever become an image.

### Wear and damage

| Class | Depicts | How it is built | Usage |
|---|---|---|---|
| `.age-1` / `-2` / `-3` | a sheet 5 / 40 / 78 years old | `::before`, `mix-blend-mode: multiply`: edge darkening radial + a yellowing ramp; **foxing blooms only from `.age-2`**, because *"a form filled in last week does not have mould on it"* | `.age-1` **3 files** (4); `-2`, `-3`, `-0` — |
| `.aged` | `.age-2` under its original name | as above | **1 file** (1) |
| `.aged--deckle` | untrimmed edge | 25-point `clip-path` | — |
| `.soil-1` / `-2` / `-3` | thumb grime where the sheet was held | `::after` multiply, three radials at the **edges** not spread evenly | — |
| `.tear--bottom` / `--top` / `--right` / `--corner` / `--half` / `--deckle` | six torn silhouettes | `clip-path` polygons, 8–25 points | — |
| `.fold--half` / `--tri` / `--quarto` / `--pocket` | fold memory | paired dark-valley / light-ridge linear gradients at the fold percentages; **the ridge catches on the side the room's light comes from** | — |
| `.dogear` | turned-down corner casting onto the sheet | 225° half-gradient + a shadow computed from `--sx`/`--sy` | — |
| `.crease` | pocket creases | two near-threshold gradients at 49.6% and 33.6%, deliberately faint — *"a crease strong enough to notice while reading a row will be mistaken for a table rule"* | — |

**Group 1.** These are overlays that compose over *any* stock at *any* size —
ageing a newsprint clipping and ageing an index card give different and correct
results from the same `.age-2`. An image overlay would be one aspect ratio and
would not multiply correctly against seven different stocks.

### Placement and discoverables

| Class | Depicts | How it is built | Usage |
|---|---|---|---|
| `.desk` (+`--stack`, `--pile`, `--calm`) | objects on a real surface: slightly turned *and* slightly overlapping | seven `nth-child(7n+k)` rotations from -1.6° to +1.3° — **deterministic, never random**, so screenshot diffs and reloads are stable | — |
| `.place` / `.overrun--*` | explicit placement; an object hanging off the edge of what it sits on | negative offsets keyed to the Fibonacci space scale | — |
| `.peek` (+2) | lift a sheet's corner to read what is filed underneath | animated `clip-path` on `:hover` **and** `:focus-within`, so it is not mouse-only | — |
| `.gloves` | hanging gloves that swing when disturbed | `@keyframes ppbf-swing`, 5 stops, on `--e-swing` (the one easing allowed to overshoot) | — |
| `.bell` | the ring bell — press it and it rings visibly | brass boss + `@keyframes ppbf-ring` scale bounce + `ppbf-ringout` expanding ring | — |
| `.speedbag` | a bag that takes a hit | 3× translate cycle | — |
| `.tcard-seal-slot--pressed` | the milestone ceremony | seal arrives from above large, unlanded and blurred, lands and holds — *"no bounce, no spin, no confetti: this is a boxing gym"*; deliberately **no** `animation-fill-mode: forwards`, so reduced-motion leaves the seal correctly placed rather than frozen mid-press | **3 files** (6) |

**Group 1.** Motion and placement, not art.

### Type as visual

| Class | Depicts | How it is built | Usage |
|---|---|---|---|
| `.t-command` | lit stencil on leather | display slab, uppercase, hard black drop + a warm 18px glow; restated for `.mat-paper`, `.on-canvas` and `.on-plaster` | **110 files** (378) |
| `.t-command--brass` | the same in brass | brass-300 + brass glow | **2 files** (4) |
| `.t-painted` | hand-brushed plywood signage | display slab, `rotate: -0.6deg`, rust-tinted offset shadow standing in for a roughened edge *without masking the glyphs* | **2 files** (2) |
| `.t-press` | letterpress — ink bitten into paper | three-layer text-shadow whose direction is computed from `--sx`/`--sy`, so the bite falls correctly in every room | — |
| `.t-press--deep` | dimensional wood type, masthead only | 5-step extrude | — |
| `.t-eroded` / `--heavy` | a broken plate impression | screen-blended grain `::after` (same choice as `.stamp`, same reason) | — |
| `.t-gothic` | blackletter, the clinic masthead only | `--font-gothic`; *"never body copy; it fails Law 3 at small sizes"* | **9 files** (10) |
| `.t-typed` | typed, not printed | `--font-type` (Special Elite) | **7 files** (20) |
| `.t-hand` | handwriting | `--font-hand` (Caveat) | **1 file** (1) |
| `.motto` | the gym motto | clamped display type + glow | — |
| `.wallwords` (+3) | painted lettering on plaster | **`mix-blend-mode: overlay` at 88% opacity**, so the wall's grain and the lamp's falloff come *through* the pigment; flips to `multiply` on canvas because overlay paint goes invisible on cream; hairline rules top and bottom instead of a box; explicitly **no motion** | **1 file** (1) |
| `.chalk` / `.chalk-dim` | chalk on slate | 1.5px glow text-shadow | **1 file** (2/4) |

**Group 1, without qualification.** Every one of these must remain live text —
screen-readable, translatable, printable, reflowable, and searchable. Rendering
any of them as an image would fail Law 3 outright. `.wallwords` in particular
looks like the most "commissionable" thing in the sheet and is the one where an
image would be most obviously wrong: the whole effect is the *blend* with
whatever wall is behind it, including a plate.

---

## Appendix — the 130 classes never applied in `apps/web`

Worth knowing because much of this system was drawn well ahead of consumption,
and several families that *are* now in use only arrived very recently. First
appearance in `apps/web`, from `git log -S` on `origin/main`:

| Class | First used in app code |
|---|---|
| `.lamp`, `.gauge`, `.wallwords`, `.corner-rope`, `.badge--filed`, `.pap` | 2026-08-17 |
| `.mat-wood`, `.t-gothic`, `.stamp--kiosk` | 2026-08-19 |

Against a baseline SHA of 2026-08-20, those are three days and one day old.
Wholly unused families:

- **Light model** — 21 of 22 classes (`.light-at--*` ×7, `.light--*` ×9,
  `.lift-0/2/3/4`, `.lit-edge`). Only `.lift-1` is applied.
- **Paper damage** — all 6 `.tear--*`, all 4 `.fold--*`, `.dogear`, `.crease`,
  `.aged--deckle`, `.soil-1/2/3`, `.age-0/2/3`.
- **Named marks** — all 6 (`.mark--blood/sweat/coffee/oil/sm/lg`).
- **Placement** — all of `.desk*`, `.place`, `.overrun*`, `.peek*`.
- **Discoverables** — `.gloves`, `.bell`, `.speedbag`, `.tally`,
  `.stamp--press`.
- **Hardware** — `.nameplate` ×4, `.keytag` ×2, `.woodframe`, `.signboard`,
  `.tag`, `.tile` ×4, `.photo` ×2, `.seal` ×5, `.frame--patina`,
  `.rivet--patina`, `.rope--v`, `.rope--frayed`, `.gauge-arc`, `.skeleton` ×3.
- **Materials** — `.mat-brass`, `.mat-cork`, `.mat-stitch`, `.clipping` ×3,
  `.stain` ×3, five of seven `.pap--*` stocks. Plus `.mat-leather--worn`,
  `.mat-brass--dark` and `.mat-wood--dark`, which appear **only** as selectors
  in a link-colour rule in `apps/web/app/globals.css` — a stylesheet reference,
  never applied markup.
- **Type** — `.t-press`, `.t-press--deep`, `.t-eroded`, `.t-eroded--heavy`,
  `.motto`, `.t-data--xl`.

**None of this changes the three-group judgement.** An unused CSS construct is
not a reason to commission art for it — it is a reason not to. The one place
zero usage *is* interesting to Grok is `.seal` (item 3.4), because that mark
exists in the reference art, is called the most repeated mark in it, and has no
system implementation in use anywhere.

---

## What Grok should take away

1. This design system draws essentially everything. Do not offer to produce
   leather, brass, paper, wood, cork, slate, rivets, rope, stamps, badges,
   gauges, lamps, tears, folds, stains or lettering. All of it exists, all of
   it is better as CSS, and several of them carry safety meaning that an image
   cannot carry.
2. The one genuine surface is the **wall plate** — layer 0, behind a gradient
   wall that must keep working when the file does not load, and beneath CSS
   lamps that paint over it.
3. The mechanism is already built, already tested, and already holds eight
   files. Every order in groups 2 and 3 is a filename and a drop, not a new
   integration.
