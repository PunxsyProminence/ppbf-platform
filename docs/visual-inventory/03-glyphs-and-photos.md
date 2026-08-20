# Visual inventory 03 — glyphs and photo slots

**Scope.** Two questions for the Grok image lane: *what iconography does this
platform use*, and *where does it display photographs*. Written read-only; no app
code, CSS, or test was touched.

**Baseline.** `origin/main` @ `a11ea7c166f7659e4c5bb63337d44323069febaa`
("Give the guardian's consent controls the targets they claimed to have", #525,
20 Aug 2026). `npm test` from `apps/web` verified on that tree:
**539 suites / 6917 tests, all passing** — unchanged by this document, which adds
one file under `docs/`.

Two sibling lanes own the binary image files (`apps/web/public/plates/`) and the
CSS-drawn materials (`design-system/ppbf.css`). This report stays out of both and
names them only where a photo slot depends on one.

---

## 1. NOT GROK'S JOB — these need a camera, not a generator

**Count: 12 photograph-bearing surfaces. All 12 need a camera. Zero are safe for
an image generator.**

This is the more important of the two lists. Every surface below is defined, in
the code that renders it, as a picture of *this* building or *this* person. A
generated image dropped into any of them is a fabrication presented to a parent
as fact — and on several of them, a fabricated photograph of a child on a youth
nonprofit's public page.

### 1a. Pictures of the actual building — 6 slots

Declared in `apps/web/src/shared/gymPhotos.ts` (`GYM_PHOTO_SLOTS`). Each names a
real room at 220 N Jefferson St.

| key | title | surfaces | what it must be |
|---|---|---|---|
| `entrance` | The front door | public | the actual door, as seen pulling up |
| `floor` | The floor | public, dashboard | the training floor on an ordinary night |
| `ring` | The ring | public, dashboard | the ring in that room |
| `bags` | The bags | public, dashboard | the heavy/speed/double-end bags on that wall |
| `wraps-bench` | Where you wrap up | public, dashboard | the bench and hooks by the door |
| `wall` | The wall | dashboard | whatever is taped up there this month |

The manifest's own header states the standing rules: **no stock photography, no
fake-photorealistic imagery, and no people — not even drawn ones.** The captions
are written to be true while the frame is empty, and `/public` runs a three-way
caption check that refuses to call a drawing a photograph
(`apps/web/app/public/page.tsx:572-580`).

These six currently hold **commissioned placeholder illustrations** (see §2), by
owner decision 2026-08-06. The illustrations are the sanctioned stand-in and were
correctly built as line drawings that say `PLACEHOLDER ILLUSTRATION` inside the
image. **Replacing them with a photorealistic generated "gym" would be the exact
failure the illustration decision was designed to avoid.** The replacement is a
camera, not a better prompt.

### 1b. A real coach's face — 1 slot

`GYM_STAFF_CARDS` in `apps/web/src/shared/gymPhotos.ts`, rendered on `/public`
under **"WHO WOULD BE COACHING YOUR KID"** (`apps/web/app/public/page.tsx:604-618`).

One entry: the **head coach** role. `photo: null`. The section's own copy says
"You should know the face of whoever is going to be working with your kid before
you leave them here." A generated face there is a stranger's invented likeness
attached to a named real person on a safeguarding-critical page. It needs a
photograph of him, taken by somebody, and nothing else.

The same file's `bio` field carries a written-out prohibition on invented content
("A fabricated coaching history on a youth sports page is not a copy problem, it
is a safeguarding one"). The photo field inherits that reasoning.

### 1c. Member and athlete portraits — 5 render surfaces

Served from `pilot.account_profiles` through `components/ProfilePortrait.tsx`; a
member uploads their own via `components/ProfileSettings.tsx`.

| # | surface | file | note |
|---|---|---|---|
| 1 | Fight card subject portrait (`size="lg"`) | `components/FightCard.tsx:50` | the athlete's own card |
| 2 | Fight card coach portrait (`size="sm"`, decorative) | `components/FightCard.tsx:84` | "In your corner" |
| 3 | Parent hub child tab chip (`size="sm"`) | `components/ParentHub.tsx:577` | one per child |
| 4 | Coach roster row (`size="sm"`) | `components/CoachWorkspace.tsx:1830` | one per athlete |
| 5 | Portrait review queue, full-width `<img>` | `app/admin/portrait-review/page.tsx:312` | max-height 420px |

**Most of these are minors.** The review queue at `/admin/portrait-review` exists
precisely so a human looks at a child's submitted photograph before it is
released, and the Approve button is gated on the browser having actually decoded
and painted the bytes. Generating anything into this pipeline is not a design
shortcut, it is manufacturing a child.

There is also an explicit *refusal* worth recording: printed artifacts
(`components/PrintSheet.tsx`) carry **no photograph at all**, deliberately — paper
leaves the building and has no session behind it. That is a decision, not a gap.

---

## 2. EMPTY SLOTS — ready to display a photograph, none supplied

**Count: 7 declared photo slots exist in the manifest layer. 0 hold a
photograph.** Adding the 5 portrait render surfaces above (which show a brass
plate until a member uploads), a viewer today sees **12 photograph-shaped places
with no photograph in them**.

Confirmed by file census: the repository contains **no photograph of any person
or of this gym**. The only raster files on `origin/main` are the seven background
plates in `apps/web/public/plates/` (layer-0 room backgrounds, sibling lane), one
`opengraph-image.png`, and one research seed figure.

| # | slot | surface(s) | what is there today | empty state |
|---|---|---|---|---|
| 1 | `entrance` | `/` (homepage), `/public` | `entrance.svg` placeholder illustration | n/a — illustration fills the frame |
| 2 | `floor` | `/`, `/public`, dashboards | `floor.svg` | n/a |
| 3 | `ring` | `/`, `/public`, dashboards | `ring.svg` | n/a |
| 4 | `bags` | `/public`, dashboards | `bags.svg` | n/a |
| 5 | `wraps-bench` | `/public`, dashboards | `wraps-bench.svg` | n/a |
| 6 | `wall` | dashboards only | `wall.svg` | n/a |
| 7 | **head coach portrait** | `/public` "Who would be coaching your kid" | **nothing** | wood-mould frame, empty paper mount, engraved caption, and the line "Nothing written here yet. Come in and ask him yourself." |
| 8–12 | 5 portrait surfaces (§1c) | fight card ×2, parent hub, coach roster, review queue | nothing in-repo | brass nameplate struck with the member's initials |

**Slot 7 is the single most visible hole a stranger sees today.** It is the only
frame on any public surface that renders genuinely empty, and it sits directly
under a heading asking a parent to look at the face of the person who will coach
their child.

The admin upload path is also empty: `/admin/customize` can hang a real photograph
in any of slots 1–6 (org-scoped private blob, EXIF/GPS stripped), and nothing has
been uploaded — the page shows `PLACEHOLDER ILLUSTRATION` beside every frame until
one is.

### Where a photograph physically goes

Two sanctioned paths, one release rule ("a person who can see the picture
decides"):

1. **Commit it.** Drop the file in `apps/web/public/gym/`, set that slot's `file`
   in `src/shared/gymPhotos.ts`. `gymPhotoSrc()` rejects anything that is not a
   plain filename — no cross-origin, no `..`, no API route.
2. **Upload it.** `/admin/customize` → `POST /api/pilot/admin/gym-photos`.

### Declared dimensions and limits

| thing | value | source |
|---|---|---|
| Wide mount aspect ratio | **3 : 2** | `app/globals.css:1539-1542` (`.photo-slot--wide`) |
| Tall mount aspect ratio | **4 : 5** | `app/globals.css:1544-1547` (`.photo-slot--tall`) — used for the staff card |
| Existing placeholder canvas | 1220 × 754 (≈ φ) | all six `public/gym/*.svg` viewBoxes |
| Gym photo max file | 8 MB | `src/server/pilot/gymWallPolicy.ts:23` |
| Gym photo max long edge | 6000 px | `gymWallPolicy.ts:26` |
| Gym photo min short edge | 320 px | `gymWallPolicy.ts:28` |
| Gym photo formats | JPEG, PNG only | `gymWallPolicy.ts` — "No WebP, no HEIC, no SVG (a script host wearing an image's extension), no GIF" |
| Portrait stored edge | 512 px | `src/server/pilot/profilePhotoPolicy.ts:40` |
| Portrait max / min edge | 640 px / 96 px | `profilePhotoPolicy.ts:47,50` |
| Portrait max file | 1.5 MB | `profilePhotoPolicy.ts:53` |
| Coach credential upload | PDF/JPEG/PNG, 10 MB | `src/server/pilot/credentialUploadPolicy.ts:34,45-48` |

Every image mount uses a bare `<img>`, never `next/image` — deliberately, three
times over, because the optimizer's shared server-side cache would outlive the
session and review gates that decide who may see a face.

### Two photo mounts drawn in the design system but never built

`design-system/screens/guardian-portal.html:64-71` and
`design-system/screens/public-onboarding.html:136-145` both draw a "Photo On File"
mount (the guardian one with a 👤 glyph, the onboarding one with corner clips and
the line "Bring a snapshot for the wall on your first day"). Neither exists in
`apps/web`. Mockup-only; flagged so nobody counts them as shipped slots.

---

## 3. Video — adjacent, out of Grok's lane, but it exists

Named separately because the owner asked. **Four `<video>` render sites**, all
playing footage uploaded by a coach; no generator has any business near any of
them.

| route | file | what |
|---|---|---|
| `/athlete/video-analysis` | `app/athlete/video-analysis/page.tsx:143` | "Your Film" — rounds a coach put up for the athlete |
| `/coach/video-analysis` | `app/coach/video-analysis/page.tsx:633` | coach player, plus the only video **upload** control (`accept="video/*"`, line 646) |
| `/admin/video-review` | `app/admin/video-review/page.tsx:266` | review queue |
| `/admin/video-compliance` | `app/admin/video-compliance/page.tsx:333` | compliance queue; unplayable state uses the `▶` empty glyph |

`/coach/video-publications` manages the publication lifecycle without playing
anything. Footage of minors is governed by consent and retention policy
(`docs/DATA_RETENTION.md`, evidence rows A8-040/A8-041/A8-074). Nothing here is an
image-generation task.

---

## 4. The glyph vocabulary

### 4a. There is no icon library. That is deliberate.

`apps/web/package.json` has **nine runtime dependencies**: `@azure/storage-blob`,
`googleapis`, `jose`, `next`, `pdf-parse`, `pdfkit`, `pg`, `react`, `react-dom`.
No lucide, no react-icons, no heroicons, no Font Awesome, no Phosphor, no
Material Icons, no icon font of any kind — in dependencies or devDependencies, at
the workspace root or in `apps/web`.

Every mark in this platform is either **a literal Unicode character typed into
the markup** or **a shape drawn in CSS**. Grok should treat the absence as a
design fact, not an omission: there is no icon set to extend, and adding one
would break the thing the glyphs exist to satisfy.

**Why glyphs at all — Law 3.** From `design-system/README.md:52-54`: *"Colour is
never the only channel. Every state carries a distinct glyph (`✓ ◉ ▲ ✕`) and an
uppercase label. The ladder survives greyscale printing for board packets and
every form of colour blindness."* The same sentence is compiled into
`design-system/manifest.json:24` and restated at `design-system/ppbf.css:16`.

### 4b. Inline SVG in `apps/web` — exactly one

`components/TrainingCard.tsx:318-350` — the **Seal**, a 52×52 roundel drawn with
two circles plus curved rim text on a `textPath` ("PPBF · LOGGED") and a session
count in the middle. Zero-asset, `role="img"` with a real label, inks from
`var(--card-ink)`.

Elsewhere: `app/icon.svg` is the favicon (the seal reduced to what survives 16px);
`app/globals.css:337` embeds a `feTurbulence` noise SVG as a data URI;
`public/gym/*.svg` are the six placeholder illustrations; `public/next.svg`,
`window.svg`, `globe.svg`, `vercel.svg`, `file.svg` are unused Next.js scaffolding
left over from `create-next-app`.

### 4c. The status ladder — the four rungs that carry meaning

Five badge classes exist in CSS (`badge--cleared`, `--monitor`, `--restricted`,
`--locked`, `--filed`); `.badge` classes appear **322 times across 74 files**.
Distribution: `cleared` 77, `restricted` 70, `monitor` 70, `locked` 66, `filed` 35.

| glyph | U+ | rung | marks | occurrences (prod) | files |
|---|---|---|---|---|---|
| `✓` | 2713 | `badge--cleared` | cleared, approved, active, complete, verified, passed | **111** | 62 |
| `✕` | 2715 | `badge--locked` | rejected, locked, blocked, failed, critical, error, "close" | **137** | 84 |
| `▲` | 25B2 | `badge--restricted` | restricted, pending, needs attention, high severity, warning | **103** | 46 |
| `◉` | 25C9 | `badge--monitor` | monitor, in progress, under review, medium/low severity | **62** | 40 |
| `◌` | 25CC | `badge--filed` / empty | neutral chip, unknown, nothing-here empty state | **37** | 23 |
| `▣` | 25A3 | `badge--filed` | filed, closed, ended, archived, "on record" | **15** | 13 |

Counts are literal character occurrences in non-test `.ts`/`.tsx` under
`app/`, `components/`, `src/`, `lib/`. By role, across the four core marks:
**194 in badges, 86 in alerts, 48 in empty states, 41 in other `<i>` chrome, 12
in glyph constant maps.**

`<i>` elements: **153 call sites**, of which **141 carry a glyph character** and 12
are self-closing CSS-drawn marks (`.lamp` ×9, a corner mark, two legend swatches).
62 are `<i aria-hidden="true">`, 78 are bare `<i>`.

### 4d. Alert icons — 86 call sites

`.alert-icon` inside `.alert--critical` (72), `--warning` (29), `--success` (10),
`--info` (2), `--tight` (14).

`✕` 56 · `▲` 18 · `✓` 9 · two ternaries · **one `!`** (`<i aria-hidden="true">!</i>`
— an expiring-credential band; the only ASCII glyph in the whole alert set).

### 4e. Empty-state glyphs — 48 call sites

`.empty-glyph`, sized 48px at 42% opacity (`ppbf.css:2233`), always
`aria-hidden="true"` because the `.empty-title` beside it carries the words.

| glyph | count | used for |
|---|---|---|
| `◌` | 20 | nothing here yet / still loading |
| `✕` | 10 | the list could not be loaded (unavailable ≠ empty) |
| `⌾` | 7 | admin lists with no rows (`/admin`, `/admin/people`, card catalog) |
| `🥊` | 4 | no progression data yet — **the only emoji used as a UI mark** |
| `▤` | 3 | no notices / no register entries / no consent rows |
| `⊘` | 2 | `/admin` — nothing permitted here |
| `✓` | 1 | nothing outstanding (a *good* empty) |
| `▶` | 1 | video not playable |

### 4f. The wider glyph set — every other mark in use

| glyph | U+ | occ | where / what it marks |
|---|---|---|---|
| `◴` | 25F4 | — | **`.working` spinner**, drawn as a `::before` in `ppbf.css:2545`. Not in the TSX at all — but **41 call sites** use `className="working"`, making it one of the most-rendered marks on the platform. |
| `●` `○` | 25CF / 25CB | 4 / 4 | filled vs hollow dot — "current" phase and "active" protocol; low severity; model available/unavailable in the SHADOW picker; sound-off in `SoundToggle` |
| `◼` | 25FC | 2 | stopped / retired — a hard stop, `badge--locked` |
| `▶` | 25B6 | 2 | in progress (`badge--monitor`); video-not-playable empty state |
| `▼` | 25BC | 1 | trend falling (`badge--restricted`) — the only downward mark |
| `△` | 25B3 | 1 | adherence unknown (hollow counterpart to `▲`) |
| `▪` | 25AA | 1 | evidence-role bullet on an intervention review row |
| `▤` | 25A4 | 4 | "the record" — three empty states plus the Corridor trigger |
| `⌾` | 233E | 7 | empty admin list / empty card catalog |
| `⌘` | 2318 | 7 | command-overlay affordance |
| `★` | 2605 | 2 | `WallDisplay.tsx:406,417` — marquee separator on the gym wall board. Decoration, not status. |
| `→` | 2192 | 34 | flow/step arrows in prose and route labels |
| `•` | 2022 | 30 | inline separator |
| `⚠` | 26A0 | 3 | two are in the legacy prototype surfaces (§4h); one is an admin marker |

**The seven refusal stamps** (`components/RefusalStamp.tsx`, 19 call sites across
7 files) are a deliberate second vocabulary, chosen so shape alone separates them
with no colour at all:

| glyph | stamp | reasoning as written in the file |
|---|---|---|
| `◷` | WAIT | a clock quadrant, time passing |
| `◈` | GET PERMISSION | a request handed to someone else, not yet resolved |
| `✕` | MEDICALLY NOT ALLOWED | matches the rejected/locked glyph elsewhere |
| `⌂` | WRONG DOOR | a house/door glyph, literally "wrong door" |
| `◻` | SIGNED OUT | an empty frame, nothing left open |
| `▲` | CANNOT BE DONE | the caution triangle Law 3's own example uses |
| `‖` | TRAINING HOLD | pause bars: literally "on hold" |

Card-catalog and sound controls add three more: `◍` sound on, `◌` sound off,
`◎` (`CardCatalog.tsx:173,195`), and `◐` (`SoundToggle.tsx:47`).

### 4g. Is the set defined anywhere? No — it is ad hoc, and it has drifted

**There is no shared glyph module and no shared `<Badge>` component.** The
canonical four-rung ladder is stated in prose in `design-system/README.md` and
then **re-declared by hand at 171 sites across 33 files** as `glyph: '…'` literals
in local objects and ternaries. Three files define a near-identical `BadgeTone`
type and glyph record independently:

- `components/CoachWorkspace.tsx:287-294` (`BADGE_GLYPH`, 5 tones)
- `app/coach/decision-loop/page.tsx:89-96` (`BADGE_GLYPH`, 5 tones)
- `app/coach/video-publications/page.tsx:33-40` (`STATUS_GLYPH`, 4 tones)

All three agree on `✓ ◉ ▲ ✕`. **The drift is at the edges**, and it is worth
flagging because Grok will otherwise assume a tighter system than exists:

1. **`badge--filed` has no single glyph.** It is `◌` in some places
   (`knowledge-graph`, `CoachWorkspace`'s neutral chip), `▣` in others
   (`/admin/memberships`, `/admin/credentials`, `/coach/credentials`,
   `/admin/program-phases`), `○` in another (`/admin/platform`), and `■`
   (U+25A0) in yet another (`/admin/platform`). Four glyphs, one rung.
2. **`/admin/platform` writes its glyphs as escapes** — `'✓'`, `'■'`,
   `'▲'`, `'○'` (`app/admin/platform/page.tsx:87-107`) — so they are
   invisible to any grep for the literal characters, and it introduces `■`
   (U+25A0), which appears nowhere else on the platform.
3. **A literal `'?'` is used as a badge glyph** for unknown gym standing
   (`app/admin/platform/page.tsx:114`).
4. **A literal `'!'` is used as an alert icon** for an expiring credential band.
5. **`✓` and `▲` are frequently inlined as bare text**, not as an `<i>` mark —
   34 and 26 occurrences respectively, e.g. `'✓ Saved…'`, `'▲ {blockedReason}'`.
   These carry a glyph but not the uppercase label Law 3 asks for.
6. **78 of 141 glyph-bearing `<i>` elements have no `aria-hidden`**, so a screen
   reader announces the character alongside the label it already reads.
7. **`🥊` (emoji) sits in four empty states** beside a system that is otherwise
   entirely geometric Unicode.

None of these are broken; all are drift. Anyone tightening the set later should
pick one `badge--filed` glyph and put the ladder in one exported module.

### 4h. Two prototype surfaces use a different vocabulary entirely

`/admin/communications` (`src/components/communications/MediaAndCommsHub.tsx`) and
`/admin/retro-lab` (`src/components/core/PunxsyEcosystemCore.tsx`,
`DevToolsQAConsole.tsx`) are unwired prototypes — the building-map coverage test
records the first as *"prototype: 13 useState hooks and performs no fetch or
query."* They use `📂` folder emoji and a `⚠️ WARNING` banner and belong to no
design law. Not part of the platform's vocabulary; listed so nobody mistakes them
for it.

---

## 5. One documentation drift worth a follow-up ticket

Four source comments name the admin photo page as **`/admin/gym-photos`**
(`src/shared/gymPhotos.ts:41`, `components/GymWallModule.tsx:20`,
`src/server/pilot/blob.ts:208`, `src/server/pilot/gymWallPolicy.ts:9`). That route
does not exist. The page is **`/admin/customize`**, drawer 1 ("Photographs on the
wall"). The API route `/api/pilot/admin/gym-photos` is correct and unchanged — it
is only the *page* path in the prose that is stale. Not fixed here; this report
changes no code.

---

## Appendix — where every photograph-capable surface lives

| file | role |
|---|---|
| `apps/web/src/shared/gymPhotos.ts` | the model: 6 building slots, 1 staff card, `gymPhotoSrc()` path guard |
| `apps/web/components/PhotoSlot.tsx` | one frame: wood moulding, paper mount, engraved caption; empty is the primary state |
| `apps/web/components/GymWallModule.tsx` | dashboard wall, 12s rotation (suppressed under reduced motion, never created below 2 photos); shows 2 empty frames when nothing is filled |
| `apps/web/app/page.tsx:179-184` | homepage "The Room" — 3 frames (entrance, floor, ring) |
| `apps/web/app/public/page.tsx:583-618` | `/public` — 5 building frames + the staff card |
| `apps/web/app/admin/customize/page.tsx:216-270` | the only place a gym photograph is uploaded or removed |
| `apps/web/components/ProfilePortrait.tsx` | a member's face, or the brass initials plate that stands in for it |
| `apps/web/components/ProfileSettings.tsx:182-217` | the member's own portrait upload |
| `apps/web/app/admin/portrait-review/page.tsx` | the human gate before a portrait is released |
| `apps/web/components/PrintSheet.tsx` | deliberately carries no photograph, ever |
| `apps/web/src/server/pilot/gymWallPolicy.ts` | building-photo upload bounds |
| `apps/web/src/server/pilot/profilePhotoPolicy.ts` | portrait upload bounds |
