# Athlete Workspace — Delivery Ledger

Per-slice delivery state for the athlete workspace program. One slice at a
time: implement, test, review, PR, merge, deploy that exact SHA to staging,
verify against the deployed revision, record, continue.

**This file is not a source of truth above GitHub or staging.** Every row
cites the PR, SHA or run that proves it. If this file and remote evidence
disagree, **remote wins** and the row is corrected explicitly rather than
quietly.

**Release state lives elsewhere.** Deployed SHAs and image digests come from
live evidence (`AGENT_KERNEL.md`, "Your lane's state is not the system's
state"). `docs/current/AI_RELEASE_CONTROL.md`, which this line used to name,
was retired on 2026-09-21. This file tracks slice progress; SHAs are not
duplicated here, because two copies of a SHA are two things that can drift
apart.

**This file went stale once and cost a day.** Between 2026-08-26 and
2026-09-24 nobody updated it, while eight PRs landed against the surfaces it
tracks. By the end it described five merged PRs as open and called seven
slices `NOT_STARTED` that other work had already half-built. A reader
following its own "resume at the first slice that is not `STAGED_VERIFIED`"
instruction would have rebuilt working code. The reconciliation below is the
correction; the lesson is that a row nobody touches is a row that lies.

## Status vocabulary

| Status | Means |
|---|---|
| `NOT_STARTED` | No branch, no PR, no code. |
| `ACTIVE` | Being implemented now. At most one slice may be here. |
| `PR_GREEN` | PR open, CI green, not merged. |
| `MERGED` | On `main`. Not yet proven on a deployed revision. |
| `STAGED_VERIFIED` | The exact merged SHA was deployed to staging AND passed the slice's own authenticated verification. |
| `BLOCKED` | Cannot proceed. The blocker is named in the row. |
| `PARTIAL_BY_OTHER_WORK` | **Added 2026-09-24.** Nobody opened this slice, but PRs from other lanes have satisfied part of its requirement. The row names what is discharged and what concretely remains. |

`PARTIAL_BY_OTHER_WORK` exists because `NOT_STARTED` was actively misleading
on seven rows. A slice nobody opened is not the same as a slice nothing has
touched, and the difference decides whether the next session builds or
rebuilds.

`STAGED_VERIFIED` is only ever set from a run whose **step list** was read, not
from a job conclusion. A step conditioned on a workflow input inherits an
implicit `success()`, so an earlier failure **skips** later steps silently — a
skipped safeguarding probe and a passing one look identical in the run summary.
See `AGENT_KERNEL.md`.

## Resuming after a context reset

1. Read this file.
2. Verify its last recorded SHA against GitHub and against the deployed staging
   revision.
3. Resume at the first slice that is not `STAGED_VERIFIED`. **Read its
   "Remains" list first** — on a `PARTIAL_BY_OTHER_WORK` row most of the slice
   may already exist, and the remaining items are the work.
4. Do **not** restart a completed slice. A later change that touches an earlier
   slice's dependency re-runs that slice's focused tests only; it does not
   reopen its implementation.
5. If this file's newest reconciliation date is more than a couple of weeks
   old, treat every row as a lead rather than a fact and re-check against
   `origin/main` before building.

## Reconciliation of 2026-09-24

Baseline: `origin/main` at `a1506d2e` (merge of #961). Every slice row below
was re-derived from the code on that SHA and from live PR state, not from the
previous contents of this file.

**Provenance, stated plainly.** The reconciliation was produced by ten
parallel read-only workers, one per slice, each required to cite `file:line`,
a PR number or command output for every claim. Their findings are recorded
here as they were returned. Three were independently re-verified by hand
before this file was written, and are marked **[re-verified]** in the rows
below; the rest are single-pass and carry their citation so the next reader
can check cheaply. No worker edited any file — `git status --porcelain` was
empty afterwards.

**Result: 0 slices satisfied, 9 partially satisfied, 1 still required.**

### What had shipped since this file was last touched

Every PR the program-context table below calls unmerged has merged, and a
whole finishing pass landed that this file never recorded:

| PR | What | Merged |
|---|---|---|
| #675 | SHADOW answers become readable | `3f6a589d` |
| #676 | Operations hub stops being a door every role is shown | `aff10dbf` |
| #682 | "PIN Management" was locking athletes out | `4409f3ab` |
| #684 | An athlete could rate-limit themselves out of activation | `26e72b70` |
| #685 | Every athlete-facing screen still described the retired shared PIN | `6c30ae1b` |
| #810 | Athlete wellness check-in: the panel that writes what it collects | — |
| #946 | A-FIN-04, athlete Floor shows real coach-assigned work | — |
| #947 | A-FIN-05, honest post-session RPE | — |
| #948 | A-FIN-03, coach wellness read | — |
| #951 | A-FIN-06, coach cancels assigned work | — |
| #957 | A-FIN-03R1, same-org coach/admin read | — |
| #959 | A-FIN-01, honest pre-session input | — |

### Runtime evidence recorded 2026-09-24

Driven through the real UI on staging build `a1506d2e`, signed in as a real
coach and a real athlete (owner entered both credentials). This is the first
authenticated rendered-product evidence any slice in this program has outside
Slice 1's gate run:

- Coach cancel: two-step confirm, **zero** network writes on the first click,
  exactly one `POST /api/pilot/progression/assignments/cancel` on the second,
  state persisted across a full reload, the prior completion row survived.
- Coach wellness read: one `GET /api/pilot/coach/athlete-check-in` fired only
  after the roster click; three answered values rendered with the athlete's own
  wording and six skipped ones as "Not reported"; the athlete's note round-trips
  verbatim under "Self-reported by the athlete."
- Athlete: no readiness slider on the Dashboard, Wellness or Floor views; a
  check-in with a deliberately empty note renders as "No notes on this one."
  rather than as athlete-authored text; a check-out with effort unanswered
  renders "effort not recorded", distinct from a stored `effort 0 of 10`.

This evidence covers parts of Slices 3, 4 and 9 and does **not** meet the
`STAGED_VERIFIED` bar for any of them: that bar is the slice's *own*
authenticated verification, and no slice-specific check was run.

## Program context at start (2026-08-26) — historical

Kept for provenance. **Its "State" column is out of date; see the table
above.** The audit reference was `main` at `e8b663cf`. Two merges landed after
it and before this program began, so `e8b663cf` was already stale as a
baseline:

- `bdb51f57` — #679, agent environment facts in `AGENT_KERNEL.md` (docs only).
- `393b5a81` — #678, the SHADOW staging gate repair. **This is Slice 1's core.**

Work in flight that this program was told to integrate rather than duplicate:
#675 (SHADOW readability, became Slice 7), #676 (Operations access, became part
of Slice 8), and two prompts with no code at all — expandable Floor cards and
Goals (became Slice 9), activation handoff (became Slice 2). All of #675, #676,
#677, #680 and #671 have since merged.

## Slices

### Slice 1 — Repair the SHADOW activation gate

- **Status:** `STAGED_VERIFIED` — all fourteen requirements met and proven on a
  deployed revision. Unchanged by the 2026-09-24 reconciliation.
- **Baseline SHA:** `e8b663cf`
- **PR:** #678 (merged `393b5a81`), #680 (merged `9830aa46`, gap closure from
  its own adversarial review)
- **Merged SHA:** `9830aa46`
- **Staging SHA:** `9830aa46` — run 33006244055, read from the **step list**:
  step 23 `Run SHADOW E2E Gate` success over a real 2m52s; step 24
  `Guardian Contact Runtime Probe` success; step 26 `Deactivate Gate Athlete
  Fixture` success; step 27 `Report Gate Athlete Fixture Still Live` skipped,
  which is the passing outcome because its condition names `always()`.
- **Standing caveat added 2026-09-24:** the gate this slice repaired has been
  dispatched with `enable_shadow_gate=false` on every staging deploy since
  2026-09-09. The repair holds; it simply has not run since. See Slice 11.

### Slice 2 — Activation and onboarding handoff

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `ACTIVE`. Nearly all of it merged.
- **Discharged:** #682 (`4409f3ab`), #684 (`26e72b70`), #685 (`6c30ae1b`), all
  merged 2026-08-26. `/admin/pin` now posts `account_id` only, reads back
  `activation_code`, and throws rather than reporting a success it did not get
  (`app/admin/pin/page.tsx:99-127`). The `startsWith('PIN')` prefix bug is gone
  from both call sites — client tests the machine code
  (`app/activate/page.tsx:153`), server discriminates on
  `error instanceof ValidationError` (`app/api/pilot/auth/activate/route.ts:104`).
  `must_change_pin` is cleared on redeem (`activation.ts:329-338`).
  `/athlete/sign-in` links to `/activate` (`page.tsx:203`). `/activate` renders
  `PIN_RULE_SUMMARY` generated from the policy itself rather than "6 numbers".
  `/admin/activation-codes` has both Copy and `role="status" aria-live="polite"`.
  **The e2e hole this row recorded as "no e2e touches activation at all" is
  closed**: `e2e/activation-journey.spec.ts`, 173 lines, 5 tests, wired into CI.
- **Remains — SMALL:**
  - No Copy button on `/admin/pin`'s one-time code (`page.tsx:353-384`; the only
    `navigator.clipboard` in `app/` is `admin/activation-codes`). The admin
    transcribes a code by eye.
  - No Copy button **and no live region** on `/admin/people`'s one-time code
    panel (`page.tsx:907-942`) — which is the surface `/admin/organizations`
    now sends new gyms to (`organizations/page.tsx:447`).
  - Print exists on no activation-code surface. A code comment at
    `admin/activation-codes/page.tsx:281-285` gives a builder's reason for
    omitting it; that is not a recorded owner decision.
  - Dead code: `resetAccountPin` (`auth.ts:489`) and `activateAccountPin`
    (`:573`) are exported with no non-test callers, and are still the only
    functions that set `must_change_pin = true`.
  - No staging verification of activation. The activation e2e stubs the API.

### Slice 3 — Atomic session start and current Floor plan

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `NOT_STARTED`.
- **Requirement basis:** no definition exists in the repo; inferred from the
  title and the behaviour the code says it replaced.
- **Discharged:** check-in is now exactly one write (`AthleteWorkspace.tsx:1557`)
  — #946 removed the second one along with the plan generator. The server write
  is a single guarded statement, `INSERT ... ON CONFLICT DO NOTHING` raising
  `ConflictError` rather than overwriting (`entities.ts:220-242`). Nothing shows
  as started unless the server stored it (`:1579-1590`). The open session is
  re-read from the server on every load, not held in the tab (`:1251-1305`).
  The Floor reads real coach-assigned work and never renders an empty floor on
  a failed read (`:2487-2503`).
- **Remains — MEDIUM:**
  - **No guard against a second open session for one athlete.** `pilot.sessions`
    has only a PK on `(organization_id, session_id)`
    (`infra/azure/pilot_slice_postgres.sql:91-103`); no partial unique index on
    an open session exists.
  - Reachable path to that duplicate: on a failed session-list read the Session
    Log withholds its button (`:2274-2288`) but the Today card still offers
    "Start check-in", gated only on `activeSessionRecord ? null :` (`:2048-2056`).
  - `session_id` is minted in the browser as `session_${Date.now()}` (`:1543`),
    so two athletes in one organization checking in within the same millisecond
    collide and the second is refused.
  - No browser-level proof: no e2e spec references check-in or check-out.
  - Dead surface still mounted: `/api/pilot/floor-plans` still reads and writes
    `pilot.athlete_floor_plans` for three roles with no caller.

### Slice 4 — Notes and checkout

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `NOT_STARTED`. A-FIN-01, A-FIN-05
  and A-FIN-08 landed most of it. Reconciled against main 2026-09-26; the
  entry below replaced one that had gone materially false (see *What this
  entry used to say*).
- **Discharged:** an empty pre-session note stores one fixed system placeholder
  that is recognised on the way back, so it never reads as the athlete's own
  words (A-FIN-01; `sessionNoteSemantics.ts:55`). Check-out is the only writer
  of session RPE and records `null` / `UNKNOWN` when the athlete skips the
  question, never a default (A-FIN-05). A-FIN-08 (#973, merged as
  `dc787dd1`) added the rest: the notes box is a PRIVATE DRAFT and nothing
  reaches a coach until the athlete deliberately shares it
  (`AthleteWorkspace.tsx:1396`, `:1454-1455`); withdrawal is explicit and
  stores the no-note sentinel rather than an empty string, so the coach's view
  empties with no schema change (`:1455`); check-in creates the session holding
  the sentinel and never publishes the draft (`:1635`), and check-out replays
  the last SHARED value rather than reading the box (`:1764`). A coach or
  admin in the athlete's own organization reads today's note through a
  dedicated route gated on organization membership
  (`app/api/pilot/coach/athlete-session-note/route.ts:53`, `:62`), and can
  re-read the selected athlete's current state without switching athletes
  (`CoachWorkspace.tsx:3516`) — so a withdrawal reaches a screen already open.
  "Today" is the gym's day taken from `created_at`, not the UTC `date` column
  (`sessionNotes.ts:89`), and the athlete's own active-session selection uses
  the same reduction, so a prior-gym-day open session is no longer mistaken
  for today's (`AthleteWorkspace.tsx:1326`). The linked-guardian passbook omits
  `sessions.notes` entirely — absent, not null (`passbook.ts:341`, `:464`).
  System note forms are suppressed for every reader server-side. No surface
  names a writer: the row records no author and coach and `organization_admin`
  can write it too (`CoachWorkspace.tsx:749`). Owner decisions
  OD-2026-09-25-001 and OD-2026-09-25-003 record the rules; #974 landed them
  first as `5bc72a31`.
- **Evidence:** 9 suites / 476 tests, typecheck and eslint clean, and a
  permanent mutation matrix A/B/C/D/E/F/G1/G2/H, every mutant RED as declared.
  UNIT level. The read's SQL has never executed against Postgres and no
  authenticated journey has run, so this is merged-and-unit-proven, NOT
  staging-verified.
- **Remains — MEDIUM:**
  - **`rpe_method` has no reader.** `contracts.ts:79` says "Read this field
    only alongside `rpe_method`"; `performanceAnalytics.ts:117` averages every
    `pilot.sessions` row with no method predicate and renders it as "Avg RPE".
    Pre-migration rows carry the old pre-session readiness value under
    `UNKNOWN`, so that number averages two different measurements and labels
    them as one. This is the next slice (A-FIN-09).
  - No e2e covers the Session Log / check-out path at all.
  - Check-out records no duration or end time, so SHADOW Session Load cannot be
    computed. Whether that belongs here or to a SHADOW slice is an OPEN SCOPING
    CALL, not pre-authorized work.
  - A session nobody checks out of still remains open in storage indefinitely.
    A-FIN-08 stopped a prior-gym-day row being selected as today's active
    session, so it no longer blocks today's check-in through that client path,
    but nothing closes it. Auto-close is NOT required here; it remains a
    separate product decision.
- **What this entry used to say, and why it was wrong.** It listed "the note
  never reaches a coach" as the headline remaining item, cited the 1200ms
  autosave debounce as discharged behaviour, and said a stale open session
  blocks the next day's check-in. A-FIN-08 closed the first, deliberately
  removed the second — a box that published itself would put half-typed
  sentences in front of a coach — and changed the third. The lines are recorded
  here rather than silently deleted, because this file is what a later session
  resumes from, and a work list that is confidently false is worse than one
  that is merely incomplete.

### Slice 5 — Sparring integrity

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `NOT_STARTED`.
- **Discharged:** integrity work reached this surface through other PRs rather
  than through a Slice 5 branch; the log writes real observations through the
  formulas API.
- **Remains — MEDIUM, and the first item is the largest:**
  - **An athlete can never see a sparring session again after saving it.** The
    only athlete-side callers of the observations API are writers.
  - No correction path. The server supports `supersedesObservationId` and
    recalculates dependent formulas (`route.ts:106-108`, `:205-212`), but the
    page never sends it, so a wrong punch count is permanent.
  - A retry after a lost response writes a **second** session: `contextId` is
    `sparring_${Date.now()}` regenerated per submit (`page.tsx:263`), and the
    idempotency key derives from it.
  - Contact rounds are overstated by construction: the form's `rounds` field is
    *total* session rounds but is sent as `contact_rounds` whenever
    `contactLevel > 0` (`page.tsx:72`, acknowledged in its own comment at `:61-63`).
  - Every session is dated at submission time (`page.tsx:264`), so one logged the
    next morning is filed the next morning, skewing every exposure window.
  - The entry card still tells the athlete "Your coach reads it."
    (`AthleteWorkspace.tsx:3367`) — copy #612 corrected elsewhere and missed here.
  - The nav advertises the page to roles the page refuses
    (`buildingMap.ts:314` marks it `OPEN`).
  - No e2e proves a sparring session saves.

### Slice 6 — Pain-report integrity

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `NOT_STARTED`. **Next build, owner
  decision 2026-09-24.**
- **Discharged:** pain reporting is built end to end and a coach really can read
  a child's report back.
- **Remains — MEDIUM:**
  - **[re-verified] The athlete's own form fabricates their answer — the exact
    defect class A-FIN-01 removed.** `currentPainType` defaults to `'Dull'`
    (`AthleteWorkspace.tsx:668`) and `currentPainSeverity` to `3` (`:669`); the
    type select at `:3383-3387` has no empty option and the severity control at
    `:3392` is an `input type="range"` pre-set to 3, displaying `3/10`. Before a
    child touches anything the form has already said "Dull, 3 out of 10" on
    their behalf, on the most safeguarding-relevant input in the product.
  - **[re-verified] The failure message is drawn behind the still-open modal.**
    The catch at `:1814-1817` sets `painSaveMessage` but never closes the modal,
    and that message renders at `:2249-2251` underneath the modal's
    `fixed inset-0 … z-50` scrim. A failed pain save looks like nothing happened.
  - Contradictory lines on one card when a 200 body does not parse:
    `setInjuryFlag(true)` at `:1795` runs on any `response.ok`, before the
    `coachNotified` branch at `:1809-1811`.
  - The retry is not idempotent, contrary to what the server documents:
    `pain_${Date.now()}` is regenerated per invocation (`:1737`) and used as both
    `contextId` and `idempotencyKey`.
  - The card's own history is local-only — `painLog` starts `[]` and nothing
    loads it, so "Last report: …" is gone after a reload.
  - A pain report is not tied to a session, although the workspace holds one.
  - No e2e covers an athlete filing a pain report.

### Slice 7 — SHADOW and communication truthfulness

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `NOT_STARTED`.
- **Discharged:** #675 merged `3f6a589d` on 2026-08-27, the day after this file
  was written. The athlete "Message Coach" panel that overclaimed reaching a
  coach was already honest before it.
- **Remains — MEDIUM:**
  - **The e2e gap this row itself flagged is still open**, confirmed by *running*
    `classifyPaths` from `scripts/ci-classify-paths.mjs` rather than reading it:
    the SHADOW page maps to no e2e suite.
  - No e2e spec for the SHADOW chat page exists at all.
  - No staging verification of anything on the SHADOW surface.
  - Candidates from #675's own declared follow-ons, not assigned to this slice:
    `pilot.shadow_feedback` has no `reason_code` column; reopening a conversation
    re-offers the rating form on an already-rated answer
    (`shadowSessions.ts:464` vs `shadow/page.tsx:1691`); the readable renderer
    reaches exactly one screen.

### Slice 8 — Athlete Schedule and access

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `NOT_STARTED`.
- **Discharged:** #676 merged `aff10dbf`. The Operations hub is hidden from every
  role that may not use it and its links agree.
- **Remains — SMALL:**
  - **The slice's own stated requirement is unmet: there is no server-side
    refusal of `/operations`.** `app/operations/page.tsx:1` is `'use client'` and
    its default export at `:211` is not async and calls no guard. This row's
    original wording — "Hidden navigation is not authorization — the server-side
    refusal is the requirement" — still stands unsatisfied.
  - The mechanism already exists and is used ten times elsewhere:
    `requirePageRole` (`src/server/pilot/pageGuard.ts:57`). Applying it here needs
    one typing bridge between `ClubRole` and `PilotRole`, not a policy decision.
  - No test proves a real server refusal — the existing refusal tests stub the
    session endpoint (`e2e/coach-journey.spec.ts:510`).
  - **The "Athlete Schedule" half of this slice has no requirement recorded
    anywhere.** Searching every doc on `origin/main` returns the slice title and
    nothing else. That is a gap in the specification, not in the code, and needs
    an owner decision before it can be built or closed.

### Slice 9 — Floor and Goal usability and lifecycle

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `NOT_STARTED`.
- **Discharged:** an athlete can open a Floor card's drill and log it — that half
  was rebuilt by #946 and works, though by deep link to the progression page
  rather than by expanding the card. A goal can be created and progress reported.
- **Remains — MEDIUM:**
  - **A SMART goal cannot be edited after creation.** The card renders title,
    category, target date and success metric as static text
    (`AthleteWorkspace.tsx:2746-2801`); the only field ever written back is
    `progressPercent` (`:1480-1489`).
  - **A SMART goal cannot be marked Completed or Paused.** `GoalStatus` allows
    all four states (`:163`) and the badge renders all four (`:443-446`), but
    `statusRaw` is written as the literal `'active'` at creation (`:1435`) and
    never changed.
  - **No goal can be archived or deleted, of either kind.**
    `app/api/pilot/goals/` has no delete route; the data layer exposes only
    `getGoalById`, `upsertGoal`, `getGoalsByAthlete`.
  - An own-words goal cannot be edited or removed either — the personal route
    exports `GET`, `POST`, `PATCH` and nothing else.
  - Open product question, not a defect: whether "expandable Floor cards" is
    satisfied by the deep link. The Floor tab contains no expansion control.
  - No e2e covers athlete goals at all.

### Slice 10 — Video and progression

- **Status:** `PARTIAL_BY_OTHER_WORK` — was `NOT_STARTED`.
- **Discharged:** the progression half is built and honest. The film half works;
  #960 and #961 added in-app camera capture with multi-angle grouping.
- **Remains — MEDIUM:**
  - **Every in-app recorded round reaches the athlete titled `capture.webm`.**
    `coach/video-analysis/capture/page.tsx:314` builds the upload as
    `new File([blob], "capture" + extension)` and sends no title.
  - **The multi-angle grouping #960/#961 just shipped is invisible to the
    athlete.** `camera_view`, `camera_view_id`, `capture_take_id` and
    `recording_session_id` are written at `video/upload/route.ts:217` but
    `video/list/route.ts:66-74` selects none of them.
  - `athlete/video-analysis/page.tsx:191` renders a raw stored enum (`{v.status}`)
    that can only ever be the word "ready" — the same defect this very file
    already fixed for `review_state`.
  - "What SHADOW noticed" shows the athlete raw machine identifiers
    (`page.tsx:221`, labels from `event_name` / `metric_name`).
  - The Floor card claims more than the page delivers (`:3347`).
  - The coach's notes on a video are returned by the API and rendered nowhere.
    Whether an athlete should read them is a product decision.
  - No e2e touches the athlete film surface.
  - Adjacent, coach-side: `/coach/video-analysis/capture` never says a take is
    held, although uploads insert `status 'quarantined'`.

### Slice 11 — Final authenticated staging gate

- **Status:** `STILL_REQUIRED` — was `NOT_STARTED`. The only slice with nothing
  discharged, and the largest.
- **Remains — LARGE:**
  - **[re-verified] The gate is off and has been for every staging deploy since
    2026-09-09.** `Run SHADOW E2E Gate` reports `skipped` on every deploy-staging
    run checked, including `9712ad77`, `1dd0f44c` and `a1506d2e` — the three
    builds carrying the A-FIN work. Stated fairly: each of those dispatches
    specified `enable_shadow_gate=false` deliberately, so this is verification
    debt that was chosen, not a regression that crept in.
  - With the flag off there is **no behavioural verification of staging at all**.
    The last unconditional step is `Wait For New Revision To Take Traffic`
    (`deploy-staging.yml:387-404`), which polls `runningState == Running` and
    `trafficWeight == 100`. A green staging deploy proves the container booted.
  - The gate's content covers none of the athlete surfaces this program shipped:
    grepping `pilot-shadow-intake-gate.mjs` for wellness, rpe, assignment,
    cancel, pre-session, media-consent and capture returns no hits. Adding that
    coverage is script work, not a flag flip.
  - The runtime-verify engine cannot verify the new write paths by construction:
    `scripts/lib/runtime-probe.mjs:96-105` `assertProbeCannotMutate` throws
    before any network call for a non-read-only method, and wellness check-in,
    RPE write and assignment cancel are all POSTs.
  - Playwright cannot be pointed at a deployed environment — `playwright.config.ts:17-18`
    hardcodes `localhost` and `:48-53` starts a local dev server.
  - Playwright cannot reach `/athlete/dashboard` even locally: it is in
    `SERVER_GUARDED_ROUTES` (`e2e/support/signIn.ts:104-111`) because the page
    calls `requirePageRole(['athlete'])`.
  - A green Playwright run says nothing about a deployed server: every spec stubs
    the whole pilot API at the network boundary (`signIn.ts:186-216`).
  - No permanent mechanism for authenticated rendered-product verification of
    staging exists. PR #922 is an explicitly temporary harness, still open.
  - No go/no-go artifact of any kind exists.
  - `docs/current/PRODUCTION_STATE.json` is roughly four weeks stale — it records
    staging at `459aab1d` and production at `47a58832`, both 2026-08-29.
  - **Sequencing premise overtaken — owner question, not a build item.** This row
    has the final gate running once, before production. Production already
    shipped: its deployed SHA `1dd0f44c` contains #946, #947, #948, #951, #957
    and #959. The plan and the practice no longer match, and which one changes
    is the owner's call.
