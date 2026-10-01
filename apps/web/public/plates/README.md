# Background plates

Layer 0 only: the photographed wall a room stands in. Real UI composites on
top in code; no plate carries lettering or substitutes for a stamp, ticket, or
passbook content. One exception: the IRON CITY lettering on the ring canvas stays
when the ring is in frame (owner, 2026-09-28, "no i like that you can leave it";
OD-2026-09-28-013; `docs/REAL-GYM-REFERENCE-LOCK.md` Mode A
item 4). A plate is a `background-image` layer on `.room::after` /
`.on-canvas::after` — never an `<img>`. Missing files are safe by design: with
this directory empty, the gradient wall in the design-system sheets
(`design-system/legacy/ppbf-leather-brass.css`, loaded through
`design-system/ppbf.css`) renders every room with no network.

## Installed set — declared, and therefore live

Every row below is a plate the sheet actually points at. `plateBinaries.test.ts`
requires each of these to exist on disk; it does **not** require the reverse, so
the second table is legal and simply unpainted.

A room with more than one plate states a SPLIT, and which of its walls a given
door shows is a hash of that door's route -- same door, same wall, every load.
The split is chosen from the DOOR COUNT, not from how many plates exist: a rule
on a slot none of that room's doors reach is dead CSS. Office has 52 doors and
fills an of6; clinic has 10 and fills an of4; night has 3 and fills an of3.

| File | Applied to | Dimensions | Bytes |
|---|---|---|---|
| `plate-01-office-01.jpg` | `.room--office`, slot 1 of 6 | 1280×720 | 148,739 |
| `plate-01-office-02.jpg` | `.room--office`, `2of6` | 1280×720 | 226,436 |
| `plate-01-office-03.jpg` | `.room--office`, `3of6` | 1280×720 | 317,154 |
| `plate-01-office-04.jpg` | `.room--office`, `4of6` -- chalkboard wall | 1280×720 | 207,549 |
| `plate-14-frontdesk-landscape-01.jpg` | `.room--office`, `5of6` | 1280×720 | 203,244 |
| `plate-08-bell-gym-landscape-01.jpg` | `.ge-bell.on-canvas::after` (The Bell, /login) AND `.room--office`, `6of6` | 1280×720 | 189,771 |
| `plate-03-clinic-01.jpg` | `.room--clinic`, slot 1 of 4 | 1280×720 | 52,209 |
| `plate-03-clinic-02.jpg` | `.room--clinic`, `2of4` | 1280×720 | 202,304 |
| `plate-03-clinic-03.jpg` | `.room--clinic`, `3of4` | 1280×720 | 202,289 |
| `plate-15-filmroom-landscape-01.jpg` | `.room--clinic`, `4of4` | 1280×720 | 157,678 |
| `plate-06-night-01.jpg` | `.room--night`, slot 1 of 3 | 1280×720 | 46,687 |
| `plate-06-night-02.jpg` | `.room--night`, `2of3` | 1280×720 | 86,167 |
| `plate-06-night-03.jpg` | `.room--night`, `3of3` | 1280×720 | 268,746 |
| `plate-04-board-01.jpg` | `.room--board` -- one plate, see the contrast note below | 1280×720 | 72,943 |
| `plate-05-file-01.jpg` | `.room--file` -- one plate, see the contrast note below | 1280×720 | 78,933 |
| `plate-07-warm-ground-01.jpg` | `.on-canvas` (family surfaces only -- T7) | 1280×720 | 39,150 |
| `plate-08-bell-gym-portrait-01.jpg` | `.ge-bell.on-canvas::after`, `@media (orientation: portrait)` | 810×1440 | 99,891 |

**Board and file deliberately stay on one plate.** Both set
`color: var(--hide-900)` -- dark ink on a light wall -- so a dark plate behind
either is the one failure mode this directory can ship invisibly. No test
measures text against a room ground today. Until one exists, those two rooms
take light plates or none.

## The generated set — plates 09 and up

`plate-09` through `plate-14` were made with `scripts/make-plate.mjs` rather
than supplied by Grok. Owner instruction, 2026-09-26: "work with the connectors
to make one", then "let's shift to making and filling the plate library".

**`plate-15-filmroom-landscape-01.jpg` is the exception and came from Grok**,
in the batch generated 2026-10-01. The sentence above read "plate-09 onward"
until that plate landed; it is scoped to 09-14 now rather than left to go
quietly false.

They run on Azure Foundry — FLUX.1-Kontext-pro, deployed as `flux-kontext-plates`
on the `shadow-ai` account (ppbf-shadow-rg, eastus), GlobalStandard consumption.
Every call is **reference-guided**: an image goes in with the prompt, so a new
plate is another corner of the same building rather than a stock gym assembled
from a sentence.

**Plates 09 and 12-13 were referenced off earlier plates; plate-10, plate-11 and
plate-14 were referenced off the owner's own photographs**, and the difference is visible.
Everything generated before those photographs arrived had the building wrong in
ways no amount of prompting would have caught: dark block walls instead of honey
plank, ceiling chains instead of the timber-and-pipe frames somebody built, one
floor colour instead of the painted red / blue / grey / carpet zones. The script's
DNA block was rewritten from the photographs on 2026-09-26 and now carries that.

Of this generated set, `plate-14-frontdesk-landscape-01.jpg` is now declared — it
is `.room--office` slot `5of6` — and so is `plate-15-filmroom-landscape-01.jpg`,
as `.room--clinic` `4of4`. **The rest are still undeclared**, which is why they
sit in the "Landed but not declared" table below rather than the first one.
Binding one is a single `--plate` declaration in the scope that wants it.

**Known imperfection, recorded rather than hidden:** the no-lettering rule is
stated three ways in the prompt and still leaks. `plate-09` has faint illegible
marks on a clipboard; `plate-10` has them inside the canvas roundel. It leaks
exactly where a real gym carries branding, which is where the model expects it.
The ring canvas is now the one place lettering is allowed (IRON CITY; see the
top of this file). Whether the `plate-10` roundel marks read as that lettering
has not been judged; the `plate-09` clipboard marks are outside the exception.

## The gym floor no longer takes a plate

`current/ppbf-golden-era.css` converts `.room--floor` to a material ground —
colour, two light pools, falloff and `--grain-fine` — and sets `--plate: none`.
The painter is untouched: it simply has nothing to paint on that room. Owner
direction, 2026-09-22, was that the app is not tied to real gym pictures, and
the two plates below were the floor's. They stay committed and still pass the
byte gate; nothing paints them.

Board, File, Office, Clinic and Night keep their walls, the family ground
(`.on-canvas`) keeps plate 07, and The Bell keeps plate 08. Board and File in
particular are LIGHT rooms that switch the page to dark ink, so they cannot
take the floor's dark ground without being re-inked in the same change.

| File | Was applied to | Dimensions | Bytes |
|---|---|---|---|
| `plate-02a-floor-landscape-01.jpg` | `.room--floor` | 1280×720 | 129,817 |
| `plate-02b-floor-portrait-01.jpg` | `.room--floor`, `@media (orientation: portrait)` | 405×720 | 43,945 |

## Landed but not declared — inert until an owner picks one

These passed the byte gate and sit on disk. No CSS points at any of them, so no
route paints them and nothing 404s. Wiring one is a variant/room decision, and
it is one declaration in the PLATES block (`design-system/legacy/ppbf-leather-brass.css:3560-3680`,
loaded through `design-system/ppbf.css`) — a portrait variant goes inside the
orientation block, per "Adding a variant" below.

| File | Dimensions | Bytes | What it would replace or add |
|---|---|---|---|
| `plate-01-office-portrait-01.jpg` | 810×1440 | 186,248 | a portrait crop the office room does not have today |
| `plate-02b-floor-portrait-02.jpg` | 810×1440 | 189,337 | a second portrait floor plate |
| `plate-02b-floor-portrait-ring-01.jpg` | 810×1440 | 82,185 | a ring-side portrait floor alternative |
| `plate-03-clinic-portrait-01.jpg` | 810×1440 | 119,124 | a portrait crop the clinic does not have today |
| `plate-09-drillcase-landscape-01.jpg` | 1280×720 | 200,989 | the Drill Cabinet room: gear shelves, gloves on hooks, a card-index cabinet |
| `plate-09-drillcase-portrait-01.jpg` | 810×1440 | 198,467 | the same cabinet upright. It was committed with its landscape pair and listed in neither table until 2026-10-01 |
| `plate-10-floor-landscape-01.jpg` | 1280×720 | 181,156 | the gym floor: the ring on the red floor, bags on the timber frame, plank walls |
| `plate-11-floor-portrait-01.jpg` | 810×1440 | 195,227 | the gym floor upright, for the tablet that stands on the counter |
| `plate-12-locker-landscape-01.jpg` | 1280×720 | 200,442 | the athletes corner: grey lockers with a red bank, benches |
| `plate-13-scripts-landscape-01.jpg` | 1280×720 | 201,153 | the coaches corner: desk, timing clock, empty boards |
| `plate-04-board-portrait-01.jpg` | 810×1440 | 104,274 | a portrait crop the board room does not have today |
| `plate-05-file-portrait-01.jpg` | 810×1440 | 222,851 | a portrait crop the file room does not have today |
| `plate-06-night-portrait-01.jpg` | 810×1440 | 80,048 | a portrait crop the night room does not have today |

## Requirements — enforced by `apps/web/src/design/plateBinaries.test.ts`

The plate laws and the delivery rule are stated once, in `AGENT_KERNEL.md`
"Binary assets (plates)"; the numbers the gate reads are in
`design-system/plate-contract.json`. Two reasons the list does not carry: the
400 KB budget is per plate, because each route fetches only its own plate and it
caches; and 4:4:4 is required because dark leather and ink wells band under
4:2:0.

## What counts as a delivery

One thing, and it is worth stating flatly because several rounds have now been
spent on things that resemble it: **a plate is delivered when its bytes are in
a commit on a branch.** `git show <sha>:apps/web/public/plates/<name>.jpg | wc
-c` prints a photograph's worth of bytes, or nothing was delivered.

What is not a delivery is listed in `AGENT_KERNEL.md` "Binary assets (plates)".
The distinction is not pedantry and it is not a filing preference. Each
non-delivery arrives looking like progress, closes a round, and leaves this directory
exactly as it was. The reason the byte gate above reads as fussy is that every
line of it was written after one of them got past a weaker check.

## Who places a plate

Anyone may produce a plate; the plate is judged, not its author
(OD-2026-09-26-001). Claude places approved images in this repository
(OD-2026-09-28-001). "Approved" means both: it passes the byte gate above, and a
human has opened the image and checked it against
`docs/REAL-GYM-REFERENCE-LOCK.md` — the gate cannot tell whether the room is
this gym.

A delivered image is committed as received — never reconstructed, never
quietly improved. The reasons are in `AGENT_KERNEL.md` "Binary assets (plates)",
and what Claude can fetch from a drive is in its capability table.

### The one exception: a declared format conversion

**Owner decision, 2026-10-01 (OD-2026-10-01-004).** The rule above and the byte
contract could not both hold for the 2026-10-01 Grok batch: it arrived `4:2:0`
and `plate-contract.json` requires `4:4:4`, so committed as received it fails the
gate, and the files that passed the gate had been re-encoded locally without that
being declared anywhere. Jason chose to keep `4:4:4` and make the step declared,
rather than drop Grok as a source.

**This applies to the 2026-10-01 batch and to nothing before it**, which is
narrower than an earlier draft of this section claimed. Measured on the committed
bytes: every plate predating that batch is baseline (`SOF0`) and already `4:4:4`;
all seven of the batch are progressive (`SOF2`) with metadata stripped, the
fingerprint of the local step. The sets separate cleanly. The earlier plates came
in under the arrangement in `docs/GROK-VISUAL-LANE.md`, where Grok re-encodes to
`4:4:4` in its own pipeline before shipping.

Three conditions come with it. A conversion that skips any of them is a defect,
not a delivery:

1. **Format only, never content.** Downscale to a contract geometry at the SAME
   aspect ratio, so nothing is cropped out; chroma; encoding; metadata. No
   reframing, no retouching, no colour grading, no regeneration. If the source
   aspect ratio does not match a contract geometry, the plate goes back to the
   generator — it is not cropped to fit.
2. **The parameters are recorded**, in the table below.
3. **The original is kept**, so the two can be compared. It lives beside the
   converted file in the owner's reference folder, OUTSIDE this repository: a
   `4:2:0` original cannot pass the byte gate and has no business in `public/`.

### Conversion record

| Batch | Conversion applied | Original kept |
|---|---|---|
| Grok, 2026-10-01 — `plate-01-office-02/03/04`, `plate-03-clinic-02/03`, `plate-06-night-03`, `plate-15-filmroom-landscape-01` | downscale `1792x1008` to `1280x720` (both exactly 16:9, no crop); chroma `4:2:0` to `4:4:4`; baseline `SOF0` to progressive `SOF2`; JFIF/EXIF/XMP/comment segments stripped, leaving `DQT` and `SOF`; sharp, mozjpeg, quality 92 | **NO — not retained.** These predate the rule and the originals were not kept. The conversion is stated from the JPEG markers of the committed files, and cannot be shown by comparison for this batch |
| Grok, 2026-10-02 onward | as recorded per batch | YES, required |

The first row is the honest cost of having run the step silently: the record
exists, the proof does not. Condition 3 is there so no later row reads like it.

### Images from Grok or Canva, when Jason asks

Grok and Canva make images when Jason asks; neither opens pull requests. Claude
places the approved image here (OD-2026-09-28-001).

## Why the byte gate reads the way it does — the delivery record

Recorded factually, because each requirement above is the fossil of a specific
failure and none of them makes sense without the thing it caught.

| What arrived | Under what name | What caught it |
|---|---|---|
| Three chat-channel relays of a base64 sidecar | correct plate filenames | sizes of **11, 24 and 41 bytes**. A stub carries a filename perfectly; only the size floor sees it. |
| One relay that looked plausible | correct plate filename | **2.3 KB**, a valid JPEG start-of-image marker, **no end-of-image trailer**, and the wrong dimensions. Every check short of reading the last two bytes said it was fine. |
| PR #643, `grok/plates-full-ship`, 2026-08-25 | — | **no binaries at all.** One Markdown manifest naming twelve JPEGs held in OneDrive, plus `_smoke_binary_test.jpg`: ten bytes reading `REPLACE_ME`. |

PR #643 is the one worth dwelling on, because it is not sloppy in the way the
earlier rounds were. Its manifest is accurate, its filenames are right, its
covering note is clear, and its `FUNCTIONAL_CHANGES: NONE` is true. It simply
contains no plates, and its “land command” asks Claude to download a package
this sandbox cannot reach. Both locations it names are dead ends:
`02_READY_FOR_CLAUDE/REPO-PLATES-SHIP/` is an empty folder (0 bytes), and the
only real package beside it, `REPO-PLATES-SHIP.zip` (1,569,483 bytes), is a zip
— unreadable from here whatever the policy says. A person following those
instructions by hand finds the empty folder too.

Its `_smoke_binary_test.jpg` also demonstrates why the gate globs *every*
`*.jpg` in this directory rather than a curated list: a ten-byte file named
like a plate is refused at the start-of-image check, which is exactly what
should happen to it.

## Adding a variant

The `-01` suffix is the variant slot. Selection is deterministic from the
route, never random (built in #541): `apps/web/components/plateVariant.ts`
hashes the pathname, and `apps/web/components/PlateVariantGround.tsx` (one
`display: contents` marker in the root layout) writes the slot tokens as
`data-plate-variant="2of2 1of3 …"`. A screen that changed appearance between
loads would break screenshot comparison, print reproducibility, and a coach's
sense of being on the page they were on a moment ago, so
`plateVariant.test.ts` fails if the selector reads a clock or randomness
(`Math.random`, `Date`, `performance.now`, `crypto`) or keeps a module-level
counter.

The PLATES section (`design-system/legacy/ppbf-leather-brass.css:3560-3680`)
states how many plates a room has. To add a second office plate, commit
`plate-01-office-02.jpg` here and add one rule to that section's route-derived
variants block:

```css
:where([data-plate-variant~="2of2"]) .room--office {
  --plate: url("/plates/plate-01-office-02.jpg");
}
```

No TypeScript is edited. `apps/web/components/plateVariant.test.ts` fails a
variant rule that drops `:where()` (it must stay at specificity (0,1,0) so the
portrait override still wins) or that lands after the orientation block. A
portrait variant goes *inside* the orientation block, after its generic rule.

**What #541 does not provide.** It gives deterministic route → *slot*
selection, not route → *named plate*. The attribute carries slot tokens only
and no route identity, so a rule can say "whichever office doors land in slot
2-of-2 take `plate-01-office-02.jpg`" and cannot say "`/coach/session-scripts`
takes the chalkboard wall." Which plate a route receives is decided by the
hash, not by intent. A brief asking for a **named** wall on a **named** route
needs either a new mechanism or a room reassignment; establish which before the
plate is made.

## Authoritative locations

- Room plate URLs and variants: **the PLATES section of
  `design-system/legacy/ppbf-leather-brass.css`** (`:3560-3680`), loaded
  through `design-system/ppbf.css`. Golden Era overrides a room's plate in
  `design-system/current/ppbf-golden-era.css` (the floor's `--plate: none`;
  The Bell's own plate on `.ge-bell.on-canvas::after`).
- Byte gate: `apps/web/src/design/plateBinaries.test.ts` (do not weaken)
- Variant-rule gate: `apps/web/components/plateVariant.test.ts`
- T7 (family surfaces take the warm plate or none):
  `apps/web/components/familyPlateGround.test.ts`
- What a plate must show: `docs/REAL-GYM-REFERENCE-LOCK.md`
