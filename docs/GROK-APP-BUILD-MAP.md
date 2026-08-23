# Grok App Build Map

**Built against `main` @ `27711faa` ("Record the 2026-08-23 release in the production state file (#571)"), 2026-08-23.**

This is the *code* build map for the Grok visual lane. It is not a design, not a
redesign, and not a list of screens anyone would like to exist. It is a record
of what the application does today, route by route, with the boundaries that
must survive a visual pass written next to each one.

Read with **`docs/GROK-VISUAL-LANE.md`**, which is the contract and outranks
this file on process. This file is the work list; that one is the law. Where
this document and the repository disagree, **the repository wins and this
document is wrong.**

---

## 0. THE OWNER-APPROVED PRODUCT CONSTITUTION IS NOT IN THIS REPOSITORY

Stated first because everything downstream depends on it.

`PRODUCT_VISION.md` and `PRODUCT_CAPABILITIES.json` — the two canonical files
named as the approved product constitution — **do not exist anywhere on `main`.**

```
git ls-tree -r --name-only origin/main | grep -iE "PRODUCT_VISION|PRODUCT_CAPABILITIES"
  → (no output)
```

What does exist is `PPBF_CAPABILITIES.json`, at the repository root and again at
`apps/web/public/PPBF_CAPABILITIES.json` (identical, both carrying a UTF-8 BOM).
It self-describes as:

```json
"version": "2.0.0-draft-merged",
"description": "Merged PPBF architecture - Original 25 + 200 detailed modules"
```

**That is a draft registry and it is not used as product direction anywhere in
this document.** It was last touched by an unrelated plate-asset commit. Every
row in the map below therefore reads `— no canonical source` in the
*approved product-direction implications* column. That column is not filled by
inference, by the draft registry, or by anyone's reading of what the product
ought to be.

**What this blocks:** nothing in the visual lane. Grok's job here is to make
what exists read correctly, not to decide what should exist. **What it does
block** is any brief that would add, remove, reorder or re-label a capability —
those need the constitution, and until the two files land, the answer to
"should this screen also do X" is *ask Jason*, not *infer*.

### Approved *visual* direction, by contrast, does exist

Do not confuse the two. These are on `main` and are owner-approved:

| Source | What it settles |
|---|---|
| `design-system/README.md` "The eight laws" | **The** law text. Eight laws, each naming the test that enforces it. |
| `design-system/ppbf.css` (3,575 lines, unlayered) | The implementation authority. 116 tokens, 311 class selectors, six rooms. |
| `docs/GROK-VISUAL-LANE.md` | The lane contract, amended 2026-08-22 by owner decision. |
| `docs/MOCKUP_TO_REPO_MAP.md` | Twelve approved layout-reference mockups → routes, and their motif→class table. |
| `docs/shadow-ui/ROOM-PURPOSE-DNA.md` | What each of the six rooms is *for*. |
| `apps/web/components/RefusalStamp.tsx` | The seven-stamp family, "Jason-approved design doc, locked art policy 2026-08-19". |

**One trap, named because it is in the same folder as the real law:**
`docs/DESIGN_LAWS_PROPOSAL.md` is a competing eight-law set. Its own line 3
reads *"Status: PROPOSAL. Not adopted. Not wired into `design-system/ppbf.css`"*
and it self-reports *"This rewrite has had no audit at all."* It is written to
un-cage designers and is therefore the most attractive document in the
repository to a visual lane. **Do not design to it.** The laws are the eight in
`design-system/README.md`.

---

## 1. EVIDENCE MARKS

Every claim in this document carries one:

- **OBSERVED** — read directly in source, a test, or a committed artifact at `27711faa`.
- **INFERRED** — an interpretation of source. Reasoning stated; could be wrong.
- **UNVERIFIED** — requires a rendered or deployed page to settle.

**Every claim about what a page looks like is UNVERIFIED.** Section 6 explains
why that is a structural fact in this repository and not an omission.

---

## 2. THE SHAPE OF THE BUILDING

OBSERVED, measured at `27711faa`:

| | Count |
|---|---:|
| `page.tsx` route files under `apps/web/app` | **133** |
| Doors in `apps/web/components/buildingMap.ts` | **110** |
| Routes with no door | **23** |
| Dynamic segments | **1** (`/store/[organizationId]`) |
| Route groups (`(...)`) | **0** |

Doors by room — my count matches `docs/GROK-VISUAL-LANE.md`'s corrected figures exactly:

| Room | Class | Doors |
|---|---|---:|
| Front Office | `.room--office` | **44** |
| Gym Floor | `.room--floor` | **34** |
| Board Room | `.room--board` | **12** |
| Clinic | `.room--clinic` | **10** |
| File Room | `.room--file` | **7** |
| After Hours | `.room--night` | **3** |

`design-system/ppbf.css:3480` and `:3508` still say "office 40 routes, floor 31".
Those two comments are stale; take 44 / 34.

### Two guard mechanisms, not one — OBSERVED

| Guard | Where | Routes |
|---|---|---:|
| `RoleSessionGate` (client, in the page) | `components/RoleSessionGate.tsx` | 67 |
| `RoleStandaloneView` (client shell that wraps the gate) | `components/RoleStandaloneView.tsx` | 24 |
| `BoardRoleGate` (via `app/board/layout.tsx`) | `components/BoardRoleGate.tsx` | 12 |
| **`requirePageRole` (SERVER-side, redirects)** | `src/server/pilot/pageGuard.ts` | **10** |
| No gate in the page at all | — | 24 |

There is **no `middleware.ts`** anywhere in the app. `requirePageRole` is the
only server-side page protection and it covers 10 of 133 routes — and 8 of those
10 are prototype or signpost pages nobody navigates to. Everything else gates on
the client, with the API's own access checks behind it.

**A correction worth carrying, because it is easy to get backwards.** Four lab
routes — `/knowledge-graph`, `/simulator`, `/source-control`,
`/source-control/publication-workflow` — plus `/admin/customize` and
`/admin/organizations/test` carry **no page gate of any kind** and render to
anyone who types the URL. `buildingMap.ts` files the first four under
`ADMIN_GATE`, but commit `b766e281` (#552) that did so states in its own message:
*"NAV VISIBILITY ONLY: no route guard, page gate, or API auth changed anywhere
in this diff."* The data behind each is guarded by its own API checks. So the
nav row is admin-only, the page chrome is open, and only the data is authorized.
Read "moved from ungated to gated" as **nav-visibility narrowing**, not page
gating. `/retro-lab` is the one lab route with a real `RoleSessionGate`. **This is a functional
fact Grok must not touch, and it is the reason `roles` in `buildingMap.ts` says
of itself: "IS A VISIBILITY HINT, NEVER AN AUTHORIZATION DECISION."**

---

## 3. THE EXCLUSION LIST — SURFACES GROK MUST NOT MAKE LOOK BETTER

This is the most important section in the document.

I measured off-system colour across every `.tsx` in the app. The result is
unusually clean, and the finding is not the one I expected:

**The worst-looking surfaces in the application are exactly the surfaces that
show invented data.** They are the same files.

OBSERVED, ranked by off-system colour (hex literals + legacy aliases + cold Tailwind palette):

| Component | Debt | Route | Repo's own classification |
|---|---:|---|---|
| `src/components/curriculum/CurriculumProgressionEngine.tsx` | 74 | `/admin/curriculum` | *"prototype: reads no data and saves no progression"* |
| `src/components/core/DevToolsQAConsole.tsx` | 70 | `/admin/retro-lab` | *"internal QA scaffolding — a workbench, not a gym surface"* |
| `src/components/analytics/MacroCommandCenter.tsx` | 70 | `/admin/macro-analytics` | *"prototype: charts nothing it queried — figures are not the gym's"* |
| `src/components/communications/MediaAndCommsHub.tsx` | 65 | `/admin/communications` | *"prototype: 13 useState hooks and no fetch — nothing it shows or accepts is persisted"* |
| `src/components/coach/FloorOperationsDesk.tsx` | 39 | `/coach/operations` | *"prototype: hardcodes sample athletes — fabricated athlete records"* |
| `src/components/core/PunxsyEcosystemCore.tsx` | 29 | `/admin/retro-lab` only | lab prototype, no fetch |

Those classifications are not mine. They are quoted verbatim from
`apps/web/components/buildingMapCoverage.test.ts`, which is a **passing test**
that fails the build if a new page is added without either a door or a stated
reason for having none. The repository has already adjudicated these.

Its reasoning, quoted, is the rule for this lane too:

> A door advertises a working surface. Advertising eight that show invented data
> — to boards, guardians and coaches — is worse than leaving them reachable
> only by URL.

**The rule: polishing a fabricated surface makes a fake more convincing.**
A board member who opens a beautifully-set `/board/dashboard` and reads
`trainingMinutes = 8720` off a leather panel has been lied to more effectively
than one who reads it off a bare div.

### Do not do visual work on these eight (OBSERVED, from `EXCLUDED`)

`/admin/communications` · `/admin/curriculum` · `/admin/macro-analytics` ·
`/admin/retro-lab` · `/board/dashboard` · `/coach/operations` ·
`/director/dashboard` · `/guardian/dashboard`

The last two are signposts — the prototypes behind them were **deleted, not
stamped**, and the routes now point at the real surfaces. `/guardian/dashboard`'s
own comment records why: *"a consent toggle that records nothing must not remain
mountable."*

**One exception, and it inverts the rule.** `/board/dashboard` renders entirely
fabricated sample data behind a `Planned — Not Yet Implemented` stamp and a
disclaimer that says *"never carry a number from this page into a board packet
or a filing."* `boardViewportSwitcherHonesty.test.tsx` pins that disclaimer word
for word and asserts it renders **above** the sample figures. Its
`macroRiskPoints` "chart" is seven divs sized `Math.max(24, value)px` with no
axis and no units. **If anything is done here it is to make that block read
*less* like a real chart, never more.** Grok must not move the disclaimer below
the fold, soften it, or restyle it out of prominence.

### Seven more in `PENDING_TRIAGE` — real features, no door, roles unconfirmed

`/admin/export` · `/admin/import` · `/admin/gear` · `/admin/gear/vendors` ·
`/admin/athletes` · `/admin/organizations/test` · `/admin/platform/overview`

These are real (`/admin/gear` and `/admin/import` carry the highest *legitimate*
legacy-token debt in the app: 49 and 33 call sites). They are **not** blocked for
visual work by the fabrication rule — but their role sets are an open owner
question, and `buildingMapCoverage.test.ts` caps this map at 7 entries, so
adding a door is a decision, not a formality. **Visual work here is safe;
adding navigation is not.**

---

## 4. THE BUILD MAP

### 4.1 How to read a row

Per the brief, each surface is captured as: Role → Route → real purpose →
existing actions → data shown → important states → current components/styles →
required functional boundaries → approved product-direction implications →
Grok visual opportunity → dependencies/blockers.

Rendering 133 of those in full would produce a document nobody reads. What
follows instead is: **(a)** the full route table with the columns that decide
sequencing, **(b)** full eleven-field entries for the P0 set and for every
surface with a boundary subtle enough to be crossed by accident, and **(c)** the
cross-cutting rules that apply to all of them. Surfaces not written up in full
are covered by (a) and (c), and their detail is one `grep` away — the map's job
is to say which ones need the care.

### 4.2 The cross-cutting rules — these apply to every row

**R1. `ppbf.css` is unlayered. Your Tailwind utility probably does nothing.**
OBSERVED: `grep '@layer' design-system/ppbf.css` returns only prose in comments.
`globals.css` imports it plainly at line 15, right after `@import "tailwindcss"`.
Tailwind v4 emits `properties → theme → base → components → utilities`; **layer
order resolves before specificity and unlayered beats layered.** So any single
ppbf class defeats any Tailwind utility naming the same property — and the
utility still reads as correct in the JSX.

Two measured consequences, both confirmed by me:

- `.btn { min-height: 44px }` (`ppbf.css:790`). **21 call sites** in app source
  write `.btn` together with `min-h-[var(--tap)]`. `--tap` is 55px. Those
  buttons render **44px**. The source asks for the gym-floor target and gets the
  desk one.
- `.btn--lever` + `min-h-[44px]` → renders **38px**, per PR #534's scanner.

The sanctioned fix is the one `FRONTEND_STYLE_CONTRACT.md` already states:
**fix the gap in `ppbf.css`, in the sheet's own vocabulary, not in the page.**
`.btn--start` and `.btn--tap` exist precisely as escape hatches (`.btn--start`
is equal specificity to `.btn` and later in source order, which is what makes it
win). **Never `!important`. Never a second override sheet** — that is named
explicitly in the lane contract.

**R2. The app's type stack is not the design system's type stack.** OBSERVED,
and I have not found this written anywhere else. `globals.css:106-111`
redefines six of the eight font tokens in its own unlayered `:root`, *after*
importing `ppbf.css`:

| Token | `ppbf.css` declares | The app actually resolves |
|---|---|---|
| `--font-body` | `"Inter", ui-sans-serif, …` | `var(--font-tactical-body)` → **Roboto Condensed** |
| `--font-data` | `ui-monospace, SF Mono, Menlo, …` | `var(--font-geist-mono)` → **Geist Mono** |
| `--font-ui` | `"Oswald", "Inter", …` | `"Oswald", var(--font-tactical-body), …` |

`globals.css` says why: *"the DS's own --font-body chain begins with Inter,
which the repo does NOT ship."* Only five faces are self-hosted (Alfa Slab One,
Oswald, Special Elite, Caveat, UnifrakturCook). **A brief that reads only
`ppbf.css` gets the body and data voices wrong.** `--font-display`, `--font-type`
and `--font-gothic` are not overridden and are correct as declared.

**R3. A room is four parts and the base class is load-bearing.**
`.room` (ground, ink, isolation) + `.room::before` (the light) + `.room::after`
(the plate) + `.room--X` (the material, which *declares* `--plate` and never
consumes it). `roomBaseClass.test.ts` exists because a modifier-only shell
shipped once and **76 of 79 surfaces went out with unlit walls** — invisible to
build, typechecker and browser. Write `room room--office`, never `room--office`.

**R4. The `room:` field in `buildingMap.ts` is a copy, not an opinion.** It
mirrors what the page paints, and `buildingMapRooms.test.ts` compares them route
by route. Fourteen doors had drifted before that test existed. **Changing a room
means changing the page *and* the map, and the decision comes from
`ROOM-PURPOSE-DNA.md`** — not from either file alone.

**R5. The plate system gives route → *slot*, never route → *named plate*.**
OBSERVED, confirmed three ways. `plateVariant.ts` emits exactly
`"2of2 1of3 4of4 3of5 5of6"` — five ordinal-of-cardinal tokens. The pathname is
consumed by an FNV-1a hash with a murmur3 finalizer and **discarded**; no route
identity reaches the DOM. The file states *"nothing in this file changes, ever,
for art."* The variant block in `ppbf.css` is currently **empty on purpose** —
all three `data-plate-variant` occurrences in the sheet are inside comments.

A rule can say *"whichever office doors land in slot 2-of-2 take
`plate-01-office-02.jpg`."* It **cannot** say *"`/coach/session-scripts` takes
the chalkboard wall."* A brief that wants a named wall on a named route needs a
new mechanism or a room reassignment. **Settle that before ordering the plate.**

**R6. `.plate` and `--plate` are unrelated systems sharing a word.** `--plate`
is the wall background. `.plate` / `.plate-initials` is the **portrait plate** —
an engraved brass square carrying a member's initials. Its no-photo state is
**primary by design**, not a fallback: privacy rules mean most viewers never see
a child's face. *"A grey silhouette is a missing asset with a shrug drawn on it."*

**R7. Every class you name must be defined.** `designSystemClasses.test.ts`
asserts that every class the app uses under `room--`, `mat-`, `btn--`, `badge--`,
`alert--`, `corridor-`, `catalog-`, `commands-`, `tcard-`, `pap--`, `seal--`,
`stamp--`, `light--`, `light-at--` exists in `ppbf.css` or `globals.css`.
Comments are stripped first, so prose naming a class is not evidence. **A rename
that misses one sheet fails the build.**

**R8. Law 3 is not decorative.** Every state carries a glyph **and** an
uppercase label, so it survives greyscale and colour blindness. A bare spinner
is colour-and-motion-only and is banned — pair `.skeleton` / `aria-busy` with
`.working` text. The guardian E2E spec asserts the literal string
`Consent needed` for exactly this reason: *"a consent screen that says 'needed'
only in red is a consent screen a colour-blind guardian cannot read."*

**R9. Three states must never collapse into one.** On every aggregate surface,
`Suppressed` (k-anonymity withholding, cohort < 5) ≠ `None filed` (a real zero)
≠ a failed read. `BoardSummaryPanel`'s own comment: *"a board reading '0' would
take it for a measurement."* **Any tile redesign that renders a suppressed
figure as a blank or a zero converts a withholding into a measurement.**

**R10. Refusal is a stamp, not a toast, and a refusal is a whole screen.**
`RefusalStamp` carries a locked art policy: `MEDICALLY_NOT_ALLOWED` is the
**only** kind that may use red / `--locked`. `WAIT`, `GET_PERMISSION`,
`WRONG_DOOR`, `SIGNED_OUT`, `CANNOT_BE_DONE` and `TRAINING_HOLD` all render
brass/bone — *"a coach who is not scoped to an athlete and a same-day medical
hold must never wear the same colour of 'no'."* On `/shadow`, the one
`refusesInPlace` door, `GlobalRoleHeader` collapses to a minimal bar because
P0.2 says the refusal screen is *Title + body + Dashboard + Logout only*.

**R11. No streaks, leaderboards, countdowns or comparative ranking.** Enforced
by `achievementPaths.test.ts`. The reason, from `VISUALS_RECOMMENDATIONS.md`:
*"Any progress mechanic that can express a window, a streak, a deadline, or a
ranking creates a direct incentive to hide an injury rather than report it."*

**R12. The guardian boundary is enforced by what is absent.** Safety
escalations, hold reasons, gate reasons, announcement bodies and author names,
and other guardians' names are all excluded server-side. `BoardSeatEvidence`'s
`Announcement` interface **deliberately omits `message` and `author_name`** —
a notice reading *"Congratulations to Maya R. on her first bout"* is exactly the
athlete detail a board wall refuses. **A tile, a count, or a "recent activity"
strip added for visual balance is how that boundary gets crossed.**

**R13. The word SHADOW does not appear on a board wall.** Two tests pin it. A
501(c)(3) is never described as *owned*. Two more tests pin that.

**R14. Easter eggs are room-gated.** `EGG_ROOMS = ['office', 'floor']`.
`pathAllowsEggs()` answers **no** for any path with no door, deliberately —
*"a missing flourish is nothing, a joke in a clinic is the thing the DNA is
written to prevent."*

### 4.3 The route table

Columns that decide sequencing. **Class** is INFERRED; everything else OBSERVED.
`PG` = server `requirePageRole` · `RSG` = `RoleSessionGate` · `RSV` =
`RoleStandaloneView` · `BRG` = `BoardRoleGate`.

#### Ways in — no door by design ("you arrive through it, not to it")

| Route | Gate | Ground | Notes |
|---|---|---|---|
| `/` | — | `.on-canvas` | Public homepage. Zero fetches. JSON-LD `NGO` block is a legal claim, not presentation. |
| `/login` | — | `.on-canvas` | The Bell. `SignInPanel` is shared with `/public`'s popover — **one component, two mounts**. |
| `/athlete/sign-in` | — | `.on-canvas` + `.mat-paper` | The athlete's own door. Bare card while `/login` is a riveted frame. |
| `/activate` | — | `.on-canvas` + `.mat-paper` | Three stages. Code is **never** read from the query string (security decision). |
| `/change-pin` | — | ink + `.frame` + `.mat-leather` | The most finished auth door. No escape hatch may be added. |
| `/auth/link` | — | **none** | Magic-link landing. **Declares no ground class at all.** See P0.2. |

#### P0 — foundation, identity, primary work surfaces

| Route | Role | Gate | Room | State |
|---|---|---|---|---|
| `/dashboard` | all | — (self-routing) | office `room--lit-center` | **Done.** Fully converted, framed, lit. |
| `/athlete/dashboard` | athlete | **PG** + RSV | floor | `AthleteWorkspace.tsx`, **3,062 lines**, 11 panels inline |
| `/coach/environment/intake-router` | coach | RSV | floor | Coach landing |
| `/admin/people` | admin, platform_owner | RSG | office | Admin landing. Touched by open PR #556. |
| `/parent/dashboard` | parent | RSV | office / `.on-canvas` | `ParentHub.tsx`, 1,235 lines, 10 tabs (8 stamped unbuilt) |
| `/workspace` | staff, volunteer | RSG | office | Staff/volunteer landing. 4 surfaces, each role-checked against its API. |
| `/board` | board, platform_owner | BRG | board | Board landing |
| `/shadow` | MEMBER_GATE | — (`refusesInPlace`) | night | The only refuse-in-place door in the map |

#### P1 — core operational workflows (selected; full list in `buildingMap.ts`)

Gym Floor, 34 doors: `/coach/review-queue` (**PG**), `/coach/decision-loop`,
`/coach/cards`, `/coach/session-scripts`, `/coach/drills`, `/coach/cue-library`,
`/coach/workout-templates`, `/coach/intelligence`, `/coach/attempt-log`,
`/coach/floor-groups`, `/coach/recognition`, `/coach/progression-intelligence`,
`/coach/performance-analytics`, `/coach/video-analysis`, `/coach/passbook-gaps`,
`/coach/transfer-check`, `/coach/intervention-{protocols,executions,review}`,
`/coach/behavior-standards`, `/athlete/{progression-intelligence,video-analysis}`,
`/athlete/dashboard/sparring`, `/schedule`, `/names`, `/wall`, `/rabbit-holes`.

Clinic, 10 doors: `/coach/sports-medicine`, `/admin/safety-flags`,
`/admin/escalations`, `/admin/safety-review`, `/admin/athlete-consent`,
`/admin/waiver-status`, `/admin/video-compliance`, `/admin/compliance-center`,
`/admin/feedback`. Plus `/admin/safety-escalations`, which is a four-line
`redirect()` — **it holds a door but returns no JSX. Nothing to style.**

Family: `/parent/consent`, `/parent/safety`, `/parent/progression-visibility`,
`/guardian`.

#### P2 — secondary, admin, reporting

Front Office, the remaining 44-door bulk: `/admin` and its 20-odd consoles,
`/operations` + 2, `/notices`, `/chalkboard`, `/profile`, `/print`,
`/staff-credentials`, `/coach/{cohorts,disciplines,credentials}`,
`/source-control` + 1.
Board Room: the eight `/board/{seat}` routes (each a 5-line wrapper around one
`BoardSeatWorkspace`), `/board/compliance-monitoring`,
`/board/escalation-monitoring`, `/admin/board-seats`.

#### P3 — specialized, low-frequency, future

File Room: `/research`, `/research/chat`, `/research/review`, `/evidence`,
`/knowledge-graph`, `/audit`, `/simulator`.
After Hours: `/shadow/scout`, `/admin/shadow`.
Public/commerce: `/public`, `/help`, `/store`, `/store/[organizationId]`.
Excluded entirely: the eight prototypes in §3.

---

## 5. THE P0–P3 SEQUENCE

**P0 — foundation and identity.** The surfaces every user passes through, and
each role's landing. In order of leverage:

1. **The cascade repair (R1).** Cross-cutting, and it gates the value of
   everything after it: while `.btn` beats `min-h-[var(--tap)]`, no amount of
   per-page work puts a gym-floor target on a gym-floor button. **Blocked on
   PR #534 landing** — see §7.
2. **`/auth/link`** — the only auth surface with no ground class at all.
3. **The eight prototypes get *removed from consideration*, not styled** (§3).
4. Role landings: `/athlete/dashboard`, `/coach/environment/intake-router`,
   `/admin/people`, `/parent/dashboard`, `/workspace`, `/board`.

**P1 — core operational workflows.** Gym Floor (34) and Clinic (10). These are
where the work happens and where the safety semantics live, so they carry the
highest boundary risk per pixel. `AthleteWorkspace.tsx` at 3,062 lines is the
single largest safe win in the app: **splitting its eleven inline panels into
presentational sub-components is pure JSX restructuring** and would make
everything after it reviewable.

**P2 — secondary, admin, reporting.** The Front Office's 44 doors and the Board
Room's 12. The board seats are eight 5-line wrappers around one component —
**one file, eight routes**, the best leverage ratio in the building. Note that
`buildingMap.ts` gives all eight the same room and `BoardSummaryPanel`'s
`variant` prop (`hub` | `workspace`) currently resolves to identical palettes;
its comment says it survives *"as the seam where a future ground split would
land."* That is the sanctioned place to differentiate, if differentiation is
wanted at all.

**P3 — specialized and low-frequency.** File Room, After Hours, commerce.

---

## 6. WHY EVERY APPEARANCE CLAIM IS UNVERIFIED

This is structural, not an omission.

**Chromium is present** in this container (`/opt/pw-browsers`, revisions 1194
and 1234, `PLAYWRIGHT_BROWSERS_PATH` set), so a screenshot *can* be produced
locally. **There are deliberately no screenshot baselines in the repository**,
and `apps/web/e2e/public-homepage.spec.ts:1-45` explains at length why:

> cross-version pixel comparison fails because Chromium shaping moves wrap
> points — ~23-38px per section. Narrowing to the hero still gave 11,960
> differing pixels (5%) against a 2% tolerance, while a real regression is ~4%.
> **The noise and the signal are the same size.** No threshold catches one
> without swallowing the other.

`playwright.config.ts` carries the matching note: *"there is deliberately no
`toHaveScreenshot` tolerance here because there are no screenshot baselines left
to tolerate… Re-adding a baseline means pinning the browser revision in the
container first."*

What replaced pixel baselines is **computed-style assertion**, and it is good:
`public-homepage.spec.ts` walks the live DOM and asserts Law 2 (no element may
paint `rgb(168,30,34)`, the safety red, on a page whose audience is strangers),
an AA contrast floor with a `backdrop()` helper that **refuses rather than
guesses** over gradients and translucency, and a 44×44 target floor measured as
*both* dimensions (*"height alone passes an icon-only button that is 44 high and
20 wide, which is the shape most likely to be too small in the first place"*).

**This is the model for every visual test Grok adds.** Assert computed style
against the design system's own laws; do not add a pixel baseline.

### What cannot be seen at all, and why

| Surface | Why it is unverifiable here |
|---|---|
| `/athlete/dashboard` | Server-guarded; listed in `SERVER_GUARDED_ROUTES` because a browser stub cannot reach `requirePageRole`. **No test in the repository renders it.** |
| `/auth/link` | Needs a live magic-link token and mail delivery. |
| `/activate` past stage 1 | Needs an unredeemed activation code row. |
| `/change-pin` | Needs a session already carrying `must_change_pin`. |
| `/athlete/video-analysis` with content | Needs blob storage and a coach upload. |
| Every board and guardian surface with data | Needs seeded `pilot.board_seats`, `pilot.guardian_links`, `pilot.parents`. Migrations are operator-applied; **application state in any environment is UNVERIFIED.** |
| All eight plate JPEGs | I read their byte counts, not their pixels. A `background-image` that 404s is silently not painted — by design. |
| Whether the six rooms read as six rooms | The owner's stated quality bar (*"no two rooms alike"*), and the least establishable thing from source. |

**The lane contract already says the honest thing:** *"the live review is still
the only real visual verification that exists."*

---

## 7. COLLISIONS WITH OPEN PRs

Ten PRs open at `27711faa`. Two matter to this lane, and neither is what I
first assumed.

**PR #556 — "Admin Visual Set 1: the same foot under people, organizations and
PIN" — DRAFT, head `551b5f04`.** OBSERVED from its file list: it touches
`app/admin/{organizations,people,pin}/page.tsx` and their tests, and the change
is **adding `<WorkAxis />` at the foot** of each, nothing more. **This is a
genuine file-level collision** for those three admin routes and only those. Any
Grok work on `/admin/people`, `/admin/organizations` or `/admin/pin` must wait
for #556 to land or be rebased onto it. It is a draft, so it is also the
cheapest thing on the list to finish or close.

**PR #534 — "Measure the unlayered-CSS collision set, with Tailwind as the
oracle" — head `2cf162ea`.** OBSERVED: it touches only
`apps/web/scripts/css-layer-collisions.mjs` and adds
`docs/current/CSS-LAYER-COLLISIONS.md`. **It touches no app source, so it is not
a file-level collision at all** — I had this wrong earlier and the file list
corrects it.

It is, however, **a prerequisite in substance.** Its report is *on the branch
only, not on `main`*, and it is the measurement of R1: 8,562 `className` sites,
721 unlayered class-bearing rules, **0 class-bearing rules inside `@layer`**,
974 collisions of which **109 are BROKEN** — a value written on purpose that
never applies. The five worst clusters are the 25 `.btn--lever` sites rendering
38px, the 23 `.btn` sites rendering 44px where 55px was asked for, the 18
`.textarea` sites all collapsing to a 46px floor, and two `justify-*` defeats.

**Recommendation: land #534 before the P0 cascade repair.** Doing the repair
without the measurement means fixing what someone noticed rather than what is
broken, and the report is already written.

The other eight — #559 (repo-root file deletion), #545 (session-script seed,
held on an owner content decision), #507 (DRAFT, SharePoint research archive),
and five dependabot bumps (#533 `@types/node`, #532 `@types/pg`, #531
`@tailwindcss/postcss`, #530 `eslint` — red, #529 `jest-dom`) — touch nothing in
this lane. #531 bumps `@tailwindcss/postcss` and so is worth landing *after*
#534's measurement, not before.

---

## 8. FUNCTIONAL FINDINGS — NOT GROK'S LANE, RECORDED FOR THE OWNER

Found while mapping. Every one is outside the visual lane's permitted change
surface; they are written down so they are not lost, not so Grok fixes them.

1. **`credentialPolicyDrift.test.ts` guards an emptied file.** OBSERVED: its
   `AUTH_SURFACE` list names `app/login/page.tsx`, which is now a 20-line
   `Suspense` wrapper. The auth logic moved to `components/SignInPanel.tsx`,
   which is **not in the list**. No violation exists today, but the guard would
   not catch one if it were reintroduced there. *(Security-guard coverage gap.)*
2. **`/api/pilot/athlete/check-in` is a live route with no caller anywhere.**
   OBSERVED. The inverse of a dead button.
3. **Bio Check-In collects nothing.** `sleepHours`, `energyLevel`, `motivation`,
   `hydrationStatus` and `soreness` reach no request body. Three of them are
   *also* on the reachable Dashboard tab, where an athlete will read them as
   recorded. `AthleteWorkspace.tsx:44` documents this.
4. **`AthleteSummaryPanel` receives `unreadMessages={0}` as a literal** and
   renders it as a `.stat-val` beside two tiles that are real counts.
5. **`/athlete/dashboard/sparring` has no read path** — it never shows what was
   previously logged.
6. **`/athlete/progression-intelligence` leaks HTTP status codes to a child**
   (`Failed to fetch gaps: 500`). The only athlete-facing string in that lane
   that does. *(The copy fix is presentation-side and is a good early P1 item.)*
7. **Four board aggregates are built and surfaced nowhere:**
   `board/volunteer-summary`, `board/wrestling-league-summary`,
   `board/external-competition-summary`, `board/chat`. The last one on a wall
   where *"the word SHADOW does not appear"* is worth a governance eyebrow.
8. **The one control the board boundary statement names — seat assignment, held
   by the president — has no `/board/**` UI.** Its only surface is
   `/admin/board-seats`. The president reaches it by typing an `/admin/` URL.
9. **`/board/escalation-monitoring` has no link back to `/board`** and is linked
   from no board page.
10. **`.t-data--xl` is declared in `ppbf.css:656` with zero call sites** — the
    exact "class with no consumer" failure `VISUAL_BUILD_MAP.md` warned about.
    `.seal` and `.mat-cork` are likewise applied zero times in `apps/web`.
11. **`e2e/support/signIn.ts` emits `board_seat` (singular string)** while
    `readBoardSeatsFromSession` reads `board_seats` (array). No spec exercises
    it, so nothing fails.
12. **Cross-lane test hazard:** `board-governance.spec.ts` asserts the heading
    `The Bell` ten times. That heading is rendered by `SignInPanel.tsx`, which
    belongs to the auth lane. **An auth-lane edit to that `<h1>` fails three
    board-lane tests.** Do not fix by loosening the board spec.

---

## 8A. THREE CONFIRMED LAW 3 GAPS — the best small first batch

Law 3 says every state carries a glyph **and** an uppercase label, so it survives
greyscale and colour blindness. Three surfaces break it. All three are
**presentation-only**, all three are inside Grok's permitted change surface, and
each is a few lines. I verified all three directly in source.

**1. `apps/web/app/parent/safety/page.tsx:169-171`** — the safety-gate outcome
badge on the guardian's screen renders the label with **no `<i>` glyph**:

```jsx
<span className={`badge ${GATE_OUTCOME_BADGE[gate.outcome]}`}>
  {GATE_OUTCOME_LABEL[gate.outcome]}
</span>
```

Worse: `blocked` and `flagged` both map to `badge--restricted`, so on a
guardian-facing safety screen **"Not clear" and "Needs a look" are distinguished
by label alone**. Add the glyph; do not change either label, and do not
re-rung either outcome — the rung assignment is a safety decision.

**2. `apps/web/app/coach/intelligence/page.tsx:148` and `:164`** — the severity
badge on open escalations and open compliance violations:

```jsx
<span className={`badge ${severityBadgeClass(item.severity)}`}>{item.severity}</span>
```

The `.badge` rule supplies `text-transform: uppercase`, so the label channel is
present — only the glyph is missing. `/admin/escalations:34-38` and
`/admin/safety-review:60-63` already carry the canonical map for exactly these
severities (`critical → ✕`, `high → ▲`, `moderate`/`low → ◉`). Copy it.

**3. `apps/web/components/CoachWorkspace.tsx:1913-1916`** — the per-athlete
readiness indicator on the coach's roster is an 8px dot whose only other channel
is a `title` attribute:

```jsx
<span
  className={`w-2 h-2 rounded-full ${readinessDotClass(athlete.readiness)}`}
  title={athlete.readiness === 'UNKNOWN' ? 'Readiness not tracked' : `Readiness: ${athlete.readiness}`}
></span>
```

**A `title` tooltip is not a rendered second channel** — it is absent on touch,
absent to a keyboard, and absent in print or greyscale. This is colour-only
state on the busiest coach surface in the building. The same file already ships
the compliant path: `StatusBadge` at lines 326-341 and `readinessBadgeTone`.

**Why this is a good early batch and not the first item:** it closes a stated
law on three real surfaces for very little diff, but it is three files across
three role lanes rather than one screen, so it does not satisfy the brief's
"one visual concern, one PR" scope for a first item. Run it as the second PR,
or as three trivially-reviewable ones.

**What must not move while doing it:** the badge rung each state already carries
(`--cleared`/`--monitor`/`--restricted`/`--locked` are the safety ladder,
`--filed` is administrative — see §4.2 R8 and the appendix in
`docs/GROK-APP-BUILD-MAP.md` §8B), and every label string.

---

## 8B. THE FROZEN VOCABULARY

Role vocabulary, medical/hold semantics and status vocabulary are all on the
**may-not-change** list. A visual lane needs to know what the real values are so
it never renders one that does not exist, and never re-labels one that does.

The full enumeration — every status, scope, severity, outcome and category these
domains can produce, with its migration or source file — was compiled during
this mapping and is too long to inline here without burying the build map. The
values that most often get invented or re-labelled by a visual pass:

| Domain | The values that exist | The trap |
|---|---|---|
| **Training hold scope** | `all_training`, `contact_only`, `conditioning_only` | `contact_only`/`conditioning_only` mean training **continues at reduced intensity**. The migration is explicit: this "is deliberately NOT a demotion of the athlete… What regresses is the PERMITTED INTENSITY, never the athlete's standing." Never draw them as a stop. `/coach/sports-medicine` offers only the first two — the third is refused by the server but historical rows still render everywhere. |
| **Clearance** | `cleared`, `restricted`, `not_cleared`, `pending`, plus rendered `none` and `unavailable` | **`none` ("no record on file") is not `not_cleared` ("a doctor said no").** Both once wore `--locked` and a coach could not tell them apart; `none` was deliberately dropped a rung. Do not put it back. |
| **Safety flag severity** | `advisory`, `attention`, `blocking_display` | **No value here blocks an action.** `blocking_display` means the UI shows it prominently. Do not draw it as a gate. |
| **Goal category** | `null` + Boxing, Fitness, Academics, Attendance, Recovery, Lifestyle, Leadership | `null` renders **"No category"**, never "Boxing". `'Weight Loss'`/`'Weight Gain'` are withheld by owner decision pending the Privacy-Tier System. |
| **Goal progress** | `null` or `0..100` | `null` = "Not reported yet" and **draws no bar at all**. A real reported `0` **does** draw one. `x || 0` collapses the two and is a statement about how a child is doing. |
| **Personal goal** | `reached_at` null or set | `null` means "still working", **never "failed"**. There is no failed state and no overdue flag in the model. |
| **Readiness** | `GREEN`/`YELLOW`/`RED` + client-side `UNKNOWN`; `method` is `UNKNOWN` or `staff_entered_intake` | `UNKNOWN` is first-class, not a placeholder — *"do not read this as 'zero flags'"*. The unvalidated caveat (*"read them as a colleague's judgement, not as a measurement"*) must stay renderable beside the number. Nothing in the platform currently sets `ESTABLISHED`. |
| **Attempts** | `made` is `true`/`false`/**`null`** | `null` = "measured", an open attempt with no target — **not a pass and not a fail**. `false` is the most informative row, not an error state. The migration forbids any leaderboard, ranking or cross-athlete comparison built on this table. |
| **Transfer** | `not_transferring`, `untested_live`, `transferring`, `insufficient_evidence` | Raw counts travel with every flag by design — *"a flag is a reason to look, never a verdict."* Do not replace counts with a score or a rank. |
| **Board aggregates** | `available`, `unavailable`, `insufficient_data` | Three facts, never collapsed. `Suppressed` ≠ `No records` ≠ a failed read. See R9. |
| **Membership** | `active`, `lapsed`, `ended` | **Membership state is not a gate.** Only a training hold blocks registration; a lapsed membership rides along on the *success* message. Do not make `lapsed` look like a refusal. |
| **Refusal stamps** | `wait`, `get_permission`, `medically_not_allowed`, `wrong_door`, `signed_out`, `cannot_be_done`, `training_hold` | Only `medically_not_allowed` may use red/`--locked` (owner's locked art policy, 2026-08-19). Do not "unify" the family onto one colour. |
| **Behaviour standards** | ten `recognition_kind` values, all positive | Closed set, **positive only** — there is no column in which a negative observation can be written. |

Two vocabularies that look like one and are not: `athlete_programs.program`
(`fitness`, `youth`, `recreational`, `competitive`) and
`account_profiles.program` (`fitness`, `recreational`, `youth_mentorship`,
`competitive`, `unstated`) answer different questions, and `athletes.gym_status`
is a third, unconstrained, and privacy-classified as body data. Do not unify
them on screen.


---

## 8C. THE ONE THING A VISUAL PASS COULD MAKE WORSE

Everything else in this document is either a boundary to preserve or an
opportunity to take. This one is neither: it is a live mismatch between what a
screen says and what the server allows, and the natural visual instinct — tidy
the list, soften the error — is the wrong move on every count.

**The roster read is org-wide by design.** `GET /api/pilot/athletes/list` sends
a coach every athlete in the organization, with `dob` and `emergency_contact`
redacted. That is deliberate and documented — `contracts.ts:28-32`:

> A coach needs every athlete's name and gym status **to plan a floor** and to
> pick up cover, so the roster stays org-wide.

**The writes are not.** On 2026-08-22, PRs #563 and #565 gated a batch of
athlete-addressed coach routes on `assertActorCanAccessAthlete`, which for a
coach resolves to *assigned, or an active coverage grant*. Neither PR touched a
single file under `apps/web/app/coach/`.

**So 24 coach pages populate an athlete picker from a list the server will
refuse most of.** The coach is shown, as selectable, children the write path
rejects. Two instances are worth naming because of where they sit:

- **`/coach/sports-medicine`** builds the clearance board from the whole gym and
  then issues two requests per athlete. An athlete this coach neither coaches
  nor covers renders `clearance: 'unavailable'` — whose copy reads
  *"Clearance could not be read just now. **Unknown is not cleared** — check
  again before making a call that depends on it."* That is **a refusal rendered
  as an outage, on a medical board.** The empty-state copy on the same page says
  *"Athletes you coach (or cover) will appear here."*
- **`/coach/behavior-standards`** offers the whole gym on the form that files a
  safeguarding concern — the route PR #565's own message called *"the worst of
  them."* The gate is now correct; the picker is not.
- **`/coach/floor-groups`** heads the page *"The room split for whoever showed
  up"* and, on refusal, renders the raw server sentence
  `Forbidden: coach not assigned to athlete` in a page-top banner headed
  **"Failed"**, far from the button that produced it.

**What Grok may do here:** move that refusal from a page-top banner to inline
beside the control that caused it. That is a relocation of an existing message
and nothing else.

**What Grok must not do:** filter any athlete picker client-side, reword any
refusal, or soften "Unknown is not cleared". Narrowing what a coach is offered
is a product decision about a coach's reach — it changes what the screen claims
about access, and `contracts.ts` currently argues the opposite case by name.
**Raise it; do not restyle around it.**

### Three more dead ends found in the same pass, all verified

1. **`/coach` does not exist** — there is no `apps/web/app/coach/page.tsx` and no
   door for it. **Ten coach pages** render
   `<Link href="/coach">Back to Coach Workspace</Link>`. Ten dead buttons. The
   real hub is `/coach/environment/intake-router`, which four other pages link
   to correctly.
2. **`/coach/progression-intelligence:521`** renders
   `{athlete.display_name || athlete.athlete_id}` against an interface declaring
   `display_name` (line 58), while the API sends **`full_name`**
   (`contracts.ts:14`). The field is always undefined, so **the picker shows raw
   athlete IDs.** The identical defect is recorded as already-found-and-fixed on
   `/coach/cards`.
3. **`/coach/cue-library`** deep-links to `/coach/drills?drill_id=…`; that page
   has no `useSearchParams` and never reads the parameter.

All four are functional, not presentational. They are here because a visual pass
that redraws these screens without knowing about them will make each one look
more finished than it is.


---

## 9. STALE DOCUMENTS A VISUAL LANE WILL TRIP OVER

Ranked by how badly each would misdirect. All OBSERVED.

| # | File | Stale in what way |
|---|---|---|
| 1 | `docs/DESIGN_LAWS_PROPOSAL.md` | **Not adopted** (says so on line 3), un-audited, and the most attractive law text in the repo. Never cite it. |
| 2 | `docs/shadow-ui/PLATE-CSS-PATCH.md` | Orders a `.png`→`.jpg` swap **that was completed long ago**. Reads as pending work. |
| 3 | `docs/visual-inventory/04-room-coverage.md` | Every room count (40/31/13/9/7/3 = 103; actual 44/34/12/10/7/3 = 110). It is the *ranked order-of-work* doc, so wrong denominators produce a wrong ranking. |
| 4 | `docs/visual-inventory/00-GROK-ORDER-BRIEF.md` | Orders 2, 3 and 5 carry 40 / 31 / "nine" routes. Its #541 section **is** correct. |
| 5 | `design-system/ppbf.css:3480,:3508` | "office 40 routes, floor 31" — **in the law file Grok must re-read before every order.** |
| 6 | `docs/visual-inventory/02-css-drawn.md` | Measured against a 3,498-line sheet; it is 3,575 now. Its *doctrine* — 104 of 110 constructs are drawn in CSS deliberately, so the default answer to "should Grok draw this?" is **no** — is correct and citable. |
| 7 | `design-system/manifest.json` | `tokenCounts.total: 101` vs **116** measured. `build-manifest.mjs:58` uses a line-anchored regex and misses 15 tokens that share lines. It is the file advertised for external tool fetch. Fix is a one-line regex change plus a re-run; **do not hand-edit, it is generated.** |
| 8 | `docs/FRONTEND_STYLE_CONTRACT.md` | Says "four voices" (Law 4 names six/seven) and cites `--red-primary`, a token that no longer exists — it is `--safety-locked` now. Otherwise binding and good. |
| 9 | `design-system/README.md` Law 2 | Same dead `--red-primary` reference. |
| 10 | `apps/web/src/design/PAGE_MAP.md` | Self-declared stale; covers 61-65 of 133 routes and redirects readers to `buildingMap.ts`. |
| 11 | `docs/VISUAL_BUILD_MAP.md` | Dated 2026-08-06 against PR #240, "68 routes". Its Layer 1 is now substantially **done** — `.stat`, `.alert--tight`, `.t-data--lg/--xl`, `.stamp--sm`, `.on-plaster`, `.range--kiosk` all ship. Parked per `docs/current/ACTIVE_WORK.md`. |
| 12 | `docs/RETRO_DESIGN_SYSTEM.md` + `USABILITY_SPEC_RETRO.md` | Retro is banner-marked SUPERSEDED with its hexes called dead; the usability spec depends on it and carries **no banner of its own**. |
| 13 | `docs/MOCKUP_TO_REPO_MAP.md` | Division-of-labour half retired 2026-08-22; drift table marked "do not use as a work list". Both halves are banner-marked, so low risk. Its motif→class table is current and useful. |

---

## 10. THE FIRST GROK IMPLEMENTATION BRIEF

See `docs/GROK-FIRST-BRIEF-STORE.md`.
