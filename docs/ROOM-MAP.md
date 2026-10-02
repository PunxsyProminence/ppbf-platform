# THE ROOM MAP

**This is the one list of planned rooms** (OD-2026-09-28-009): other visual work
lists are history. It is a plan, not a limit: what is built, in what order and how
it looks is decided by Jason with the lane doing the work (OD-2026-10-01-003
section 2, OD-2026-10-02-004). The look today is described in
`docs/GOLDEN-ERA-V1-CONTRACT.md`; what a training-room plate must show is
`docs/REAL-GYM-REFERENCE-LOCK.md`.

**Status:** shape agreed 2026-09-26, open to change · Owner: Jason Neale · Drafted by Claude 2026-09-26
**Not yet built.** `apps/web/components/buildingMap.ts` is still the live
structure; this is the shape it is being moved to, one room at a time.

Owner decisions, 2026-09-26, on the three questions this document closed with:
1. Operations gets its own room.
2. The Workshop: "do what makes sense but doesn't clash."
3. The room count stands "as long as they make sense and flow well".

---

## Why a split at all

The building map files 125 doors under seven `room` values (counted in
`apps/web/components/buildingMap.ts` at `bbf299fe`); the table shows the Drill
Cabinet, which has its own scope (`.ge-drillcase`) but is filed under `floor`,
as an eighth. Two of those rooms are not rooms:

| Room | Doors |
|---|---|
| Front Office | **49** |
| Gym Floor | **39** |
| Board Room | 13 |
| Clinic | 10 |
| File Room | 7 |
| Teach Shadow | 3 |
| After Hours | 3 |
| Drill Cabinet | 1 |

Owner ruling, 2026-09-26: every screen should read as another room of the gym,
you should know which one you are in from the layout and visuals alone, and the
tabs inside a room are the different equipment standing in it.

Forty-nine doors cannot be equipment in one room. The Front Office is not a room,
it is four audiences sharing a label: the people who run the front desk, the
parents, the people who run the money, and the people who maintain the software.
A parent has no business standing in the same room as PIN Management and Grant
Obligations. The Gym Floor is three activities under one name: doing the work,
filming the work, and deciding about the work.

Splitting them is the prerequisite for the rooms being rooms.

---

## The building, as a path through it

### The way in
**The Bell** — `/login`, `/dashboard`.
Arrival. Already its own scope (`.ge-bell`) with its own plate.

### The public side — the street and the front of house

**FRONT DESK** — who is here, who is cleared, who is allowed in
People · Door Register · PIN Management · Activation Codes · Attendance ·
Volunteers · Coach Coverage · Staff Credentials · Certified & Cleared ·
Your Corner · Print

**THE FAMILY ROOM** — the parent's own room, and only the parent's
Guardian Portal · Parent Hub · Photo & Video Consent · Safety Status ·
Progress Visibility · Development Plan

> This is the split that matters most. These six surfaces already refuse another
> room's wall: `RoleStandaloneView` drops the room on its canvas branch, and T7
> in the plate inventory says a family or signed-out surface takes the warm
> ground or none. The map has been calling that an exception. It is a room.

**THE WINDOW** — outward facing, open to anyone
Public Page · Help · Equipment Store

### The training side — where the work happens

**THE FLOOR** — today
The Wall · Wall of Names · Schedule · Athlete Workspace · Sparring ·
Intake Router · Session Scripts · Workout Templates · Standards · 1% Club ·
Chalkboard

**DRILL CABINET** — the drills *(built)*
Drill Library · Cue Library

**THE FILM ROOM** — footage
Video Analysis · Record for Film Study · Video Publications · My Video ·
Guided Visualization

**THE LOCKER** — the athlete's own corner
My Progression · My Development Plan · My Video

### The working side — where coaches think

**COACH'S OFFICE** — decisions
Review Queue · Decision Loop · Recognition · Coach Cards · The Morning Read ·
Attempt Log · Athlete Intelligence · Progression Intelligence ·
Performance Analytics · Intervention Protocols · The Work · What We Learned

**THE BOOK** — records and eligibility
Passbook Gaps · USA Boxing Eligibility Check · Transfer Check · My Credentials ·
Development Blocks · Your Development · Cohorts

### The quiet side — where the gym answers for itself

**CLINIC** (10) — clearance, safety, consent
**FILE ROOM** (7) — evidence, research, audit
**BOARD ROOM** (13) — governance, the nine seats
**TEACH SHADOW** (3) — teaching the recogniser
**AFTER HOURS** (3) — SHADOW

### The away side — the gym against other gyms

**OPERATIONS** — competing outside this building
Operations Hub · External Competition · Wrestling League

> Its own room by owner decision, 2026-09-26. These three never fitted the Front
> Office or the Floor because they are not about this building at all: they are
> about fixtures, leagues and the bodies that sanction them. Filed anywhere else
> they read as paperwork; filed together they read as what they are.

### Behind the scenes — not the gym, the machinery

**BACK OFFICE** — money and organisation
Grant Obligations · Payment Accounts · Program Memberships · Organizations ·
Customize the Gym · Public Interest · Data Quality · Floor Hours Ledger ·
Community Service · Waivers & Consent · Notices

**THE WORKSHOP** — the software itself
Capability Console · Platform · Source Control · Publication Workflow ·
SHADOW Human Review · Video Scan Review · Calibration Adjudication ·
Calibration Review · Portrait Review · Retro Lab

> **Decided 2026-09-26: "do what makes sense but doesn't clash."** So the
> Workshop keeps the building's materials and drops its subject. Same timber,
> same plank, same chalk, same practical fluorescent light — but the back room
> of the place rather than the training floor: a workbench under a bare bulb,
> pegboard, tools on hooks, parts in labelled tins. No ring, no bags, no mats.
> It reads as the same building without pretending to be the gym, which is the
> distinction the decision asks for.

---

## The flow, in one line

You arrive at the Bell, pass the Front Desk, and go either onto the Floor to
train or into the Coach's Office to decide. The Cabinet and the Film Room open
off the Floor. The Book sits between the Floor and the quiet side. Parents never
leave the Family Room. Nobody but staff reaches the Workshop.

---

## What this costs

**Eight rooms become about seventeen, so seventeen plates.** Each room needs its
own backdrop derived from the gym (`scripts/make-plate.mjs`), and its own set of
stations. That is the real bill, and it is worth knowing before the look is
committed to.

## The blocker, and the way through it

**The door's `room` field is coupled to the retired CSS vocabulary.**
Until 2026-10-02 `buildingMapRooms.test.ts` compared each door's room against the
`room--*` class its page paints and flagged disagreement as drift — correctly:
fourteen routes had drifted silently when that guard was written. It was removed
(OD-2026-10-02-004), so nothing compares them now.

Re-filing a door from `office` to `frontdesk` used to turn the guard red unless
the page was repainted, and repainting spreads a vocabulary that
`legacyVisualVocabulary.test.ts` capped (also removed 2026-10-02) and that the
owner has ruled should be deleted rather than carried ("delete what retirement
was supposed to cancel if we have rewrite its ok", 2026-09-26).

**The sweep cannot be one mechanical pass, and that was my first mistake here.**
Board and File are LIGHT rooms: their `room--*` class switches the page to dark
ink. Strip it in bulk and the ink stays dark against bare `.room`'s wood-800
ground — dark on dark, which is the readability trap `roleGround.ts` names and
`app/parent/safety/page.tsx` documents. The plate inventory says the same thing
in its own words.

**So it goes room by room, with the building.** When a room is built, its `.ge-*`
scope takes over what its `room--*` class was doing, its doors are re-filed, and
only then does the class come off its pages. One room's worth of drift at a time,
each closed before the next opens, instead of 88 files red at once.

**The way through is to finish the retirement, room by room.** Delete `room--*`
from a room's pages as that room gains its scope;
there is then no second answer to disagree with the door. `room` in `buildingMap.ts` becomes what the 2026-08-23 decision
already said it was — structural metadata for the corridor and the catalog — and
each room's LOOK comes from its `.ge-*` scope and its plate, which is the live
visual system.

Across all the rooms that is 143 `room--*` occurrences in 88 files (the ceiling
`legacyVisualVocabulary.test.ts` held until 2026-10-02; still 143 in 88 at
`bbf299fe`), removed room by room until none are left. It is the change that
makes a seventeen-room building possible at all.

## Build order

The Bell and the Drill Cabinet already exist. The rest follow the path through
the building, because a room is easier to judge next to the room you reach it
from:

1. **The Floor** — the largest room a coach stands in, and its plates exist
   (`plate-10` and `plate-11`, committed but not yet declared; today the floor
   paints no plate — `apps/web/public/plates/README.md`).
2. **Front Desk** — the room everyone passes through.
3. **The Family Room** — already behaves as a room; the map catches up.
4. **Coach's Office**, then **The Book**.
5. **Film Room**, **The Locker**.
6. The quiet side: **Clinic**, **File Room**, **Board Room**.
7. **Operations**, **Back Office**, **The Workshop**, **The Window**.

Each room is: a plate, a `.ge-*` scope, its stations, its doors re-filed, and its
`room--*` classes removed. Closed before the next one opens.
