# Passbook v1 Build Prompt For VS

You are building the Passbook.

Do NOT redesign the visual system — a separate session owns it (see §2).
Do NOT invent new stamp codes — `STAMP_AND_LEDGER_SCHEMA.md` is canonical.
Do NOT force the governance surfaces into the metaphor (see §7).
Do NOT port page styling as part of this work.
Do NOT create a fifth design system.

Implement the doctrine below.

---

## 1. The doctrine

**The passbook is the organizing object of the platform, not a component in it.**

Today the platform is organized around the institution's questions — is this athlete
cleared, is this org compliant, what is in the queue. Every surface is a different
administrative view and the athlete is a row in someone else's table. That is why four
separate design passes all came out custodial: the information model is custodial, and
the visual language kept faithfully reporting it.

A fighter's record book is a real artifact in this sport. It is carried by the fighter,
stamped by commissions and medical officers, and it belongs to them. Give every athlete
one.

Then: **everything in the platform is either something that goes into a passbook, or a
view across passbooks.**

Same data. Same ledger. Same governance rigor. Opposite ownership.

Two consequences that are the entire point:

- `CLEARED` stamped in your own book is a fact about you. `CLEARED` in an admin table is
  a fact about your file. The stamp vocabulary does not change; what it *means to the
  person* does.
- A passbook with a gap in it is visibly a passbook with a gap. Nobody has to build a
  "who is slipping" report — the gap is the report, legible on the object. For a youth
  development nonprofit this is the only outcome that actually matters, and the current
  model is structurally blind to it: the platform can tell you exactly who showed up and
  nothing at all about who stopped.

### Prior art in this repo

This is not a new word here. `.passbook-card` is component 2.8 of nine in
`RETRO_DESIGN_SYSTEM.md`, and `apps/web/app/coach/environment/passbook-check/page.tsx`
exists at 48 lines. The idea was already reached for twice and filed as a component both
times. This prompt promotes it to the principle.

---

## 2. Division of labour — read before starting

A parallel session owns the **visual system**: `design-system/ppbf.css`, the token and
component reconciliation, and the page-by-page port. Do not do that work here.

**You own:** the information model, the routes, the data shape, the role surfaces, and
how a passbook is assembled and read.

**They own:** what it looks like. Materials, type, stamps-as-marks, the ports.

**Shared contract:** you name the objects, they render them. If you need a component that
does not exist in `ppbf.css` (a page spread, a shelf view, a gap indicator), specify what
it must express and leave the rendering to them. Do not hand-roll styling to fill a gap —
that is exactly how four design systems happened.

---

## 3. The design-system decision (already made)

`ppbf.css` keeps the **tokens and proportion**. `RETRO_DESIGN_SYSTEM.md` keeps the
**component vocabulary and floor ergonomics**. They were never really in conflict — they
are the same gym described twice, from different distances.

Treat `docs/FRONTEND_STYLE_CONTRACT.md` and `docs/BRAND_DESIGN_BRIEF.md` as historical.
Both describe palettes the app no longer ships.

---

## 4. What a passbook is

Define these precisely. This is the core deliverable.

**The book** — one per athlete, created at enrollment, never deleted. Carries identity,
not just records: name, wrap colour (§6), division, joined date.

**Pages** — a page is a kind of record. At minimum:

| Page | Contents | Written by |
|---|---|---|
| Attendance | Present / late / absent, streak, gaps | Coach, volunteer, kiosk |
| Rounds | Sparring rounds: opponent, stance, punch counts, duration | Coach |
| Clearance | Medical and waiver state, expiry dates | Med, admin |
| Gear | Pre-session equipment check | Coach, athlete |
| Corner | The coach's note on what this athlete is working on | Coach |
| Marks | Milestones, divisions reached, completions | Coach, admin |

**Stamps** — every state change on any page. Use the existing vocabulary in
`STAMP_AND_LEDGER_SCHEMA.md` verbatim. Every stamp writes a ledger event. No exceptions,
no new codes without a migration note.

**The shelf** — the collection. Coach sees tonight's stack. Admin sees all books. Board
sees what the shelf adds up to with names removed.

**The gap** — a first-class concept, not an absence of rows. Define what counts as a gap
(consecutive expected sessions missed), how it surfaces on the book, and what re-opens it.
This is the retention mechanism and it must be modelled, not inferred at render time.

---

## 5. Role surfaces derive from the object

One metaphor, six surfaces, same object at different distances. The role density matrix in
`USABILITY_SPEC_RETRO.md` §A6 falls straight out of this — do not re-derive it.

| Role | Surface | Distance |
|---|---|---|
| Athlete | Your book | One book, open |
| Guardian | Your athlete's book, from the corner | One book, read-only, warm ground |
| Coach | Tonight's stack, sorted by who needs you | Many books, triage |
| Admin | The shelf | All books, operations |
| Board | What the shelf adds up to | Aggregate only, zero individual PII |
| Research / SHADOW | Reading across books under k-anonymity | Aggregate, withheld below threshold |

Note the last row: the stamp that withholds a too-small cohort is literally the same stamp
that would go in a book. That is the metaphor holding, not a coincidence — do not build a
separate refusal mechanism for research surfaces.

---

## 6. Features that hang off the object

Everything below is either a page, a stamp, or a view. None of it is a standalone feature.

**Already specced in this repo — build to the existing spec, do not redesign:**

1. Live round timer with thumb-tap punch counters — `FLOOR_FLOWS_SPARRING_ATTENDANCE.md` §1.
   Note the current `/athlete/dashboard/sparring` page is a **form** (seven inputs, an
   `onSubmit`, no timer). `START_ROUND` appears in zero files. The live flow was never built.
2. Stance plates — Orthodox / Southpaw. Partially shipped already.
3. Brass scoreboard — persistent, top of every authenticated page, mobile included.
4. Ledger tape — append-only, perforated, never editable after write.
5. Mechanical lock PIN — 56px keys.
6. "Who is here" — parent-facing floor view.
7. Fight-card strip as breadcrumb.
8. Floor ergonomics — press-and-hold for destructive, offline-first with original
   `occurredAt` preserved, ≤20s round entry, ≤3s attendance mark.

**New — no prior spec exists:**

9. **Streak** — sessions in a row. Punched-card model, not a counter.
10. **The gap** — see §4. The retention mechanism.
11. **Tale of the tape** — comparison view. You vs you six months ago; sparring matchmaking.
12. **Marks / belt plates** — milestones and completions as objects in the book.
13. **Divisions** — named tiers an athlete is proud of, not numeric brackets.
14. **Next-action status ladder** — every rung names what to do, not just the state.
    "See your corner — waiver expired," never "Locked." The stamp *code* stays; the
    athlete-facing *label* gains an action.
15. **Corner, not stamp** — person-facing refusals read like a cornerman leaning in. Stamps
    stay for the record. This splits Law 7 by audience; it does not weaken it.
16. **Gear check** — compliance reframed as the pre-session ritual it actually is.
17. **Corner note** — coach to athlete, weekly, distinct from the coach's ledger note.
18. **Wrap colour** — per-athlete identity accent, drawn from hand wraps. Structurally
    separate from brass (Law 1) and from the status ladder (Law 2), so it can be warm and
    personal without costing either.
19. **Day one** — a new book is not an empty state. It is a blank book with your name
    stamped in it and today's date. `USABILITY_SPEC_RETRO.md` already forbids cute
    illustrations here; this makes it the front door rather than a fallback.
20. **Check-in as one gesture** — PIN → your book opens → name, streak, tonight's work →
    stamp → bell. Not five features. One.

---

## 7. Hard constraints

1. **Governance surfaces stay institutional.** Board, audit and compliance genuinely *are*
   views of the institution. Forcing them into the passbook metaphor makes it twee. The
   shelf is allowed to be a shelf.
2. **The stamp vocabulary is closed.** `STAMP_AND_LEDGER_SCHEMA.md` §1 is canonical. New
   codes require a design-system update and a migration note.
3. **Every stamp writes a ledger event.** Including offline ones, with original `occurredAt`.
4. **Athlete surfaces cap at 3–4 actions** — `USABILITY_SPEC_RETRO.md` §A6.
5. **Board sees zero individual PII.** Aggregate only, always.
6. **Colour is never the only channel.** Every state carries a glyph and an uppercase label.
   This extends to any audio you add — sound is an additional channel, never the only one.
7. **Migrations are operator-run only.** No HTTP route changes schema; no push, merge or
   deploy applies a migration as a side effect. See `MASTER_INDEX.md`.

---

## 8. Known defects to fix in passing

Verified against the current tree, not inherited from docs:

- `--status-danger` and `--status-info` are referenced by
  `apps/web/components/uiStyles.ts` and defined in neither `ppbf.css` nor `globals.css`.
  Anything using them renders white text on a transparent background. Currently latent —
  the five affected exports are unused. Independently flagged in `BRAND_DESIGN_BRIEF.md` §8
  and never fixed.
- `.btn--ghost` is not covered by the `.on-canvas` block in `ppbf.css`. On the warm ground
  it renders grey on grey. No route uses canvas ground yet, which is why it survived.
  Must land before any family-facing form is ported.
- `.stamp` is defined in both `ppbf.css` (static ink mark) and `globals.css` (clickable
  button). `globals.css` wins on import order. Both are correct in their own system — pick
  one and rename the other.
- `apps/web/src/design/PAGE_MAP.md` claims 61 routes; there are 63. It lists `board/[member]`,
  which does not exist — the consolidation shipped as `BoardSeatWorkspace` plus nine
  five-line route files. It is missing `admin/board-seats`, `notices` and `workspace`.

---

## 9. What "done" means for v1

- [ ] Passbook, page, stamp, shelf and gap are defined as real types, not view models.
- [ ] Every existing stamp code maps onto a page. No orphans, no new codes.
- [ ] The six role surfaces derive from the object, with the density matrix respected.
- [ ] Gap detection is modelled and testable, with a coach-facing surface that answers
      "who has stopped coming" without anyone running a report.
- [ ] Check-in is one gesture end to end, offline-capable, ledger-backed.
- [ ] Day one renders as a named blank book, not an empty state.
- [ ] The four defects in §8 are closed.
- [ ] No new styling was hand-rolled — anything visual was specified and handed off.

---

## 10. Reading order

1. `docs/STAMP_AND_LEDGER_SCHEMA.md` — the data model you build on
2. `docs/FLOOR_FLOWS_SPARRING_ATTENDANCE.md` — the two highest-frequency flows, specced
3. `docs/USABILITY_SPEC_RETRO.md` — density matrix, floor constraints, acceptance tests
4. `docs/RETRO_DESIGN_SYSTEM.md` — component vocabulary
5. `design-system/README.md` — the eight laws and the token system
6. `apps/web/src/design/PAGE_MAP.md` — current route inventory (stale, see §8)

**v1 complete when:** an athlete can open their own book at the kiosk, a coach can see who
has stopped coming without running a report, and every stamp in both flows lands on a page
of a book that belongs to the athlete rather than a row in a table that belongs to the gym.
