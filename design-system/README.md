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
image assets at all. The six type faces are the one exception to "no files": they are
real `.woff2` files, but self-hosted from `fonts/` rather than pulled from a CDN, and
they total 200 KB. The constraint that actually matters is unchanged — the kiosk renders
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

All six are **self-hosted, SIL OFL 1.1, and free** — 200 KB total, latin subset only, no
CDN (see `fonts.css`). The display voice is **wood type, not stencil**: the reference art
is a jobbing printshop — heavy slab and heavy grotesque, letterpress-printed, ink broken
up at the edges. Stencil letterforms carry bridges through the strokes and not one
reference header has them. `--font-stencil` survives as an alias so older markup keeps
working. Three candidates ship (`.voice-a` Alfa Slab One, `.voice-b` Archivo Black,
`.voice-c` Oswald 700) — pick one, delete the rest, fold it into `--font-display`.

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

## Contents

### Foundations
- `foundations/matter.html` — type voices to choose from, paper conditions, light + shadow, placement, the seal, discoverables
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

`--font-stencil` falls back to Impact / Haettenschweiler / Arial Narrow Bold — the closest
condensed poster faces already present on Windows and macOS. The intended faces are
**Big Shoulders Stencil** or **Stardos Stencil**. Self-host the files rather than linking
Google Fonts: the floor kiosk has to render offline, and Law 6 means the type is part of
the chassis, not a progressive enhancement.

Swapping is one token in `ppbf.css`.

---

## Sync

This folder is the source. It pushes to the **PPBF Platform** design-system project on
claude.ai/design one component at a time — never as a wholesale replace. Edit here first.
