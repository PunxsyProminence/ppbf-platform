# The Kit Cage — proposed successor to the Eight Laws

**Status: PROPOSAL. Not adopted. Not wired into `design-system/ppbf.css`.**

This document exists so a decision that was reached does not get lost. It is *not* a
description of what the platform currently does. The shipped system is still
["Leather & Brass" and its Eight Laws](../design-system/README.md).

---

## Provenance — read this before trusting anything below

This came out of a multi-agent design workflow that **failed before completing**.

| Phase | Ran? | Result |
|---|---|---|
| 3 competing spine proposals | yes | 3 returned |
| Judge — pick a spine, re-check the non-negotiables | yes | picked "The Kit Cage" |
| 5 deep facet specifications | **no** | never completed |
| 5 adversarial audits of those facets | **no** | never ran |
| Synthesis | **no** | never ran |

8 of 15 agents finished. The workflow's script, journal, and agent transcripts were
**not persisted** and are unrecoverable — this document is reconstructed from what was
read out of the journal before the run died.

**What that means practically:** the spine and the law set below passed a judge but were
never adversarially audited. Treat every clause as a first draft. In particular, Law 3
carries a burden nothing has stress-tested yet (see *Known open risk*).

---

## What was repealed, and why

The user repealed **Laws 1, 2, 6, and 7** of the shipped set. Those four were the ones
blocking a boxing-native vocabulary:

| Repealed | What it blocked |
|---|---|
| **7** — refusal is a stamp, not a toast | the entire notification system |
| **2** — saturated colour means safety only | red vs. blue corner, trend arrows, rank colour, injury heat maps |
| **6** — only five materials ship | gloves, headgear, rope, tape, heavy bag, bottle, jump rope, ring canvas as real surfaces |
| **1** — brass never carries meaning | brass rank badges, glove-condition ratings, value-bearing gauges |

Laws 3, 4, 5 and 8 were kept — none of them blocked anything. 3 and 5 are pure
accessibility, 8 is the golden-ratio premise, 4 already had a handwriting voice.

**The cost of repealing 7, stated plainly:** Law 7 was not an aesthetic rule. It was what
made a k-anonymity redaction or a gate-matrix lock impossible to swipe away on a platform
serving minors. Repealing it frees the notification system, but it also means a coach can
dismiss `REDACTED` and keep going. New Law 8 below is the attempt to keep the protection
while dropping the stamp-only constraint.

---

## The eight non-negotiables

Any successor law set has to cover all eight. It may reword, merge, split, or renumber
them freely — but it may not drop one.

1. Greyscale survivability — board packets print black-and-white
2. Colour-blind survivability
3. 55px / 19.1px gym-floor touch sizing
4. Golden-ratio proportion — φ type ladder, Fibonacci space, 38.2/61.8 section
5. Typographic division of labour
6. Child-safety and k-anonymity posture
7. Zero external assets, offline kiosk render
8. One look, no toggles

---

## The spine

The winning move is splitting what old Law 6 had fused together. Old Law 6 closed the
**material** list — which is exactly why gloves could not ship. The Kit Cage closes the
**object** list instead and leaves materials open.

- **STOCK** — what things are made of. Thirteen bins, ten filled: hide, brass, patina,
  slate, cork, paper, duck canvas, linen, galvanized steel, foam. Three left deliberately
  empty so a future object doesn't force a rename.
- **KIT** — a numbered cage sheet of twenty-one hooks. Nothing off the sheet ships.
  Canvas, ropes, post/turnbuckle, stool, slate, glove, wrap, bag, headgear, tape, bottle,
  jump rope, locker plate, scale, and the remainder reserved.

So gloves, headgear, rope, tape, bag and ring canvas all become first-class surfaces,
while it stays impossible to invent a twenty-second object on a deadline. That is the
anti-pastiche function of old Law 6, preserved without the part that was blocking.

### The nine layers

| Layer | Owns |
|---|---|
| **MEASURE** | every number; the only layer permitted to author a raw `px` |
| **STOCK** | materials |
| **KIT** | the twenty-one-hook object vocabulary |
| **FIT** | wear: fresh → worn → taped → split → retired (rest defaults to `worn` — it's a used gym) |
| **MARK** | meaning that survives without hue |
| **ROOM** | everything route-derived |
| **VOICE** | type |
| **BELL** | transient time |
| **RECORD** | permanence and print — **forbidden from reading any `--room-*` token**, so a compliance row cannot render six different ways |

---

## The nine laws

**1. Ship only what's on the cage sheet.** Twenty-one hooks, built from CSS, SVG, and
self-hosted type alone. No external assets, ever.

**2. Structural brass is patina.** Polished brass appears only in six enumerated
value-bearing places. Unmarked hardware means nothing, ever.

**3. Rulings and signals never mix.** A *ruling* gets a border, a hatch, a reserved glyph,
and an uppercase label. A *signal* gets a flat unbordered fill, a mono code printed
inside it, and a fixed position. Never blend the two families.

**4. Two paint slots per room.** Maximum eight saturated elements in the first viewport.
Mode derives from route or media query — never from a control the user can flip.

**5. The floor room is 55px and 19.1px,** with 21px between targets, legible at arm's
length, and no hover-only affordances.

**6. Every dimension and duration descends from φ and Fibonacci.** Nothing sized by eye.

**7. Four voices, one job each** — and every ruling label and signal code sets in mono.

**8. Ordinary feedback rings and can be dismissed.** Every governance refusal
*additionally* writes a permanent, attributable row to the record.

**9. Rank gear, not children.** Wear, belts, prestige, streaks and brackets apply to
equipment, sessions, cohorts, and adults. A minor sees only their own prior state. And
when a gate withholds, **render the gate** — silence looks identical to no data.

---

## Known open risk

Repealing old Law 2 means red can legitimately mean both "red corner" and "locked." On a
printed board packet with hue stripped out, the glyph and the uppercase label become the
only thing separating a corner assignment from a safety lock.

That entire burden lands on **Law 3**. Its border-present/border-absent split is the most
photocopier-robust discriminator available, which is why it was chosen — but it was never
audited, and the audit phase that would have attacked it is exactly the phase that never
ran. **This is the first thing to test if the proposal is taken further.**

---

## Related

- Shipped system and the current Eight Laws — [`design-system/README.md`](../design-system/README.md)
- Token source of truth — [`design-system/ppbf.css`](../design-system/ppbf.css)
- [`RETRO_DESIGN_SYSTEM.md`](RETRO_DESIGN_SYSTEM.md)
