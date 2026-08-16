# Manual Sign-Off Walkthrough

This is a click-through guide for the 82 modules in
`docs/capabilities/expanded-200-backlog.csv` that are marked `Status=DONE`
but `ManualVerification=PENDING_SIGN_OFF` — built, but never manually
confirmed by the owner. It does not cover the modules already `PASSED` or
still `DRAFT`/`NOT_REQUIRED`.

**How to use it:** for each module, sign in as the named role, do the
action, and check the screen against the falsifiable "Expect" line. If it
matches, the module can move to `PASSED`. If it doesn't, or the route
doesn't exist, that's a real finding for the builder — not a reason to
guess and mark it done anyway.

**What `(unverified)` means:** the route below is my best grounded guess
from reading the actual route table, `buildingMap.ts`, and the module's own
capability doc, but I could not fully confirm the specific behavior claimed
(the exact field, the specific role write-path, or which of two similar
screens is the intended one). Treat these as "check carefully," not
"probably fine."

**What "ROUTE NOT FOUND" means:** I searched the route table
(`apps/web/app/**/page.tsx`), the server modules, and the database
migrations for any trace of the feature the module's own vertical-slice
description claims, and found none. These modules are marked `DONE` in the
tracker with nothing behind them — do not sign off on functionality that
doesn't exist; flag them to the builder instead.

**About 404s:** Module 026 (Intervention Tracking Engine) ships three
Postgres migrations that are registered but **not yet applied** to
staging/production. Its three coach pages may show an absent/empty state
rather than working data until those migrations deploy — that is expected,
not a defect, for now.

---

## Core Athlete System

### 001 — Athlete Profile System
**No UI surface — API-only.** `GET /api/pilot/passbook?athlete_id=...` and
`GET /api/pilot/passbook/gaps` (evidence: `apps/web/src/server/pilot/passbook.ts`,
`apps/web/app/api/pilot/passbook/route.ts`). The module's own doc states
this API is "consumed by no page" today. Evidence to confirm: call the
route directly with a valid session and check for a 200 with athlete data,
or a 403 for board/unlinked-parent sessions.

### 002 — Raw Observation Intake System
**Open:** `/coach/decision-loop`, signed in as **coach** or **admin**.
**Do:** type a free-text note in the "Log Note" panel and submit (this
posts `entity_type=coach_note` to `/api/pilot/intake/domain-upsert`).
**Expect:** "Note logged." confirmation appears; the note is attributed to
the signed-in coach and the athlete on screen.

### 004 — Performance Tracking System **(unverified)**
**Open:** `/athlete/dashboard`, signed in as **athlete**.
**Do:** on the "My Dashboard" tab, set "Readiness to Train" and tap **Check
In**. **Expect:** a new session row is created with `rpe` equal to the
slider value (`POST /api/pilot/sessions`). This module's own capability doc
has no vertical-slice detail beyond "DONE" — the route above is inferred
from the athlete check-in code, not cited in the module's own file, so
confirm this is really what "performance tracking" was meant to cover.

### 005 — Progression Decision System
**Open:** `/coach/progression-intelligence`, signed in as **coach** (admin
is not admitted on this route).
**Do:** find a deterministic gap suggestion and click **Confirm as gap**.
**Expect:** the suggestion becomes a real, stored progression gap; the
page's own copy states "Nothing here reaches an athlete unless you confirm
it as a gap" — an unconfirmed suggestion must never appear to the athlete.

### 006 — Training Assignment System
**Open:** `/coach/drills`, signed in as **coach** or **admin**.
**Do:** create or edit a drill and check an assignment referencing it.
**Expect:** the drill is saved once in the library (`pilot.drill_assignments`
references the canonical drill row); two coaches assigning "the same" drill
by name do not fork two records.

### 007 — Session Builder
**Open:** `/coach/session-scripts`, signed in as **coach** or **admin**.
**Do:** create a new session script/plan.
**Expect:** the plan lists block by block in minutes from the session
start (not clock times), and appears in the coach's session-script list on
reload.

### 009 — Athlete Update System (Self-Report)
**Open:** `/athlete/dashboard`, signed in as **athlete**.
**Do:** adjust sleep hours, energy level, and readiness-to-train, then tap
**Check In**. **Expect:** the readiness band (GREEN ≥7 / YELLOW ≥5 / RED
below) reflects the value you entered, and a new self-reported session is
saved.

### 010 — Development Route System
**ROUTE NOT FOUND — needs builder confirmation.** No code, table, or route
matching "development route" / "routing" (`Parent original-25: 5/7
Routing`) exists beyond the progression-gap confirmation flow already
covered by module 005 and the generic coach dashboard. `/coach/environment
/intake-router` is only a mount point for the coach workspace, not a
distinct routing feature — there is no separate `IntakeRouter` component.

### 012 — Roster / Participation System **(unverified)**
**Open:** `/admin/athletes`, signed in as **admin**.
**Do:** use the name-search box, then open an athlete record and view/edit
`gym_status`. **Expect:** the roster lists the organization's athletes and
`gym_status` (active/training/inactive) is visible and editable per row.
The module doc claims a "gym_status filter" specifically — what actually
exists is a name-search box plus a per-athlete status editor, not a
dedicated status-filter dropdown; confirm which one was intended.

---

## Physical Training System

### 013 — Physical Capacity Engine
**ROUTE NOT FOUND — needs builder confirmation.** No `physical_capacity`
field, table, or note type exists anywhere in the codebase or migrations.

### 014 — Load Management Engine
**ROUTE NOT FOUND — needs builder confirmation.** No weekly-session-count
cap/warning code exists in the scheduler (`schedulerDb.ts`,
`/api/pilot/scheduler/route.ts`) or anywhere else searched.

### 019 — Recovery Engine **(unverified)**
**Open:** `/athlete/dashboard/sparring`. **Note:** this page has no role
gate in code at all today (`buildingMap.ts` marks it `OPEN` deliberately;
there is no `RoleSessionGate`/`requirePageRole` in the file).
**Do:** fill in "Recovery Notes" on the Deep-Track sparring form and
submit. **Expect:** the free-text note is saved with the sparring
observation. This is a free-text field, not the distinct "recovery status
tag" the module doc describes — confirm that's what was meant.

### 020 — Physical Readiness Engine
**Open:** `/coach/performance-analytics`, signed in as **coach** or
**admin**. **Do:** open the roster rollup. **Expect:** average RPE,
readiness count/average, and an early-vs-late trend direction per athlete,
computed from `pilot.sessions` and `pilot.readiness` (fed by the athlete's
own check-ins at `/athlete/dashboard`).

### 022 — Injury-Risk Engine
**ROUTE NOT FOUND — needs builder confirmation.** No injury-risk flag
field, table, or route found anywhere in the codebase.

### 026 — Intervention Tracking Engine
**Open:** `/coach/intervention-protocols`, `/coach/intervention-executions`,
`/coach/intervention-review` — all signed in as **coach** or **admin**.
**Do:** file a protocol, start an execution against it, close it out, link
evidence, and record a three-answer outcome review.
**Expect:** planned-vs-actual exposure shown side by side; no dose,
difficulty, or score field anywhere. **May show an absent state until the
attempts/intervention migrations deploy** (see note at top).

### 027 — Testing / Retest Engine
**No UI surface — API-only.** `GET/POST /api/pilot/data-collection-requests`
(backed by `assessmentProtocols.ts`) exists and is tested, but no page in
`apps/web/app` calls it — the athlete-facing "Assessments" tab on
`/athlete/dashboard` is an unrelated, explicitly unbuilt personality-test
placeholder. Evidence to confirm: call the route directly.

### 028 — Deload / Taper Engine
**ROUTE NOT FOUND — needs builder confirmation.** No deload/taper flag on
a week or session plan exists in `/coach/session-scripts` or anywhere else
searched.

### 034 — Return-to-Training Engine
**ROUTE NOT FOUND — needs builder confirmation.** Module 082's own audit
log states this directly: *"The #34 tracker marks Return-to-Training DONE
with no code behind it — flagged for owner correction."* Independently
confirmed: `pilot.return_to_training_plans`/`_steps` helper functions exist
in `safetyFlags.ts`, but no API route or UI page calls them.

---

## Combat / Boxing System

### 037 — Combat Athlete Engine **(unverified)**
**Open:** `/coach/sports-medicine` ("Clearance Board"), signed in as
**coach** or **admin**. **Do:** view your roster's clearance status.
**Expect:** each athlete shows cleared / restricted / not cleared / pending
— the functional equivalent of "sparring allowed." This page appears
read-only; I could not find where a coach *writes* this status, which the
module doc claims ("coach write") — confirm where clearance is actually
set.

### 039 — Punch Quality / Volume Engine
**Open:** `/athlete/dashboard/sparring` (no role gate in code; sign in as
**athlete** for the intended flow). **Do:** submit the Deep-Track form's
punch fields (type, attempted, landed, absorbed). **Expect:** the
observation is saved; punch-output/accuracy/connect-differential/
offensive-efficiency formulas run server-side and are tested, but **no
screen displays the computed numbers** — the module's own doc says results
UI is future work, so there is nothing to check on screen beyond the save
confirmation.

### 042 — Round Performance Engine
**No UI surface — API-only.** Work-rate-consistency and round-to-round
change formulas are served behind the same role/org-gated formula API as
module 039. The module's own doc states display UI is future work.

### 043 — Contact / Sparring Restriction Engine
**Open:** `/athlete/dashboard/sparring`. **Do:** log a sparring round with
contact for an athlete who has no current medical clearance on file.
**Expect:** the submission still saves, but a safety-review message appears
naming exactly what's missing (the clearance gate's "teaching moment"
text) — refusing to save the log would be the wrong failure mode here.
Coach-side near-miss surfacing: **Open:** `/coach/decision-loop` (coach/
admin) — near-misses and incidents file to the escalation queue.

### 045 — Coach-Controlled Constraint Engine
**Open:** `/admin/escalations`, signed in as **admin** or **coach**, to see
the effects; place/lift itself is **API-only** in v1
(`POST /api/pilot/training-holds`) — there is no UI button for it.
**Do:** as admin/coach, look for an escalation filed when contact occurs
during a covering hold. **Expect:** the escalation references the hold and
its scope; the athlete separately sees a non-punitive banner at
`/athlete/dashboard`. (This is the same underlying `pilot.training_holds`
system as module 082, below.)

---

## Learning / Skill Acquisition

### 054 — Skill Acquisition Engine
**No UI surface — API-only.** A `skill_id` column and filter exist in
`GET /api/pilot/drill-library` (`drillLibraryV3.ts`), but the `/coach/drills`
page itself has no skill filter or tag control exposed to a coach.

### 055 — Retention Tracking Engine
**ROUTE NOT FOUND — needs builder confirmation.** No `last_practiced` /
`practiced_at` field exists anywhere in the codebase or migrations.

### 056 — Mastery Verification Engine
**ROUTE NOT FOUND — needs builder confirmation.** No `mastery` status
field or enum exists anywhere in the codebase or migrations.

---

## Mental / Emotional / Behavioral

### 064 — Emotional Regulation Engine
**ROUTE NOT FOUND — needs builder confirmation.** No emotion/regulation-
specific note type exists. The only nearby mechanism is `/coach/decision-loop`'s
generic free-text "Log Note" (`note_type: 'behavior_standard'`), which is
not emotion-specific and carries no allowlist of its own.

### 065 — Resilience Engine
**ROUTE NOT FOUND — needs builder confirmation.** No resilience check-in
or 1–5 scale field exists anywhere in the codebase or migrations.

### 070 — Discipline / Accountability Engine
**ROUTE NOT FOUND — needs builder confirmation.** No accountability-item
or task-complete flag exists. The Coach Workspace's "Tasks" tab (at
`/coach/environment/intake-router`) is derived from the SHADOW review
queue, not this feature, and is a different thing.

---

## Safety / Recovery / Health

### 082 — Stop / Hold / Regress Engine
**Open:** `/admin/escalations`, signed in as **admin** or **coach**, to see
hold-triggered escalations; the athlete-facing banner is at
`/athlete/dashboard`, signed in as **athlete**. Placing/lifting a hold is
**API-only** in v1 (`POST /api/pilot/training-holds`) — no button exists
for it. **Do:** as admin/coach, look for an escalation filed when contact
is logged during a covering hold. **Expect:** the escalation names the hold
and its scope (`contact_only`/`conditioning_only`/`all_training`); the
athlete's banner is non-punitive and self-contained.

---

## At-Home / Parent / Guardian

### 085 — At-Home Parent/Guardian Task System
**Open:** `/parent/dashboard`, signed in as **parent**, "Parent Floor" and
"Assignments" tabs. **Expect a gap, not a working feature:** the page's own
copy says *"PLANNED | NOT YET IMPLEMENTED — there is no backend feed for
home assignments yet, so this list is always empty,"* and that the
checklist/progress bar previously shown "were hardcoded example data ...
removed rather than left showing fake completion status." This module is
`DONE`/`PENDING_SIGN_OFF` in the tracker but ships no working task feature
on either tab — flag to the builder rather than sign off as functioning.

### 090 — Family Communication Engine
**Open (send):** `/coach/decision-loop`, signed in as **coach** or
**admin** — "Send to Family" panel. **Open (read):** `/parent/dashboard`,
signed in as **parent** — "Messages" tab.
**Do:** as coach, type a message and submit; as parent, open Messages.
**Expect:** coach sees "Sent to the family."; parent's Messages tab lists
it (`GET /api/pilot/parent/messages`, scoped to the guardian's own
children). One-directional only — there is no reply.

### 093 — Parent / Guardian Dashboard
**Open:** `/parent/dashboard` (or `/guardian`), signed in as **parent**.
**Do:** sign in and look at what loads. **Expect:** only your own linked
children appear — never another family's athletes or tasks.

### 095 — Home Barrier Reporting System **(unverified — coach side)**
**Open:** `/parent/dashboard`, signed in as **parent**, "Parent Floor" tab
— "Report a Barrier" (Type = Home). **Do:** describe the barrier and tap
**Send to Coach**. **Expect:** a sent confirmation
(`POST /api/pilot/parent/barrier-report`). I could not find any page that
consumes `GET /api/pilot/coach/barrier-reports` — the coach-side inbox has
a working API but no UI I could locate; confirm with the builder where a
coach is meant to see these.

### 096 — Transportation / Attendance Barrier Tracker **(unverified — coach side)**
Same screen and same caveat as module 095: `/parent/dashboard`, "Report a
Barrier," Type = Transportation. Coach-side viewing surface not found.

---

## Body Composition

### 104 — Bodyweight Tracking
**Open:** `/athlete/dashboard/sparring` (no role gate in code; sign in as
**athlete**). **Do:** enter body weight (kg) on the Deep-Track form.
**Expect:** the weight observation saves; a tested 7-day weight-change
formula runs server-side, but **no screen shows the computed trend** —
the module's own doc says that display is future work.

---

## Coach System

### 111 — Coach Intelligence Engine
**Open:** `/coach/intelligence` ("The Morning Read"), signed in as
**coach** or **admin**. **Do:** open the page. **Expect:** five
deterministic reads listed by urgency — stalled gaps (14d+), 3+ RED
readiness days in the last 7, an attendance half-drop, unreviewed sessions
(7d+), and holds expiring within 14 days. No scores, nothing predictive.

### 113 — Coach Dashboard
**Open:** `/coach/environment/intake-router`, signed in as **coach**
(admin is not admitted on this route). **Do:** sign in. **Expect:** the
Coach Workspace loads — floor plans, open coach reviews, tasks, and
escalations for your roster.

### 114 — Coach Cue Library
**Open:** `/coach/cue-library`, signed in as **coach** or **admin**.
**Do:** search or filter by cue family / focus. **Expect:** cues appear
grouped by family, each attributed to the drill it came from; the page is
read-only — there is no authoring control here (cues are edited on the
drill record itself).

### 116 — Coach Compliance / Integrity Engine **(unverified)**
**Open:** `/admin/compliance-center`, signed in as **admin**. Note: this
page's own gate is admin-only even though the module doc describes
"coach/admin role gates" at the API level — no coach-reachable UI for this
was found. **Do:** open the page. **Expect:** compliance rule violations
listed with severity and an escalation ladder.

### 118 — Coach Review Queue
**Open:** `/coach/review-queue`, signed in as **coach**. **Expect a gap,
not a working queue:** the page itself displays "Planned — Not Yet
Implemented" and states *"Nothing here reads or writes data yet"* — it is a
placeholder with a single link to "Open the Coach Workspace"
(`/coach/environment/intake-router`). This module is `DONE`/
`PENDING_SIGN_OFF` in the tracker but its named route has no queue behind
it; the real triage work lives on the Coach Workspace's Tasks tab instead.

### 119 — Coach Decision Audit **(unverified)**
**Open:** `/coach/decision-loop`, signed in as **coach** or **admin**, to
see live decisions and their recorded outcomes; or `/audit`, signed in as
**admin** or **coach**, for the general per-entity ledger. I could not
confirm a screen that shows "decision audit" as its own distinct view
separate from these two — confirm with the builder which one (or whether a
third page) was intended.

---

## Class / Program Management

### 120 — Class Control Engine
**Open:** `/schedule`, signed in as **coach** or **admin** (athlete/parent
can also open the page to register, but class creation is
coach/admin-only inside it). **Do:** create a class with a title, start/end
time, location, and capacity. **Expect:** the class appears in the list
with seats shown as registered-count / capacity.

### 122 — Attendance Engine
**Open:** `/admin/attendance`, signed in as **admin** or **coach**.
**Do:** open the page. **Expect:** an org-wide (admin) or coach-scoped
attendance summary with an 8-week trend strip.

### 124 — Capacity Management Engine
**Open:** `/schedule`, signed in as **athlete**, **coach**, **parent**, or
**admin**. **Do:** register for a class already at its seat cap.
**Expect:** the registration goes to `status: waitlisted` instead of
overbooking the class. There is no separate capacity console — the module's
own doc says enforcement lives only inside the scheduler.

### 126 — Recognition / Achievement Engine
**Open:** `/coach/recognition`, signed in as **coach** or **admin**.
**Do:** award a milestone to an athlete. **Expect:** the milestone is
recorded and later visible on the athlete's record; no ranking or
leaderboard appears anywhere (the platform has no athlete ranks, by
design).

---

## Data Quality / Trust

### 130 — Evidence Quality Engine
**Open:** `/evidence`, signed in as **admin** or **platform_owner**.
**Do:** view a pending document. **Expect:** ingest state and indexed-chunk
count are shown; if extraction failed, a "Cannot Approve" stamp with the
reason appears and blocks approval.

### 131 — Confidence Score Engine
**No UI surface — API-only.** `confidenceFor()` attaches a
HIGH/MODERATE/LOW/INSUFFICIENT confidence state to formula results (e.g.
the punch/round formulas from modules 039/042), but since those formulas
have no results-display screen yet, the confidence label is not shown
anywhere either.

### 132 — Missing Data Engine
**Open:** `/admin/athletes`, signed in as **admin**. **Do:** submit the
create-athlete form with a required field left blank. **Expect:** an
explicit named-field error message, not a generic failure or a raw 500.

### 133 — Source Reliability Engine
**Open:** `/research/chat` (no role gate — open to any signed-in session).
**Do:** ask a research question that returns a cited source. **Expect:**
each citation shows "(tier N)" — the source's `authority_tier` — next to
the source title.

### 134 — Duplicate Detection Engine
**Open:** `/admin/data-quality`, signed in as **admin**. **Do:** open the
page. **Expect:** guardian-record duplicate findings listed with masked
emails and athlete ids only, report-only — no merge button anywhere on the
page.

### 135 — Uncertainty Tagging Engine
**No UI surface — API-only.** `AttributionCertainty`
(stated/probable/uncertain) feeds the research-pattern promotion gate. The
module's own doc says an app-visible surface is future work — confirmed:
no page shows it.

### 136 — Version / Source Status Engine
**Open:** `/evidence`, signed in as **admin** or **platform_owner**.
**Do:** view any listed source. **Expect:** its status, approval state,
and verification state are all shown together (e.g. "approved / verified").

### 137 — Audit Trail / Decision History
**Open:** `/audit`, signed in as **admin** or **coach**. **Do:** look up a
specific entity id (e.g. a review or an athlete update). **Expect:** the
chronological audit events already written for that entity appear.

### 139 — Approval Gate Engine
**Open:** `/evidence`, signed in as **admin** or **platform_owner**.
**Do:** click **Approve + verify** or **Reject** on a pending source or
document. **Expect:** the state transitions from `pending_review` to
`approved`/`rejected` immediately, with a "Rejected" stamp appearing on
reject.

---

## Governance / Admin / Nonprofit

### 141 — Human Approval System
**Open:** `/evidence`, signed in as **admin** or **platform_owner**.
**Do:** same Approve/Reject controls as module 139. **Expect:** the same
behavior — this module names the human-facing UI for the mechanism module
139 defines; they are the same screen.

### 142 — Role Permission System
**No UI surface — API-only.** `requireRole()`/`isOrganizationAdminRole()`
are the central primitives nearly every API route calls; there is no
dedicated screen. Evidence to confirm: any role-mismatched request against
a gated route returns 403.

### 144 — Change Log System
**Open:** `/audit`, signed in as **admin** or **coach**. **Do:** open the
page without filtering to one entity. **Expect:** the live audit-events
feed renders (`POST /api/pilot/audit/get`) — this is the same page as
module 137, viewed as a general feed instead of a per-entity lookup.

### 145 — File Status / Promotion System
**Open:** `/source-control/publication-workflow` (no role gate — open to
any signed-in session). **Do:** view the pipeline banner. **Expect:** the
current publication stage is shown (draft/pending_review/approved/
published/rejected/archived/retracted).

### 146 — Grant / Nonprofit Impact Engine
**Open:** `/admin/grants`, signed in as **admin**. **Do:** open the page.
**Expect:** funder obligations and reporting deadlines listed, soonest due
first.

### 147 — Board Reporting Engine
**Open:** `/board`, signed in as **board** or **platform_owner**. Note:
`/board/page.tsx` itself carries no visible role gate — access control, if
any, happens inside `BoardSummaryPanel`/`BoardSeatDirectory` or the API
they call. **Do:** open the hub. **Expect:** aggregate tiles only; any
count too small to show safely reads "Suppressed" rather than an exact
number (k-anonymity), and no athlete identifiers appear anywhere on the
page. The module's own manual sign-off checklist is still fully unchecked
in its capability doc — this module has not actually been reviewed by
its own record either.

### 148 — Program Outcome Reporting **(unverified)**
**Open:** `/admin/platform/overview`, signed in as **platform_owner**
(gated in-page by a Microsoft-session + `platform_owner` check, not by
`RoleSessionGate`). This route is not listed in `buildingMap.ts`, so it may
be reachable only by typing the URL directly. **Do:** open the page.
**Expect:** per-gym `activeAthletes` and `trainingSessions30Days` counts.

### 149 — Donor-Safe Reporting Engine **(unverified)**
No dedicated "donor-safe" stripping code was found anywhere in the
codebase. The closest real mechanism is `/board`'s k-anonymity suppression
in `BoardSummaryPanel` (see module 147). The module's own manual checklist
is entirely unchecked. **Recommend the builder confirm which surface, if
any, this module actually refers to before sign-off.**

### 150 — Privacy / Sensitive Data Boundary Engine **(unverified)**
Closest evidence found: the platform-wide feedback box
(`apps/web/components/FeedbackBox.tsx`, in the global header on every
signed-in page) enforces `FEEDBACK_BODY_MAX_LENGTH` (4000) and
`FEEDBACK_NOTE_MAX_LENGTH` (2000), rejecting oversized text. The module
doc's own example ("athlete update notes, review notes") points at a
different write path that I could not locate, and its manual checklist is
unchecked. Confirm with the builder which write path this covers.

### 151 — Consent / Waiver Tracker
**Open:** `/admin/consent`, signed in as **admin** or **coach**. **Do:**
record a waiver/consent signature for an athlete. **Expect:** the flag
(and date, if recorded) persists and is visible on reopening the athlete's
record.

### 152 — Incident Report Engine
**Open:** `/coach/decision-loop`, signed in as **coach** or **admin**.
**Do:** fill "Report Incident" (description, severity, occurred-at) and
submit. **Expect:** "Incident filed -- it is now in the escalation queue."
confirmation appears (`POST /api/pilot/incidents`).

### 153 — Compliance Checklist Engine
**Open:** `/admin/compliance-center`, signed in as **admin**. **Do:** open
the page. **Expect:** compliance checklist items and violations are
listed — this is the same screen as module 116 above.

### 201 — Gear Vendor Records
**Open:** `/admin/gear/vendors`, signed in as **admin**. **Do:** add a
vendor (account number, discount tier, terms, rep contact). **Expect:** the
vendor saves and appears on the vendor picker at `/admin/gear`; the public
`/store/[organizationId]` page shows only the product's **brand**, never
the vendor account; there is no field anywhere for a supplier password (the
migration itself refuses to apply if one ever appears on the table). **The
underlying migration has not been applied to any environment yet** — this
may 404 or show no data until it deploys.

---

## AI / Automation Support

### 154 — AI Assistant Layer **(unverified)**
Closest real surface: the "Ask SHADOW" tab present in `/athlete/dashboard`,
`/coach/environment/intake-router`, and `/parent/dashboard` (the shared
`RoleSpecificShadow` chat component). The module's own vertical-slice line
— "AI assist route returns draft text only" — does not precisely match a
conversational chat UI, so treat this mapping as provisional and confirm
with the builder which surface was actually meant.

### 164 — No-Autonomous-Approval Guardrail
**No UI surface.** This is a backend invariant, not a screen: AI-drafted
text is never allowed to set an `approved_flag` or a final decision.
Evidence to confirm: try to get the SHADOW chat or any AI-backed route to
set an approval directly, and confirm it refuses or simply offers no such
control.

---

## Dashboards / Reporting

### 165 — Athlete Dashboard
**Open:** `/athlete/dashboard`, signed in as **athlete**. **Do:** sign in.
**Expect:** the dashboard loads your own session and goal counts only —
never another athlete's.

### 166 — Coach Dashboard
**Open:** `/coach/environment/intake-router`, signed in as **coach**
(same route and gate as module 113). **Do:** sign in. **Expect:** open
coach-review count and assigned-athlete count appear on the dashboard tab.

### 167 — Parent / Guardian Dashboard
**Open:** `/parent/dashboard`, signed in as **parent** (same route as
module 093). **Do:** sign in. **Expect:** linked children only.

### 168 — Admin Dashboard
**Open:** `/admin`, signed in as **admin** or **platform_owner**. **Do:**
sign in. **Expect:** roster count and open compliance-item counts appear
on the landing page.

### 169 — Readiness Dashboard
**Open:** `/coach/environment/intake-router`, signed in as **coach**.
**Do:** view the roster. **Expect:** each athlete's roster dot is colored
by their latest *fresh* (within 24h) readiness check-in
(GREEN/YELLOW/RED); an athlete with no fresh reading shows as unknown —
never a default color.

### 170 — Safety Dashboard
**Open:** `/admin/safety-flags`, signed in as **admin** or **coach**.
**Do:** open the page. **Expect:** open flags listed worst-severity-first
with counts; resolving a flag requires typing a note; a flag from an
external rule never offers a bypass control.

### 171 — Progression Dashboard
**Open:** `/coach/progression-intelligence`, signed in as **coach**.
**Do:** open the page. **Expect:** deterministic gap suggestions,
already-confirmed gaps, and assignment-completion status all shown
together (same screen as module 005).

### 172 — Performance Trend Dashboard
**Open:** `/coach/performance-analytics`, signed in as **coach** or
**admin**. **Do:** open the page. **Expect:** RPE/readiness/training-day
rollups with an early-vs-late trend direction per athlete (same screen as
module 020).

### 173 — Attendance Dashboard
**Open:** `/admin/attendance`, signed in as **admin** or **coach**.
**Do:** open the page. **Expect:** org-wide + coach-scoped attendance
summary with an 8-week trend strip (same screen as module 122).

---

## Strongest Additions Now

### 194 — Red Flag Escalation Protocol
**Open:** `/admin/escalations`, signed in as **admin** or **coach**.
**Do:** open the page. **Expect:** safety, near-miss, and pain-report
escalations listed — this is the only place they surface in the app.

### 198 — Athlete Voice Module
**Open (submit):** any page, signed in as **athlete** — use the feedback
box in the global header. **Open (triage):** `/admin/escalations`, signed
in as **admin only** (never coach). **Do:** as athlete, submit feedback
naming a safeguarding concern; as admin, check escalations. **Expect:** an
"Athlete Voice" row appears pointing to the safeguarding triage queue, and
never appears to a coach; the athlete's own submit confirmation looks
identical whether or not the submission was flagged (oracle-safe by
design).

### 200 — Privacy-Tier System
**No UI surface — API-only / code registry.** This module is a set of
type and constant definitions (`FIELD_TIERS`,
`PUBLIC_SURFACE_FORBIDDEN_TABLES`, etc. in `privacyTiers.ts`) with no
runtime enforcement of its own — enforcement lives in the modules named per
registry entry. Evidence to confirm: read `privacyTiers.ts` and its drift
tests directly; there is no screen to click through.

---

## Gaps — ROUTE NOT FOUND, needs builder confirmation

These 11 modules are marked `DONE`/`PENDING_SIGN_OFF` in the tracker, but I
found no code, table, route, or page anywhere in the repository matching
what the module's own vertical-slice description claims:

| Module | Name | Claimed slice |
|---|---|---|
| 010 | Development Route System | "5/7 Routing" |
| 013 | Physical Capacity Engine | physical capacity note field |
| 014 | Load Management Engine | weekly session count cap warning |
| 022 | Injury-Risk Engine | injury-risk flag, coach-set |
| 028 | Deload / Taper Engine | deload flag on week/session plan |
| 034 | Return-to-Training Engine | return-to-training flag after gate clear (module 082's own audit log independently confirms this: "DONE with no code behind it") |
| 055 | Retention Tracking Engine | last-practiced date on skill/assignment |
| 056 | Mastery Verification Engine | mastery status enum, coach-set |
| 064 | Emotional Regulation Engine | emotion/regulation note tag allowlist |
| 065 | Resilience Engine | resilience check-in, 1–5 scale |
| 070 | Discipline / Accountability Engine | accountability item complete flag |

Two further modules have a real route but the route itself is an explicit,
labeled placeholder rather than working functionality — these are not in
the table above because a route does exist, but they belong in the same
conversation with the builder:

- **085 — At-Home Parent/Guardian Task System**: `/parent/dashboard`
  renders "PLANNED | NOT YET IMPLEMENTED" on both the barrier-report tab's
  task list and the Assignments tab.
- **118 — Coach Review Queue**: `/coach/review-queue` renders "Planned —
  Not Yet Implemented" and links out to the Coach Workspace instead of
  showing a queue.
