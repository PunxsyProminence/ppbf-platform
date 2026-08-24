# Grok ready queue — what is buildable now

**Against `main` @ `27711faa`, 2026-08-23.** Companion to
`docs/GROK-APP-BUILD-MAP.md`, which is the evidence behind every row.
`docs/GROK-VISUAL-LANE.md` is still the contract and outranks both.

A surface is **READY** only if all five hold:

1. It is real — it reads real data, or it is honestly static. Not a prototype
   showing invented records.
2. Its functional boundaries are written down, so a visual pass can be reviewed
   against something.
3. No owner decision blocks it.
4. No open PR owns the same files.
5. Its tests are known, so you can tell what you may update from what you may
   not weaken.

Anything not on this list is either **BLOCKED** or **OFF LIMITS** below. Those
sections are the more important half of this document.

---

## IN FLIGHT

**Order 01 — the public store.** `PR #573`, branch `grok/store-public-ground`.
Built. Under review. Do not start a second order on `app/store/**`.

Verified against the brief's own acceptance criteria at `629e13b5`: zero legacy
tokens remain, zero raw Tailwind type steps, no saturated colour, and
`badge--filed` — the administrative rung — used where a status badge was
needed. The `UNPAINTED` entry was updated to `FAMILY GROUND` rather than
deleted, which is what criterion 1 asked for. A loading state now exists where
there was none, carrying `.working` text beside the skeleton because Law 3 bans
a bare spinner.

---

## READY — take these in order

### 1. `/auth/link` — the only auth door with no ground at all

**Files:** `apps/web/app/auth/link/page.tsx` (127 lines). One file.

The page renders `<main className="mx-auto max-w-[42rem] p-[var(--s6)]">` — no
`.on-canvas`, no room, no ground class of any kind. Its `Suspense` fallback is
the same. `/login` takes `.on-canvas`; `/change-pin` takes ink with a riveted
frame. **Three doors of one flow, three different grounds, and this one has
none.**

It is also the surface an adult meets first when they click a sign-in link in
their email, and it is the least designed page in the auth set.

**Real states, all in source:** `Signing you in…` (`role="status"`), and nine
mapped refusal reasons from `REASON_COPY` — expired, already used, invalidated,
unknown, inactive account, wrong credential type, email changed, rate limited,
missing token — plus two unmapped fallbacks.

**Must not move.** The POST is automatic on mount and must stay automatic: the
route is POST-only *because* Outlook Safe Links and Defender GET every URL in a
message, and a GET-consumes design would burn a single-use token before the
human clicks — only for the users whose mail is best protected. Do not convert
it to a Continue button. The `attempted` ref guard stays. The session is re-read
from the server rather than trusted from the response body.

**Blocker:** none for the code. You cannot *reach* this page without a live
token and mail delivery, so its appearance is unverifiable by anyone except
Jason on a real link.

### 2. The three Law 3 gaps — colour doing work a glyph should share

Law 3: every state carries a glyph **and** an uppercase label, so it survives
greyscale and colour blindness. Three surfaces break it. All three verified
present at `27711faa`.

**`apps/web/app/parent/safety/page.tsx:169-171`** — the safety-gate badge on the
guardian's screen renders the label with no `<i>`:

```jsx
<span className={`badge ${GATE_OUTCOME_BADGE[gate.outcome]}`}>
  {GATE_OUTCOME_LABEL[gate.outcome]}
</span>
```

Worse: `blocked` and `flagged` both map to `badge--restricted`, so on a
guardian-facing safety screen **"Not clear" and "Needs a look" are separated by
label alone**. Add the glyph. Do not change either label and do not re-rung
either outcome — the rung assignment is a safety decision, not a visual one.

**`apps/web/app/coach/intelligence/page.tsx:148` and `:164`** — the severity
badge on open escalations and open compliance violations, same shape, no glyph.
`.badge` supplies `text-transform: uppercase`, so the label channel exists and
only the glyph is missing. `/admin/escalations:34-38` already carries the
canonical map for these exact severities (`critical → ✕`, `high → ▲`,
`moderate`/`low → ◉`). Copy it rather than inventing one.

**`apps/web/components/CoachWorkspace.tsx:1913-1916`** — the per-athlete
readiness indicator on the coach's roster is an 8px dot whose only other channel
is a `title` attribute. **A tooltip is not a rendered second channel** — absent
on touch, absent to a keyboard, absent in print. This is colour-only state on
the busiest coach surface in the building. The same file already ships the
compliant path: `StatusBadge` at 326-341 and `readinessBadgeTone`.

**Must not move.** The rung each state carries. `--cleared`/`--monitor`/
`--restricted`/`--locked` are the safety ladder; `--filed` is administrative.
And the readiness `UNKNOWN` state is first-class, not a placeholder — the page
says *"do not read this as 'zero flags'"* and that copy stays.

**Scope:** three files, three lanes. Run as three trivially-reviewable PRs, not
one.

### 3. `/simulator` — the safest surface in the building

**Files:** `apps/web/app/simulator/page.tsx` (136 lines). **Zero fetches.**
Fully static, renders identically against an empty database, and cannot break.

Pure typography and empty-state craft. Seven scenario titles, each carrying
`badge--filed` "Not Evaluated", two stat lines reading `None`, and a
`.stamp--flat` "Not Built".

**Must not move — and this is the whole point of the page.** Its header records
that seven hard-coded physiological predictions carrying **invented risk grades
on the safety ladder** were removed from it. Do not reintroduce any card that
implies a reading. The empty copy — *"this page reads no record, runs no model,
and writes nothing. Any figure or outcome shown here would have been written by
hand into the page itself"* — is the surface's reason for existing.

If anything, make it read *more* obviously unbuilt, not less.

### 4. The board seat workspace — one component, eight routes

**Files:** `apps/web/components/BoardMemberDashboard.tsx` (360 lines), reached
through `apps/web/app/board/BoardSeatWorkspace.tsx` (24 lines). The eight seat
pages are five-line wrappers. **Best leverage ratio in the building.**

Real aggregate data. Ten tabs, a seat-access notice, two `.plaque` facts, six
`.stat` tiles, and a card catalogue where exactly two cards are `built` and the
rest carry `PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED`.

**Layout problems that are yours:** the ten-tab strip is `sm:grid-cols-2
md:grid-cols-5` of two-line buttons with uneven heights; the card grid is fixed
`md:grid-cols-3` regardless of whether a tab has 3 cards or 11; `roleModulesBySeat`
renders twelve stamped bullets per seat under a single stamp.

**Must not move — five hard ones.** `BOARD_AGGREGATE_BOUNDARY_STATEMENT` renders
twice per seat and must stay **character-identical** (a test compares them).
`BoardSeatEvidence`'s `Announcement` interface deliberately omits `message` and
`author_name` — both used to render verbatim below the "aggregate-only"
paragraph, and a notice reading *"Congratulations to Maya R. on her first bout"*
is exactly the athlete detail a board wall refuses; **do not widen that type**.
The word **SHADOW must not appear on a board wall** (two tests). A 501(c)(3) is
never described as *owned* (two more). And `built` is reserved for a card whose
data a board member can load today — exactly two qualify.

`BoardSummaryPanel`'s `variant` prop (`hub` | `workspace`) currently resolves to
identical palettes and its comment says it survives *"as the seam where a future
ground split would land"*. That is the sanctioned place to differentiate hub
from seat, if differentiating is wanted at all.

### 5. Front Office consolidation — three small, independent wins

**`/admin` header** (`apps/web/app/admin/page.tsx`, 2,730 lines). The corridor
links repeat an identical inline Tailwind string **eight times verbatim**
(`inline-flex h-11 items-center border border-[color:var(--brass-700)] …`), and
the header renders up to thirteen buttons in one `flex-wrap` row that is
unreadable at tablet width. It also holds the slice's only hardcoded
`text-[14px]`. Extracting one class and giving the row a responsive treatment is
the clearest single win in the admin set.

**`/admin/platform/overview`** — a hand-rolled seven-column `<table>` while its
four siblings (`/admin/people`, `/admin`, `/operations`, `/admin/door-register`)
all use `.ledger`. Move it onto `.ledger` with a `<caption>` and wrap it in
`overflow-x-auto`; it currently has neither.

**The denial card** — *"Platform Owner Access Required"* is duplicated verbatim
across `/admin/platform`, `/admin/platform/overview` and `/admin/organizations`.
One presentational component, three call sites.

**Blocker on the last two:** both platform pages need a Microsoft-authenticated
`platform_owner` session to render anything but the denial card, so Jason cannot
review them live without signing in as Omega.

---

## BLOCKED — real work, but not yet

| Surface | Blocked on |
|---|---|
| `/admin/people`, `/admin/organizations`, `/admin/pin` | **PR #556** (DRAFT) owns those three files. Land or close it first. |
| The `.btn` / `--tap` cascade repair | **PR #534** measures it and is not on `main`. 109 BROKEN collisions including 23 `.btn` sites rendering 44px where source asks 55px. Land the measurement before the repair. |
| Any named wall on a named route | The mechanism does not exist. `plateVariant.ts` gives route → *slot*, never route → *named plate*, and says so: *"nothing in this file changes, ever, for art."* Needs a new mechanism or a room reassignment — settle which **before** ordering a plate. |
| The twelve photograph slots | A camera, not a generator. Six frames of 220 N Jefferson St, the head coach's portrait, and five portrait surfaces fed by `account_profiles` where most faces are minors. `gymPhotos.ts` forbids fake-photorealistic imagery in those slots. |
| Member portraits | Not a missing asset. `.plate`'s engraved-initials state is **primary by design** — privacy rules mean most viewers never see a child's face. |
| `/store` ground, if you disagree with `.on-canvas` | A different room is a `ROOM-PURPOSE-DNA.md` change and Jason's call. |

---

## OFF LIMITS — do not make these look better

Eight surfaces show **fabricated data**. `buildingMapCoverage.test.ts` has
already adjudicated each one, in those words. Polishing a fabricated surface
makes a fake more convincing:

`/admin/communications` · `/admin/curriculum` · `/admin/macro-analytics` ·
`/admin/retro-lab` · `/board/dashboard` · `/coach/operations` ·
`/director/dashboard` · `/guardian/dashboard`

**One exception, and it inverts the rule.** `/board/dashboard` renders entirely
fabricated figures behind a `Planned — Not Yet Implemented` stamp and a
disclaimer saying *"never carry a number from this page into a board packet or a
filing."* A test pins that disclaimer word for word and asserts it renders
**above** the sample figures. Its "chart" is seven divs sized
`Math.max(24, value)px` with no axis and no units. If anything is done there it
is to make that block read *less* like a real chart. Never move the disclaimer
below the fold or restyle it out of prominence.

Also off limits, for a different reason: **filtering any coach athlete picker.**
Twenty-four coach pages populate pickers from an org-wide roster the server will
now refuse most of. That is a live product question — `contracts.ts:28-32`
argues the opposite case by name — and narrowing what a coach is offered changes
what the screen claims about access. Raise it; do not restyle around it.

---

## The four traps, restated because they cost a round each

1. **`ppbf.css` is unlayered; Tailwind's utilities are not.** Layer order beats
   specificity, so any ppbf class defeats a utility naming the same property —
   and the utility still reads as correct in the JSX. Fix gaps in the sheet's
   own vocabulary. Never `!important`, never a second override sheet.
2. **The app's type stack is not the sheet's.** `globals.css:106-111` redefines
   six of eight font tokens *after* importing `ppbf.css`. `--font-body` is
   Roboto Condensed, not Inter. Reading only `ppbf.css` gets it wrong.
3. **No screenshot baselines, and do not add one.** They were deleted because
   Chromium shaping noise and a real regression are the same size. Computed-style
   assertion replaced them — `e2e/public-homepage.spec.ts` is the pattern, and
   #573 copies it correctly, including copying `backdrop()` verbatim and saying
   so.
4. **A room is four parts.** `room` + `room--X`, always both.
   `roomBaseClass.test.ts` exists because a modifier-only shell shipped once and
   76 of 79 surfaces went out with unlit walls.
