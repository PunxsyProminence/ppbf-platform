# PPBF Design System — "Leather & Brass"

Visual foundation for the PPBF Platform.

**Source of truth:** [ppbf.css](ppbf.css) — tokens, materials, and components in one
sheet. Every preview in this folder consumes it.

---

## The direction

The platform looks like a boxing gym that has been run properly for forty years — and
not one room of it, the whole building. A front office of stained plank and ledgers, a
gym floor of brick and caged lamps, a board of screwed-on brass nameplates, a file room
walled in cork, a clinic under a green banker's shade. Oiled leather, cast brass, a slate
board with today's sessions on it, and a stamp pad for anything official.

That is not decoration. It solves a real problem: PPBF serves one spectrum with two very
different halves — a nine-year-old checking in at a floor tablet, and an AF_SPECOPS
candidate reading a load profile. Guardians renewing waivers. Grant officers reading
impact. Abstract flat UI gives all of them the same undifferentiated grey. Physical
objects give each surface an obvious identity and an obvious weight: a chalkboard is
today and it gets erased, a stamped paper is a decision and it does not.

**Nothing is fetched at runtime.** All texture — every wall, material, stain and grain —
is generated from SVG `feTurbulence` data URIs and layered gradients, so there are no
image assets at all. The five type faces are the one exception to "no files": they are
real `.woff2` files, but self-hosted from `fonts/` rather than pulled from a CDN, and
they total 182 KB. The constraint that actually matters is unchanged — the kiosk renders
on a cold tablet with no network, and grant packets print identically anywhere.

---

## The eight laws

**1. Brass is the chassis, never the message.**
Frames, rivets, rope trim, gauge bezels, tile edges, button faces. Brass is what the
platform is *built from*. It never tells you a status — the moment gold means something,
every frame on the page starts lying.

**2. Saturated colour means safety or status. Nothing else may use it.**
Green, blue, orange and red appear only to communicate a participant's safety state or a
queue outcome. Against leather and brass, a saturated pixel is unmissable — that is the
budget, and it is spent entirely on the Layer 11 Gate Matrix.

This is the easiest law to break by accident. The gauge component (`.gauge-arc`) ships a
red danger band, and it is tempting to add it to every metric because it looks sharper —
but a plain headcount or percentage has no "too high," so the arc has nothing to say.
Include it only where a real threshold exists (near-capacity, open alerts); leave it off
everything else, even if the empty dial looks plainer. Plainer is correct.

**3. Colour is never the only channel.**
Every state carries a distinct glyph (`✓ ◉ ▲ ✕`) and an uppercase label. The ladder
survives greyscale printing for board packets and every form of colour blindness.

**4. Six voices, each with a job.**

All are **self-hosted, SIL OFL 1.1, and free** — five files, 182 KB total, latin subset
only, no CDN (see `fonts.css`). The display voice is **wood type, not stencil**: the
reference art is a jobbing printshop — heavy slab, letterpress-printed, ink broken up at
the edges. Stencil letterforms carry bridges through the strokes and not one reference
header has them. `--font-stencil` survives as an alias so older markup keeps working.

The display voice is **Alfa Slab One**, chosen over two other candidates that shipped
briefly for comparison. It beat Archivo Black (heavy grotesque) because every reference
header has visible serif feet, and beat Oswald 700 (condensed) because Oswald is already
`--font-ui` — a display voice that is the body voice at a heavier weight is not a second
voice at all. Archivo Black's file was deleted with the decision; Oswald stays, doing the
bone-sans job.

- **Display** commands — headers, mottos, tile names, buttons. It gives orders.
  `.t-press` bites it into the paper, `.t-eroded` breaks the ink up.
- **Bone sans** informs — body copy, forms, anything read at length.
- **Chalk** schedules — the day's sessions. Erasable by definition.
- **Hand** annotates — a coach's note, a physician's observation, a signature.
- **Gothic** (`.t-gothic`) is the clinic masthead only. Never body copy; it fails Law 3 small.
- **Typed** (`--font-type`, Special Elite) is a document that came out of the back-office
  typewriter — prose that was typed, not printed. Distinct from mono, which is for columns
  that must align.
- **Mono** records — IDs, timestamps, RPE, ledger hashes. Anything auditable.

**5. Kiosk-first sizing.**
Anything an athlete touches on the gym floor is at least `--tap` (55px) with `--t-md`
(19.1px) type. Sweaty hands, bad light, a queue behind them. Desks may go smaller; the
floor may not.

**6. Every screen is a room, and every panel in it is a real object.**
The platform is a building. A **room** supplies three things — the *wall* behind
everything, the *light* falling on it, and the floor-level *shadow* — and the panels
standing in it are furniture: leather, brass, slate, cork, paper, stained wood, brick.
If a surface isn't one of those materials it doesn't ship. This is the rule that keeps
skeuomorphism from sliding into pastiche: there is a fixed vocabulary and nothing gets
invented per-screen.

The six rooms, chosen by what a screen **is** rather than who is looking at it:

| Room | Wall + light | For |
|---|---|---|
| `.room--office` | stained plank, two desk lamps | admin, records, audit, organizations |
| `.room--floor` | brick and mortar, caged lamps | schedule, gym-floor kiosk |
| `.room--board` | wainscot, hung board, brass nameplates | rosters, board seats, assignments |
| `.room--file` | cork wall, gooseneck | research, evidence, knowledge graph |
| `.room--clinic` | varnished cabinetry, green banker's shade | medical, clearance, safety |
| `.room--night` | the ink ground | after hours, locked kiosk |

This supersedes the earlier "two grounds — ink for staff, warm canvas for family"
formulation. That rule sorted screens by *audience*, which forced dense operational
surfaces (Shadow, the admin console, the workspaces) onto a near-black ground that no
reference art ever used, while a governance record and a family record — the same
object, a sheet of stamped paper — ended up on opposite grounds. Rooms sort by what
the screen is instead, which is why the audit log and the guardian report can both be
paper on wood while the after-hours kiosk keeps its ink.

A room sets the wall and the light, and nothing else. It never sets **status** (Laws 2
and 3 hold in every room), never sets **proportion** (Law 8 likewise), and never
softens **refusal** (Law 7: a declined action is stamped in ink whether the page hangs
on brick or on cork).

**Where the app stands.** Rooms are wired into `apps/web` through the three shells that
already wrap most pages, so a page declares its room and inherits wall, light and shadow:

| Shell | How | Pages |
|---|---|---|
| `RoleStandaloneView` | `room="floor"` prop | athlete, coach, parent, guardian, shadow, compliance-center |
| `FeatureSurface` | `room="file"` prop | research, knowledge-graph |
| `BoardMemberDashboard` | `.room--board` on its `<main>` | all eight board seat workspaces |

Pages with their own `<main>` carry the class directly (`admin`, `board` hub, `schedule`,
`evidence`, `compliance-monitoring`). The prop is optional and defaults to no room, so a
page that has not been assigned one renders exactly as it did before — the rollout is
additive, never a flag day.

**7. Refusal is a stamp, not an error toast.**
When Layer 20 declines to answer, or Layer 17 withholds a cohort below the k-anonymity
threshold, it says so in ink on the page: `RESEARCH NEEDED`, `REDACTED`. A stamp is
permanent, attributable, and impossible to dismiss by accident. Toasts are none of those
things, and a governance platform cannot have its governance swiped away.

**8. Proportion descends from φ. Nothing is sized by eye.**
The golden ratio is load-bearing, not ornamental:

| Axis | Rule | Values |
|---|---|---|
| Type | climbs by √φ (1.272) from a 15px base | 11.8 · 15 · 19.1 · 24.3 · 30.9 · 39.3 · 50 · 63.6 |
| Space | Fibonacci, which converges on φ | 3 · 5 · 8 · 13 · 21 · 34 · 55 · 89 |
| Radius | Fibonacci | 5 · 8 · 13 · 21 |
| Layout | the golden section | 38.2% / 61.8% |
| Gauges | 144 × 89 — consecutive Fibonacci, a true golden rectangle | |

√φ rather than φ for type because a full 1.618 jump between adjacent steps is too coarse
for interface text — it skips the sizes you actually need. Two √φ steps make one φ step,
so the major intervals still land on the ratio.

The 55px tap target and the 19.1px kiosk minimum are the same Fibonacci and √φ values
that govern everything else, and both clear the WCAG floor. The proportion system and the
accessibility floor agree — that is not luck, it is why 55 was chosen over 56.

---

## Matter — paper, light, placement

Three systems added after the reference art landed. `foundations/matter.html` renders all
of them side by side.

**Paper is four composable axes**, not one material: stock (`.pap--news`, `--onion`,
`--card`, `--kraft`, `--graph`, `--ruled`) × age (`.age-0` fresh → `.age-3` ancient) ×
soil (`.soil-1..3`) × damage (`.tear--*`, `.fold--*`, `.dogear`). Foxing only appears from
`.age-2` — a form filled in last week does not have mould on it. Named marks
(`.mark--blood`, `--sweat`, `--coffee`, `--oil`) are placed children rather than
background gradients, so they land where you put them. Old blood stays deliberately far
from `--locked` in hue and saturation: a stain must never be readable as a safety state.

**Light is a token, and shadows obey it.** Every shadow used to fall straight down with a
zero x-offset regardless of where the room's lamp was — the loudest single tell that a
"physical" surface is a stack of divs. A light now declares *where* it is
(`.light-at--tl/tr/tc/bl/l/r`, setting the direction a shadow travels) and *what* it is
(`.light--bulb/caged/pendant/gooseneck/banker/window/skylight/overcast/ambient`, setting
throw, softness and darkness). Objects declare their height off the surface
(`.lift-0`…`.lift-4`). A bare bulb close to the wall throws a long hard black shadow; an
overcast window throws a short soft grey one — same object, same `.lift-2`.

**Not every screen needs a visible fixture.** `.light--ambient` and `.light--overcast`
give a room believable soft light with no lamp drawn at all. Use them for dense working
screens, where a glowing lamp in the corner is just one more thing competing with data.

**Placement is one system, not two.** Rotation and overlap only work together: tilting
every card while keeping tidy lanes looks like a tilted grid, and overlapping while
axis-aligned looks like a z-index bug. `.desk` rotates children **deterministically**
(`nth-child`, never random — paper that wanders between reloads reads as breakage, not
craft), `.desk--stack`/`--pile` control overlap, `.overrun--*` lets a stamp hang off the
card it stamps, and `.desk--calm` opts out where alignment actually matters.

**The seal** (`.seal`) is the roundel that appears in all nine references and had no
component at all. Curved text via inline `<textPath>`, so it stays zero-asset.

**Discoverables** reward touching things: `.peek` lifts a sheet's corner to reveal what is
filed underneath (progressive disclosure that fits the world), `.gloves` swing, `.bell`
rings, `.tally` counts rounds the way a gym does. All keyboard-reachable via
`:focus-within` rather than hover-only, and all inert under `prefers-reduced-motion`.

---

## Motion & sound

`foundations/motion.html` renders both.

**Motion is Law 8 applied to time.** Durations were the one axis still picked by eye — `.12s`,
`.28s`, `.34s`, `.42s`, `.6s`, with no relationship to each other or to anything else in the
system. They are Fibonacci milliseconds now, the same series that governs space, so a drawer
opening and a 21px gutter descend from one source: `--m-instant` 55, `--m-quick` 89,
`--m-base` 144, `--m-settle` 233, `--m-travel` 377, `--m-swing` 610.

**Easings are named for the physics, not the curve.** Nothing in this building floats. A stamp
is driven down by a hand and stops dead against the paper (`--e-stamp`); a panel with mass
arrives under friction (`--e-settle`); a drawer drags on its runners (`--e-drawer`); a lever is
a mechanical linkage with a snap at the end (`--e-lever`); a hung sign swings past level before
it settles (`--e-swing`). `ease` describes none of that, which is why every skeuomorphic surface
that uses it feels like software. `--e-swing` is the only curve whose output passes 1 — reach for
it on things that hang and nothing else, because a stamp does not bounce off paper.

Every `transition` and `animation` in `ppbf.css` now runs through these tokens; none carries a
literal duration. The existing global `prefers-reduced-motion` rule kills all of it.

**Pending states.** The system could say *empty* and *done* but had no word for *in progress*, so
a submitted form looked identical to an ignored one — and the honest response to that is to press
the button again. `.btn[aria-busy="true"]` is driven from the ARIA attribute rather than a class,
so the accessibility tree and the pixels cannot disagree, and `pointer-events: none` is what
actually stops the double-submit. `.skeleton` is a blank ruled sheet — the paper system doing the
work, because a sheet with nothing written on it yet is what the physical world hands you while
you wait for a record. `.working` is the text cue: pair it with either, always. **A bare spinner
is colour-and-motion-only, which is exactly what Law 3 bans.**

**The focus ring.** `--focus` existed but only `.btn` and the inputs used it, so tabbing through a
room fell through to the browser default on tags, tiles, seals and every link — a thin blue halo
belonging to no room in this building. One `:focus-visible` rule now covers anything focusable.

**Sound is synthesized, and opt-in.** `ppbf-sound.js`. There is no `.mp3` or `.wav` in this
repository: five voices — `bell`, `stamp`, `latch`, `accept`, `refuse` — are built from
oscillators and filtered noise through the Web Audio API, because the zero-asset promise does not
get an exception for audio. The bell uses inharmonic partials (1 : 2.01 : 3.04 : 4.22 : 5.78),
which is what separates struck bronze from a sine beep.

It is a **classic script**, not an ES module, on purpose: browsers block `import` over `file://`,
and every other preview here opens by double-clicking it off disk, so a module would mean the
sound section silently vanished for anyone browsing the design system the normal way. It defines
one global, `window.PPBFSound`.

Five rules, stricter than the visual system's:

1. **Off by default.** Always opt-in.
2. **Never the only channel.** Law 3 does not stop applying because the channel is audio. Every
   sound accompanies a visible change; a user with the volume down, on a loud floor, or with a
   hearing impairment loses nothing. Sound is confirmation, never information.
3. **State changes only.** Never hover, never focus, never keystrokes — UI chrome that clicks is
   how a tool starts feeling like a toy, and this one holds medical clearances.
4. **The floor is loud.** A gym floor at session time drowns a tablet speaker, so floor kiosks
   should generally leave it off. Sound earns its place on quiet surfaces: office, clinic,
   after-hours kiosk.
5. **One at a time, and short.** Nothing runs past ~1.2s; an overlapping call is dropped rather
   than stacked.

---

## UX Patterns — the five

Five patterns that improve usability without breaking the gym aesthetic. All are zero-asset,
keyboard-accessible, and respect `prefers-reduced-motion`. See `foundations/patterns.html`.

**1. Persistent Alert Notifications** (`.alert`, `.alert--critical/warning/success/info`)
Critical alerts live on the page, not as dismissible toasts. Law 7 applied: refusal is a stamp,
not an error toast. Athletes see a locked status and it stays visible. Coaches see an incoming
lock and they address it before navigating away. Examples: clearance needed, lock engaged, system
offline, sync complete.

**2. Form Undo/Redo Levers** (`.btn--lever`, `.undo-redo-group`)
Undo and redo buttons styled as physical levers. Sit near form controls. Click to roll back
to the last saved state. Solves "oops I submitted the wrong RPE" without complex recovery flows.
Connected to form state; rolls back to the last saved checkpoint, not every keystroke.

**3. Empty State Guidance** (`.empty`, `.empty-glyph`, `.empty-title`, `.empty-msg`, `.empty-action`)
When a list or panel loads empty, show what's supposed to go there and what's needed to fill it.
"No pending reviews — all athletes cleared" beats a blank screen. Encourages exploration and
explains the flow. Every empty list should have an action button or next step.

**4. Command Reference Card** (`.commands`, `.commands-list`, `.commands-item`)
Keyboard shortcuts and command reference as a laminated card styled like a posted gym notice.
Lives in a corner or pops on `?` keypress. Discoverable without breaking the interface. Commands
are critical for coaches (approve/deny, lock/unlock) and admins (submit, undo, print, export).

**5. Print Parity** (`@media print` rules per room)
Every screen prints identically to how it renders on screen. A board governance record and a
family record are the same stamped sheet. Print this page: the room backgrounds, lamps, and
shadows disappear; the content reorganizes for paper; all data remains visible and legible.
Each room has specific print rules: office ledger becomes columnar, floor kiosk scales to card
stock, etc.

---

## Contents

### Foundations
- `foundations/motion.html` — Fibonacci durations, the five physical easings, pending states, the brass focus ring, synthesized sound
- `foundations/patterns.html` — persistent alerts, form undo, empty state guidance, command reference, print parity
- `foundations/matter.html` — the display voice and its supporting voices, paper conditions, light + shadow, placement, the seal, discoverables
- `foundations/rooms.html` — the six rooms, the wood/brick walls, lamps, ledger, nameplates
- `foundations/materials.html` — the panel materials plus brass hardware and the stamp pad
- `foundations/palette.html` — hide / brass / bone ramps and the status ladder
- `foundations/proportion.html` — the φ type ladder, Fibonacci space, golden splits

### Components
- `components/instruments.html` — brass gauges, workload buckets, capability tiles, badges
- `components/surfaces.html` — chalkboard schedule, cork board, tag nav, controls
- `components/forms.html` — checkboxes, PIN entry grid (kiosk-sized), signature line, contact-risk acknowledgment

### Screens
- `screens/athlete-kiosk.html` — gym-floor check-in: cleared and Layer 11 locked states
- `screens/coach-review-queue.html` — Layer 10 queue + Shadow (Layer 20) refusal panel
- `screens/board-workspace.html` — role binder rail, governance metrics, k-anonymity redaction
- `screens/capability-console.html` — admin grid (People / PIN Mgmt / Compliance / Volunteers / Scheduling / Reports / System), KPI plaque, ledger tape, compliance stamp
- `screens/guardian-portal.html` — warm ground, minor participant lookup, waiver renewal
- `screens/public-onboarding.html` — warm ground, enrollment intake form

### Not yet built
None — the design system is feature-complete. All 8 Laws, grit vocabulary, two-ground architecture, and all foundational + component + screen previews are built and verified.

---

## Type licensing

Nothing here costs anything. All five faces are **SIL OFL 1.1** and self-hosted from
`fonts/` — the floor kiosk has to render offline, and Law 6 means the type is part of the
chassis, not a progressive enhancement. There is no Google Fonts link and no CDN.

`--font-display` falls back to Impact / Haettenschweiler / Arial Narrow Bold if the woff2
fails to load — the closest heavy poster faces already present on Windows and macOS.
`--font-stencil` is a legacy alias pointing at the same token; the name is a leftover from
the earlier stencil law and is kept only so existing markup keeps working.

Swapping the display voice is one token in `ppbf.css`.

---

## Sync

This folder is the source. It pushes to the **PPBF Platform** design-system project on
claude.ai/design one component at a time — never as a wholesale replace. Edit here first.
