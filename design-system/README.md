# PPBF Design System — "Leather & Brass"

Visual foundation for the PPBF Platform.

**Source of truth:** [ppbf.css](ppbf.css) — tokens, materials, and components in one
sheet. Every preview in this folder consumes it.

---

## The direction

The platform looks like the back office of a boxing gym that has been run properly for
forty years. Oiled leather, cast brass, a slate board with today's sessions on it, a cork
wall of pinned notes, and a stamp pad for anything official.

That is not decoration. It solves a real problem: PPBF serves one spectrum with two very
different halves — a nine-year-old checking in at a floor tablet, and an AF_SPECOPS
candidate reading a load profile. Guardians renewing waivers. Grant officers reading
impact. Abstract flat UI gives all of them the same undifferentiated grey. Physical
objects give each surface an obvious identity and an obvious weight: a chalkboard is
today and it gets erased, a stamped paper is a decision and it does not.

Zero external assets. All texture is generated from SVG `feTurbulence` data URIs and
layered gradients, so the kiosk renders on a cold tablet with no network and grant packets
print identically anywhere.

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

**4. Four voices, each with a job.**
- **Stencil** commands — headers, mottos, tile names, buttons. It gives orders.
- **Bone sans** informs — body copy, forms, anything read at length.
- **Chalk** schedules — the day's sessions. Erasable by definition.
- **Mono** records — IDs, timestamps, RPE, ledger hashes. Anything auditable.

**5. Kiosk-first sizing.**
Anything an athlete touches on the gym floor is at least `--tap` (55px) with `--t-md`
(19.1px) type. Sweaty hands, bad light, a queue behind them. Desks may go smaller; the
floor may not.

**6. Every panel is a real object.**
Leather, brass, slate, cork, paper. If a surface isn't one of those five materials, it
doesn't ship. This is the rule that keeps skeuomorphism from sliding into pastiche —
there is a fixed vocabulary and nothing gets invented per-screen.

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

## Contents

### Foundations
- `foundations/materials.html` — the five materials plus brass hardware and the stamp pad
- `foundations/palette.html` — hide / brass / bone ramps and the status ladder
- `foundations/proportion.html` — the φ type ladder, Fibonacci space, golden splits

### Components
- `components/instruments.html` — brass gauges, workload buckets, capability tiles, badges
- `components/surfaces.html` — chalkboard schedule, cork board, tag nav, controls

### Screens
- `screens/athlete-kiosk.html` — gym-floor check-in: cleared and Layer 11 locked states
- `screens/coach-review-queue.html` — Layer 10 queue + Shadow (Layer 20) refusal panel
- `screens/board-workspace.html` — role binder rail, governance metrics, k-anonymity redaction

### Not yet built
- `components/forms.html` — dedicated forms sheet (waivers, consent, PIN entry) — the input
  and select styles exist in `components/instruments.html`, but multi-field flows don't
- `screens/capability-console.html` — the admin grid (People / PIN Mgmt / Compliance / Volunteers
  / Scheduling / Reports / System) — the capability tile itself is done in `instruments.html`,
  this is composition into a full screen
- `screens/guardian-portal.html` — warm ground (`--canvas-warm`), consent renewal, minor lookup
- `screens/public-onboarding.html` — warm ground, enrollment intake
- A guardian/public component pass — every component built so far (badges, tiles, buttons,
  gauges) has only been proven on the ink ground. The warm canvas-ground variants (Law 6,
  "two grounds") are unverified — colours and shadows tuned for leather need re-checking
  against `--canvas-warm`.

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
