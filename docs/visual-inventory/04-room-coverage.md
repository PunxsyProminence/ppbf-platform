# 04 — Room coverage: where a second wall would actually help

**Counted from `origin/main` at `a11ea7c166f7659e4c5bb63337d44323069febaa`.**
Read-only inventory. Nothing in this document is a wiring instruction; it is a
statement of what is on disk and a ranked order of work for the image lane.

Baseline verified before writing, not assumed: `npx jest --runInBand
--testPathIgnorePatterns=\.pg\.test\.ts$` from `apps/web` — **539 suites /
6917 tests, all passing.** This branch adds one Markdown file and touches no
code, CSS or test.

Every number below was counted from source: `apps/web/components/buildingMap.ts`
for declared doors, the resolver in
`apps/web/components/buildingMapRooms.test.ts` (re-run verbatim over all 131
page files, not just the 108 doored ones) for what actually renders, and the
JPEG SOF segments of the eight files in `apps/web/public/plates/` for the
plates themselves.

---

## The ranked table — which room gets a second plate first

| # | Room | Routes standing in it | Plate files | Routes per wall | Verdict |
|---|---|---|---|---|---|
| **1** | **Front Office** `.room--office` | **40** | 1 (`plate-01-office-01.jpg`) | **40 : 1** | **Two more walls.** Worst wall drops 40 → 15. |
| **2** | **Gym Floor** `.room--floor` | **31** | 2 (landscape + portrait recut of the same wall) | **31 : 1** per orientation | **One more wall, as a pair** — a second landscape *and* its portrait recut, or the tablet loses the variant. |
| **3** | **Board Room** `.room--board` | **13** | 1 | 13 : 1 | Marginal. 11 of the 13 are seat workspaces that are *meant* to look alike. Hold. |
| **4** | **Clinic** `.room--clinic` | **9** | 1 | 9 : 1 | **Does not need a second wall. Needs a portrait recut** — 4 of its 9 routes carry kiosk-sized controls. |
| **5** | **File Room** `.room--file` | **7** | 1 | 7 : 1 | Needs nothing. |
| **6** | **After Hours** `.room--night` | **3** | 1 | 3 : 1 | Needs nothing. Three routes on one wall is not repetition. |

**Adjacent, outside the six rooms but the same defect:** the warm ground
`.on-canvas` (`plate-07-warm-ground-01.jpg`) carries **10 routes on one
landscape plate**, and two of them — `/athlete/sign-in` and `/activate` — are
upright-tablet sign-in surfaces, with the rest read on phones. It has no
portrait recut. See *The portrait case*.

### The order of work

1. **`plate-01-office-02.jpg` and `plate-01-office-03.jpg`** — two more front
   office walls. Office is 40 of the 103 room-bearing routes on the platform,
   and it is the room a staff seat lands in at sign-in (`/admin` for admin,
   `/workspace` for staff and volunteer) and two of the three destinations the
   global header links from every page in the building (`/operations`,
   `/dashboard`). Split by route prefix it goes 15 / 12 / 13 — see below.
2. **`plate-02a-floor-landscape-02.jpg` + `plate-02b-floor-portrait-02.jpg`**
   — one more floor wall, delivered as the pair. Floor is 31 routes and it is
   the room the gym tablet lives in; a landscape-only second variant would give
   the desktop two walls and the tablet one.
3. **`plate-03-clinic-portrait-01.jpg`** — a portrait recut of the existing
   clinic wall, not a new wall. Same argument the floor portrait plate was
   made on, applied to the second most kiosk-exposed room.
4. **`plate-07-warm-ground-portrait-01.jpg`** — a portrait recut of the warm
   ground, for the sign-in kiosk and the phone-side family surfaces.
5. **`plate-04-board-02.jpg`** — optional, and last. Only if the owner wants
   the two non-seat board surfaces (`/board`, `/admin/board-seats`) to read
   differently from the eleven seat workspaces.
6. **File Room and After Hours: nothing.** 7 routes and 3 routes on one wall
   each. A second file-room wall would be an image nobody notices.

---

## 1. Routes per room

### The shape of the building

| | Count |
|---|---|
| `page.tsx` / `page.ts` files in `apps/web/app` | **131** |
| …of which dynamic (`/store/[organizationId]`) | 1 |
| Doors declared in `buildingMap.ts` | **108** |
| Routes on disk with no door | 23 (15 `EXCLUDED`, 7 `PENDING_TRIAGE`, 1 dynamic — `buildingMapCoverage.test.ts`) |
| Routes that render one of the six rooms | **103** |
| Routes that render the warm ground `.on-canvas` | **10** |
| Routes that render no plate at all | **18** |
| Plate files committed | **8** |

103 + 10 + 18 = 131. Every page file is accounted for.

### Declared (the door) vs rendered (the wall)

`buildingMap.ts` declares a `room` on all 108 doors:

| Room | Doors declared | Renders that room | Renders canvas instead | Renders nothing |
|---|---|---|---|---|
| office | 44 | 35 | 3 | 6 |
| floor | 32 | 31 | — | 1 |
| board | 12 | 12 | — | — |
| clinic | 10 | 9 | — | 1 |
| file | 7 | 7 | — | — |
| night | 3 | 3 | — | — |
| **total** | **108** | **97** | **3** | **8** |

Six routes carry no door but do paint a room, and they consume the same plate
as everything else, so they belong in the per-room totals:

- office +5 — `/admin/athletes`, `/admin/export`, `/admin/organizations/test`,
  `/admin/platform/overview`, `/director/dashboard`
- board +1 — `/board/dashboard`

That gives the **40 / 31 / 13 / 9 / 7 / 3** in the ranked table (97 + 6 = 103).

One footnote: `/launch` is `export { default } from '../operations/page'`, so
in a browser it is a **41st** office surface. It is a re-export with no JSX of
its own, so the static resolver reports it as roomless and this document counts
office as 40. `buildingMap.ts` deliberately gives it no door — "two doors onto
one room is how a catalog starts lying about the size of the building."

### Where the door and the wall disagree

**No route paints a different room from the one its door declares.** The
resolver run over all 108 doors produced an empty drift list, an empty
ambiguous list, and `PAGE_IS_WRONG` in `buildingMapRooms.test.ts` is empty —
the two entries it once held (`/simulator` painting office inside the file-room
pipeline, `/coach/decision-loop` painting clinic over coaching work) are both
gone, and the test fails on any entry that outlives its fix.

There are, however, **eleven doors that declare a room the person never sees**,
and they are disagreements of a different kind — the door names a room, the
page paints something that is not a room, so there is no second answer for the
test to compare against:

| Route | Door says | Actually renders | Which is right |
|---|---|---|---|
| `/guardian` | office | warm ground (canvas) | The page. T7. |
| `/parent/dashboard` | office | warm ground (canvas) | The page. T7. |
| `/parent/progression-visibility` | office | warm ground (canvas) | The page. T7. |
| `/help` | office | warm ground (canvas) | The page. Open to families and to nobody signed in. |
| `/public` | office | warm ground (canvas) | The page. The only signed-out surface. |
| `/print` | office | warm ground, stripped by `@media print` | The page. Paper leaving the building. |
| `/parent/consent` | office | bare `--hide-950` ink, no plate | The page. T7 — room dropped on purpose. |
| `/parent/safety` | office | bare `--hide-950` ink, no plate | The page. T7 — room dropped on purpose. |
| `/store` | office | legacy `--canvas-tan`, no plate | Unsettled. Audience question before it is a room question. |
| `/retro-lab` | floor | `--canvas-tan` component showroom, no plate | The page. A brick wall behind samples of the things meant to be shown against it. |
| `/admin/safety-escalations` | clinic | nothing — the file is `redirect('/admin/escalations')` | The page. Nothing to paint. |

Seven of the eleven are the **office** door filed over a family or public
surface. That is not eleven bugs; it is the catalog needing a room name for a
row, and T7 overriding it at render time. It does mean the "44 office doors"
figure in the map overstates the office plate's real load by nine.

### Per-room route lists

`*` marks a route with no door in `buildingMap.ts`.

<details>
<summary><b>Front Office — 40 routes on <code>plate-01-office-01.jpg</code></b></summary>

`/admin` · `/admin/activation-codes` · `/admin/athletes`* ·
`/admin/attendance` · `/admin/coach-coverage` · `/admin/community-service` ·
`/admin/consent` · `/admin/credentials` · `/admin/customize` ·
`/admin/data-quality` · `/admin/door-register` · `/admin/export`* ·
`/admin/grants` · `/admin/memberships` · `/admin/organizations` ·
`/admin/organizations/test`* · `/admin/payments` · `/admin/people` ·
`/admin/pin` · `/admin/platform` · `/admin/platform/overview`* ·
`/admin/portrait-review` · `/admin/program-phases` · `/admin/public-interest` ·
`/admin/video-review` · `/admin/volunteer-management` · `/chalkboard` ·
`/coach/cohorts` · `/coach/disciplines` · `/dashboard` ·
`/director/dashboard`* · `/notices` · `/operations` ·
`/operations/external-competition` · `/operations/wrestling-league` ·
`/profile` · `/source-control` · `/source-control/publication-workflow` ·
`/staff-credentials` · `/workspace`

Clusters: `/admin/*` 25, top-level 9, `/operations/*` 2 (+`/operations` in
top-level), `/coach/*` 2, `/source-control/*` 1 (+top-level), `/director/*` 1.
</details>

<details>
<summary><b>Gym Floor — 31 routes on <code>plate-02a</code> / <code>plate-02b</code></b></summary>

`/athlete/dashboard` · `/athlete/dashboard/sparring` ·
`/athlete/progression-intelligence` · `/athlete/video-analysis` ·
`/coach/attempt-log` · `/coach/behavior-standards` · `/coach/credentials` ·
`/coach/cue-library` · `/coach/decision-loop` · `/coach/drills` ·
`/coach/environment/intake-router` · `/coach/environment/passbook-check` ·
`/coach/floor-groups` · `/coach/intelligence` ·
`/coach/intervention-executions` · `/coach/intervention-protocols` ·
`/coach/intervention-review` · `/coach/one-percent-club` ·
`/coach/passbook-gaps` · `/coach/performance-analytics` ·
`/coach/progression-intelligence` · `/coach/recognition` ·
`/coach/review-queue` · `/coach/session-scripts` · `/coach/transfer-check` ·
`/coach/video-analysis` · `/coach/video-publications` · `/names` ·
`/rabbit-holes` · `/schedule` · `/wall`

Clusters: `/coach/*` 23, `/athlete/*` 4, top-level 4.
</details>

<details>
<summary><b>Board Room — 13 routes on <code>plate-04-board-01.jpg</code></b></summary>

`/admin/board-seats` · `/board` · `/board/at-large` · `/board/chair` ·
`/board/community-director` · `/board/compliance-monitoring` ·
`/board/dashboard`* · `/board/escalation-monitoring` · `/board/president` ·
`/board/safety-director` · `/board/secretary` · `/board/treasurer` ·
`/board/vice-chair`

Clusters: `/board/*` 11 seat and monitoring workspaces, plus `/board` itself
and `/admin/board-seats`.
</details>

<details>
<summary><b>Clinic — 9 routes on <code>plate-03-clinic-01.jpg</code></b></summary>

`/admin/athlete-consent` · `/admin/compliance-center` · `/admin/escalations` ·
`/admin/feedback` · `/admin/safety-flags` · `/admin/safety-review` ·
`/admin/video-compliance` · `/admin/waiver-status` · `/coach/sports-medicine`
</details>

<details>
<summary><b>File Room — 7 routes on <code>plate-05-file-01.jpg</code></b></summary>

`/audit` · `/evidence` · `/knowledge-graph` · `/research` · `/research/chat` ·
`/research/review` · `/simulator`
</details>

<details>
<summary><b>After Hours — 3 routes on <code>plate-06-night-01.jpg</code></b></summary>

`/admin/shadow` · `/shadow` · `/shadow/scout`
</details>

---

## 2. Roomless surfaces

### The `UNPAINTED` map — 8 entries, all still standing

Every entry in `buildingMapRooms.test.ts`'s `UNPAINTED` was re-resolved and
every one still renders no room. The map cannot grow silently — a new roomless
page fails `does not let the roomless set grow` — and it cannot keep a stale
line either, since `does not keep a roomless entry for a page that now has a
room` fails on any entry whose page has since taken one.

| Route | Reason recorded | Kind |
|---|---|---|
| `/admin/safety-escalations` | the whole page is `redirect('/admin/escalations')`; it returns no JSX | **NO MARKUP** |
| `/print` | a gate around `PrintRoom`; print sheets carry their own paper ground | **NO MARKUP** |
| `/store` | legacy canvas-tan with `--black` type, open to families and signed-out visitors, so the ground is an audience question (T7) before it is a room one | **NEEDS A SLICE** |
| `/retro-lab` | the door says floor, but this is the component showroom on canvas-tan; a room here would put a brick wall behind samples of the things meant to be shown against it | **NEEDS A SLICE** |
| `/help` | `.on-canvas`, open to every role and to nobody signed in at all | **FAMILY GROUND** |
| `/public` | `.on-canvas`, the only surface a signed-out visitor sees | **FAMILY GROUND** |
| `/parent/consent` | guardian page, room deliberately dropped | **FAMILY GROUND** |
| `/parent/safety` | guardian page, room deliberately dropped | **FAMILY GROUND** |

Six have already left the map — `/dashboard` and the three `/operations`
surfaces took the office wall on one line each, and `/notices` and
`/admin/consent` had their ink converted first and then took it. What is left
is not a backlog of the same edit: four of the eight are **FAMILY GROUND** and
are finished, two are **NO MARKUP** and have nowhere to put a room, and only
`/store` and `/retro-lab` are open questions — and neither is an image order.

**For the image lane: nothing on this list is a missing plate.** No plate would
appear on any of these eight even if one were drawn.

### Family and signed-out surfaces — correctly roomless

T7 says a family surface takes the warm ground or none and never a room, and
`familyPlateGround.test.ts` asserts it where a comment could not: only 19 of
the room-bearing pages take their room from `RoleStandaloneView`'s prop, while
73 page files write a `room--` class straight into markup, which no shell can
intercept. Three family pages had done exactly that and were corrected.

**Ten routes stand on the warm ground and get `plate-07-warm-ground-01.jpg`:**
`/` · `/activate` · `/athlete/sign-in` · `/guardian` · `/help` · `/login` ·
`/parent/dashboard` · `/parent/progression-visibility` · `/print` · `/public`

**Eighteen routes get no plate at all** — no `.room`, no `.on-canvas`:

- *T7 family, room deliberately dropped rather than swapped:* `/parent/consent`,
  `/parent/safety`, `/guardian/dashboard` — all three on bare `--hide-950` with
  `mat-leather` panels. These are **correct**, not gaps: the pages say so in
  their own comments, and swapping them to `.on-canvas` without converting the
  ink is the readability trap `roleGround.ts` names.
- *Ways in:* `/change-pin`, `/auth/link`
- *Legacy canvas-tan:* `/store`, `/store/[organizationId]`, `/retro-lab`
- *Redirect / re-export:* `/admin/safety-escalations`, `/launch` (which paints
  office in the browser)
- *Prototypes with no door, reading no data:* `/admin/communications`,
  `/admin/curriculum`, `/admin/gear`, `/admin/gear/vendors`, `/admin/import`,
  `/admin/macro-analytics`, `/admin/retro-lab`, `/coach/operations`

None of the eighteen is an argument for a new image. Eight of them are
prototypes the coverage test explicitly refuses to advertise a door for.

---

## 3. Repetition pressure

The plate is a `background-image` on `.room::after`, one file per room, keyed
only by the `.room--*` class. There is no route in the selector, so **every
route in a room shows the identical wall**. Confirmed by reading the PLATES
block of `design-system/ppbf.css`: six one-line declarations, one
`@media (orientation: portrait)` override, one `.on-canvas` declaration, and
nothing anywhere in `app/`, `components/` or `src/` that computes a `--plate`
value.

**Corrected 2026-08-22:** the sentence that stood here — "No variant-selection
mechanism exists today" — was true on 20 Aug and was overtaken the same day by
PR #541, which added `apps/web/components/plateVariant.ts` and
`PlateVariantGround.tsx` plus a route-derived variants block in the sheet. See
`00-GROK-ORDER-BRIEF.md` for what shipped.

What is **still true**: every room sits at `-01`, and the `-0N` slot is open
and unused — eight plate files, all `-01`. The mechanism exists; no second
plate has been wired to it yet.

| Room | Routes | Walls | Ratio | Share of the 103 room-bearing routes |
|---|---|---|---|---|
| office | 40 | 1 | 40.0 | 38.8% |
| floor | 31 | 1 per orientation | 31.0 | 30.1% |
| board | 13 | 1 | 13.0 | 12.6% |
| clinic | 9 | 1 | 9.0 | 8.7% |
| file | 7 | 1 | 7.0 | 6.8% |
| night | 3 | 1 | 3.0 | 2.9% |

Office and floor together are **69% of every room-bearing route in the
building**, on two walls.

### Two live documents are wrong about these counts

Both files Grok is told to re-read before every order state the same stale
pair:

- `apps/web/public/plates/README.md`, *Adding a variant*: "office covers 42
  pages, floor 22"
- `design-system/ppbf.css`, PLATES header comment: "Rooms are reused heavily
  (office 42 pages, floor 22)"

Counted from source today: **office 40, floor 31.** The office figure is
close but high; the **floor figure is low by nine**, which understates the
room the gym tablet actually lives in — the one room where repetition is seen
by the same person for a whole session. Correcting those two comments is a
one-line edit in each and belongs to whoever next touches the plates, not to
this inventory.

*(Other stale figures noted while counting, all in test and map prose rather
than in the plate contract: `buildingMap.ts`'s header says "63 routes",
`buildingMapRooms.test.ts` says "Rendering 106 routes", `roomBaseClass.test.ts`
says "79 surfaces", `familyPlateGround.test.ts` says "~79 room-bearing
surfaces". The building is now 108 doors and 103 room-bearing routes. None of
these affects behaviour.)*

---

## 4. The portrait case

**The room with two plates is the Gym Floor**, and only the Gym Floor.

| File | Dimensions | Chroma | Size | Selected by |
|---|---|---|---|---|
| `plate-02a-floor-landscape-01.jpg` | 1280×720 | 4:4:4 | 127 KB | `.room--floor` |
| `plate-02b-floor-portrait-01.jpg` | 405×720 | 4:4:4 | 43 KB | `.room--floor` inside `@media (orientation: portrait)` |

All eight committed plates were re-verified for this document by parsing the
SOF segment directly: every one is 4:4:4 (`1x1,1x1,1x1`), carries both SOI and
EOI markers, and matches the dimensions the README claims. Seven are 1280×720;
`plate-02b` is 405×720. The README's table is accurate on every file.

### How the portrait variant is selected — and what it is not

Selection is by **viewport orientation**, in CSS, with no JavaScript and no
route involved. It is deterministic in the sense that matters: at a fixed
orientation the same route shows the same wall on every load, so screenshot
comparison holds as long as the harness fixes the viewport.

It is worth being precise, because the distinction changes the brief: **this is
not a second wall, it is the same wall recut.** The reason is written into the
sheet — "A landscape wall cropped to a portrait viewport loses the courses that
make it read as masonry" — so `plate-02b` exists to keep the floor looking like
the floor when the tablet stands up, not to add variety. Floor therefore still
has **one wall for 31 routes**, the same as office has one for 40.

This has a direct consequence for the order of work: a second floor variant
must be **delivered as a pair**, `-02` landscape and `-02` portrait. A
landscape-only second floor plate would give the desktop two walls and leave
the gym tablet — the constraint the whole plate set is sized around — on one.

### Does any other room need the same treatment?

Yes: **Clinic first, warm ground second.** The test is not "is the room nice",
it is "does a person stand in front of this room on an upright tablet". Law 5
kiosk sizing (`.btn--kiosk`, `.input--kiosk`, `.range--kiosk`, `.kiosk-bar`,
`.stamp--kiosk`) is the marker for that, and it appears on:

| Room | Routes with kiosk-scale controls | Portrait plate today |
|---|---|---|
| floor | `/athlete/*` (all 4, via `app/athlete/layout.tsx`), `/athlete/dashboard/sparring`, `/coach/environment/passbook-check` | **yes** |
| **clinic** | `/admin/escalations`, `/admin/compliance-center`, `/admin/video-compliance`, `/coach/sports-medicine` — **4 of its 9 routes** | **no** |
| warm ground | `/athlete/sign-in`, `/activate` | **no** |
| no plate at all | `/change-pin`, `/auth/link`, `/parent/consent` | n/a |

Clinic is the second most kiosk-exposed ground in the building, and its wall is
varnished cabinetry under a green shade — cabinetry has courses the same way
brick does, so it loses the same thing to a portrait crop that the floor wall
was recut to avoid. `plate-03-clinic-portrait-01.jpg` at 405×720 is the same
order that produced `plate-02b`.

The warm ground is a close third and is arguably worse in practice: it carries
ten routes, two of them the sign-in kiosk, and every family surface on it is
read on a phone, which is portrait by default. It sits outside the six rooms
(it is Law 6's second ground, not a room) but it is the same defect.

**Board, File and After Hours need no portrait plate.** No route in any of the
three carries a kiosk control; they are desk and console surfaces.

---

## 5. The judgement — where more art actually helps

### Office first, and it is not close

Front Office covers **40 routes on one wall** — 38.8% of every room-bearing
route in the building, four and a half times the load on the clinic wall and
thirteen times the load on the night wall. It is also the most-arrived-at
room: `/admin` is the admin landing route and `/workspace` is the landing route
for both staff and volunteer (`components/roleRoutes.ts`), and two of the three
links the global header puts on **every page in the building** —
`/operations` and `/dashboard` — are office surfaces
(`components/GlobalRoleHeader.tsx`).

Two more office walls, split by route prefix, take the worst single wall from
**40 routes to 15**:

| Wall | Cluster | Routes |
|---|---|---|
| `plate-01-office-01` (existing) | Records and people — the front desk proper | **15** — `/admin`, `/admin/people`, `/admin/athletes`, `/admin/pin`, `/admin/activation-codes`, `/admin/attendance`, `/admin/door-register`, `/admin/portrait-review`, `/admin/credentials`, `/admin/consent`, `/admin/data-quality`, `/admin/export`, `/admin/memberships`, `/admin/organizations`, `/admin/organizations/test` |
| `plate-01-office-02` (new) | Daily desk — the surfaces staff open every session | **12** — `/dashboard`, `/workspace`, `/operations`, `/operations/external-competition`, `/operations/wrestling-league`, `/notices`, `/chalkboard`, `/profile`, `/staff-credentials`, `/coach/cohorts`, `/coach/disciplines`, `/director/dashboard` |
| `plate-01-office-03` (new) | Programme, money and platform — the back desk | **13** — `/admin/grants`, `/admin/payments`, `/admin/public-interest`, `/admin/program-phases`, `/admin/community-service`, `/admin/volunteer-management`, `/admin/coach-coverage`, `/admin/customize`, `/admin/video-review`, `/admin/platform`, `/admin/platform/overview`, `/source-control`, `/source-control/publication-workflow` |

15 + 12 + 13 = 40. The split is by route prefix on purpose: a rule derived from
the path is deterministic by construction, which is what both the plates README
and the Grok lane contract require. **How** such a rule would be expressed is
out of scope here — this document only establishes that the clusters exist and
divide cleanly.

Composition note for the lane: all three must be the same front office on the
same day. Plank wall, desk lamp, paper and riveted cards
(`docs/shadow-ui/ROOM-PURPOSE-DNA.md`, room 1). Different corner of one room,
not three different offices — and none of them may drift toward clinic green,
board wainscot or floor drama, which that document lists as forbidden for this
room specifically.

### Floor second, as a pair

31 routes, one wall per orientation, and it is the room a coach and an athlete
stand in for an entire session rather than passing through. The `/coach/*`
cluster alone is 23 routes. A second wall split coach-desk work
(`attempt-log`, `intervention-*`, `review-queue`, `transfer-check`,
`passbook-gaps`, `performance-analytics`, `progression-intelligence`,
`video-*`, `credentials`, `intelligence`, `decision-loop`) from floor-side work
(`drills`, `cue-library`, `session-scripts`, `floor-groups`, `recognition`,
`behavior-standards`, `one-percent-club`, `environment/*`, the four
`/athlete/*`, `/names`, `/schedule`, `/wall`, `/rabbit-holes`) divides 14 / 17.

**Two files, not one:** `plate-02a-floor-landscape-02.jpg` (1280×720) and
`plate-02b-floor-portrait-02.jpg` (405×720). Brick and mortar, caged lamps;
gloves and bags as DNA, not clutter.

### Board third, and only on request

13 routes looks like pressure until you read them: eleven are `/board/*` seat
workspaces — president, chair, vice-chair, treasurer, secretary, safety
director, community director, at-large, plus the two monitoring surfaces. Those
are *supposed* to be indistinguishable. The room's DNA is "painted wainscot,
plaster, dark ink, formal quiet", its motion is count tiles, and easter eggs
are marked **NEVER**. A board member moving between seat workspaces reading the
same wall is the room working as specified. The only case for `plate-04-board-02`
is separating `/board` and `/admin/board-seats` from the seats — 2 routes
against 11 — and that is a taste call for the owner, not a repetition problem.

### Clinic fourth — a recut, not a wall

Nine routes does not justify a second wall. Four of those nine carrying
kiosk-sized controls does justify a portrait plate, for exactly the reason the
floor has one.

### File Room and After Hours — nothing

**File Room serves seven routes.** `/audit`, `/evidence`, `/knowledge-graph`,
`/research`, `/research/chat`, `/research/review`, `/simulator`. Seven routes
on one cork wall is not repetition; it is a room. It needs no second plate and
no portrait plate.

**After Hours serves three routes.** `/shadow`, `/shadow/scout`,
`/admin/shadow`. Three. It needs nothing at all, and a second night plate
would be the least noticed image in the set.

---

## What this inventory did not touch

Binary plate files, CSS-drawn materials, and glyphs and photographs are owned
by three other agents and are deliberately absent here except where a fact
about a plate file was needed to answer a question about coverage — in which
case it was measured from the committed bytes rather than quoted from a
document.

No app code, CSS, or test was changed. `npm test` from `apps/web` is
**539 suites / 6917 tests** on this branch, unchanged from
`a11ea7c166f7659e4c5bb63337d44323069febaa`.
