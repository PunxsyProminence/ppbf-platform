# The Weigh-In — proposed design laws

**Status: PROPOSAL. Not adopted. Not wired into `design-system/ppbf.css`.**

The shipped system is still ["Leather & Brass" and its Eight Laws](../design-system/README.md).
This supersedes the earlier Kit Cage draft, which solved the wrong problem.

---

## The diagnosis

Repealing four laws didn't stop the system pigeonholing the visuals, because the problem
was never *which* laws — it was what **kind** of law they all were.

Every restrictive law in both prior sets is an **inventory law**. It governs by listing
what is allowed:

| Law | The inventory |
|---|---|
| Old 6 | five materials, and nothing else ships |
| Old 2 | saturated colour reserved to safety |
| Old 1 | brass permitted exactly zero meanings |
| Kit Cage 1 | twenty-one hooks on the cage sheet |
| Kit Cage 2 | six enumerated brass placements |
| Kit Cage 4 | two paint slots, eight saturated elements |
| Kit Cage 3 | a ruling must be border + hatch + glyph + label |

An inventory law caps the system at the imagination of whoever wrote the list. Every new
idea needs an amendment, and the amendment is a negotiation. That is the pigeonhole — and
it explains why repealing four laws changed nothing: the Kit Cage simply wrote new
inventories in boxing vocabulary.

**A property law governs by what the result must achieve, not by what it must be.**
Infinitely many designs satisfy *"the meaning survives greyscale."* Exactly five satisfy
*"is leather, brass, slate, cork, or paper."* Both are rigorous. Only one is open.

So: nothing here is a list of permitted things. Every law below is a test. Anything that
passes, ships — including things nobody has thought of yet.

Hence the name. In a gym, you don't get a list of who may compete. **You make weight.**

---

## The laws

### 1. Most of the screen is free

Every element is either **load-bearing** — it encodes a decision, status, identity, safety
state, or record — or it is **free**.

Free elements answer to Law 8 alone. Invent there without asking: texture, depth, grain,
ornament, atmosphere, illustration, period detail, motion, wear, grit, whatever the room
needs.

This is the law that does the liberating, so it is first. The prior sets had no such
split, which meant the strictness required by a safety lock leaked onto every pixel on the
page — including pixels that mean nothing at all.

> If you find yourself asking permission to make something look better, first check
> whether it carries meaning. Usually it doesn't, and the answer is yes.

### 2. Load-bearing meaning survives a photocopier

Anything load-bearing states itself in **at least two channels, at least one of which is
not hue.** Shape, glyph, label, position, border, weight, size, texture, hatch, enclosure —
any two qualify. There is no required template and no mandated combination.

The test is literal, and it is the whole law: print it greyscale, and show it to someone
with deuteranopia. If the meaning survives both, it ships.

This is what lets red mean *red corner* in one place and *locked* in another. The second
channel is doing the work, so the hue is free to be reused.

### 3. Colour is free — colour-as-*meaning* is declared

Any hue may appear anywhere for atmosphere, mood, or period. There is no saturation budget
on decoration.

A hue that **carries** meaning is declared in its room's meaning set and holds that meaning
for the whole room. One relational constraint keeps signal from drowning: **a meaning-hue
must be the most saturated thing near it.** That protects the signal without capping how
much colour the room may use — a busy, saturated room simply has to make its signals
correspondingly stronger.

Rooms derive from route or media query, never from a control the user flips. One look is a
product decision, not a preference.

### 4. The floor is 55px and 19.1px. Everywhere else is yours

Gym-floor surfaces: 55px targets, 19.1px type, 21px between targets, legible at arm's
length, no hover-only affordances. Desks, boards, and reading surfaces are unconstrained
and may go as small as legibility allows.

**Bind the minimum to the surface, not to the control.** Opt-in tap sizing regresses by
omission — that is not hypothetical, it is exactly how the kiosk's locked state shipped its
only working control at 44px ([PR #151](https://github.com/PunxsyProminence/ppbf-platform/pull/151)).

### 5. Invent freely; mean consistently

New materials, objects, gear, surfaces — all welcome, no amendment required. Duck canvas,
foam, galvanized steel, a heavy bag, a spit bucket, a corner stool, tape, a scale: take
them. Take things no one has listed.

The only requirement is downstream: **once a thing means something, it means that
everywhere.** Invention is unlimited; semantic drift is not. A voice is a meaning too —
mono stays the record hand, and the four voices keep their jobs.

This replaces both the five-material list and the twenty-one-hook sheet. Consistency was
the part worth keeping; enumeration was not.

### 6. φ is the default, not the cage

Reach for the ladder first — it exists so proportion doesn't have to be re-decided every
time. When a design genuinely needs a value that isn't on it, take the value and leave a
comment saying why.

An undocumented off-ladder number is a bug. A documented one is a decision. The prior
wording — *"nothing is sized by eye"* — made every deliberate exception a violation, so
exceptions got smuggled in unlabelled instead. There are currently ~38 of them across the
previews and 9 in `ppbf.css`, which is what a law nobody can comply with produces.

### 7. Refusals leave a trace, and we rank gear, not children

Notifications may ring, animate, and be dismissed. But **every governance refusal
additionally writes a permanent, attributable row to the record** — dismissing the
notification never dismisses the fact.

Wear, belts, prestige, streaks, and brackets apply to equipment, sessions, cohorts, and
adults. A minor sees only their own prior state. When a gate withholds, **render the
gate** — silence looks identical to no data.

This law is not aesthetic and does not bend for a look.

### 8. It ships from the box

CSS, SVG, and self-hosted type. No external assets, no network dependency. This is the one
law that binds free elements too, because the kiosk has to render cold on a tablet with no
signal, and grant packets have to print identically anywhere.

---

## What this unblocks

Everything the repeals were meant to free, without a new inventory to amend:

| Previously blocked by | Now |
|---|---|
| Old 6 — five materials | any material or object, no list (Law 5) |
| Old 2 — colour is safety-only | red/blue corner, trend arrows, rank colour, heat maps (Law 3) |
| Old 1 — brass carries no meaning | brass rank badges, condition ratings, value-bearing gauges (Laws 2, 5) |
| Old 7 — refusal is stamp-only | full notification system, refusals still permanent (Law 7) |
| Kit Cage 1 — 21 hooks | invent the twenty-second object without asking (Law 5) |
| Kit Cage 3 — fixed ruling template | any two non-hue channels (Law 2) |
| Kit Cage 4 — 8 saturated elements | unlimited decoration; signals stay strongest (Law 3) |

## What is still hard

All eight non-negotiables survive, none as an inventory:

| Non-negotiable | Now carried by |
|---|---|
| Greyscale survivability | Law 2 |
| Colour-blind survivability | Law 2 |
| 55px / 19.1px floor sizing | Law 4 |
| Golden-ratio proportion | Law 6 (default + documented escape) |
| Typographic division of labour | Law 5 |
| Child safety / k-anonymity | Law 7 |
| Zero external assets, offline | Law 8 |
| One look, no toggles | Law 3 |

---

## Provenance and open risks

The Kit Cage draft this replaces came from a multi-agent workflow that **failed at 30
minutes**. 8 of 15 agents finished — three spines and a judge ran; the five facet
specifications, their adversarial audits, and synthesis never did. The script, journal,
and transcripts were not persisted and are unrecoverable.

**This rewrite has had no audit at all.** Two clauses deserve attack first:

1. **Law 6 is deliberately weaker than its predecessor.** Trading "nothing by eye" for
   "document your exceptions" buys freedom by trusting the comment. If exceptions stop
   getting documented, proportion drifts silently and the law is worthless. Worth a lint
   rule rather than good intentions.
2. **Law 3's relational constraint is untested.** *"A meaning-hue must be the most
   saturated thing near it"* is a judgment call, not a measurement — "near" is undefined
   and no tooling checks it. It replaced a hard count (eight saturated elements) precisely
   because the count was a pigeonhole, but the trade is enforceability for freedom.

Law 2 is the load-bearing one and it is the strongest thing here: it is a literal,
reproducible test that anyone can run with a black-and-white printer.

---

## Related

- Shipped system and current Eight Laws — [`design-system/README.md`](../design-system/README.md)
- Token source of truth — [`design-system/ppbf.css`](../design-system/ppbf.css)
- [`RETRO_DESIGN_SYSTEM.md`](RETRO_DESIGN_SYSTEM.md)
