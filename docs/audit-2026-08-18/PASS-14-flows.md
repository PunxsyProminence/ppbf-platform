# PASS 14 — Role journeys & flow, end to end

Audit date: 2026-08-18. Branch: `docs/full-spectrum-audit-2026-08-18`. Read-only pass.

## Method

Every other pass in this audit checked components in isolation. This pass traces
**whole role journeys** — UI entry point -> API route -> domain module -> database
write -> and back out to every screen that reads the resulting state. The question
is not "is this function correct" but **"can the role finish the job, and is every
downstream gate that depends on this journey's output actually fed?"**

Procedure per journey:

1. Find the UI entry point (page/component) the role starts from.
2. Follow the request to its API route handler.
3. Follow the handler into the domain module(s) that own the state change.
4. Read the persistence layer / schema for what fields are actually set.
5. Then invert: `grep` for every *reader* of those fields, and check whether the
   journey set what each reader assumes.
6. Try to refute the finding before writing it (look for a second enforcement
   point, a DB constraint, a cron/backfill, a UI guard) and record the refutation
   attempt.

Verdicts used:

- **complete** — role can finish; downstream gates fed.
- **broken** — role cannot finish, or an error surfaces.
- **silently incomplete** — the journey *appears* to succeed, returns success to
  the actor, but leaves state unset that a later gate depends on. Most valuable
  verdict here; called out explicitly.

Severity: HIGH+ reserved for journeys where a break means **a child's safety
state is wrong, or a guardian is actively misinformed**. Everything else MEDIUM
or below regardless of engineering ugliness.

Rules followed: every finding carries a verbatim quote plus `path:line`; no gap
filling — where tracing stopped, that is stated with the reason; no real names,
PINs or secrets reproduced.

> Written incrementally. Journeys appear below in the order traced. If a journey
> heading exists with no verdict, the trace was not finished.

---
## Note on the revision traced

The audit branch `docs/full-spectrum-audit-2026-08-18` is based on `04dd116b`,
**before** the twelve PRs the brief names. Every quote and line number below is
read from `origin/main` at `0485cf81` ("Surface Library Q&A knowledge gaps in
Research Intake Cards (#453)") using `git grep <rev>` / `git show <rev>:<path>`,
not from the checked-out tree. Where the checked-out tree and `origin/main`
differ, `origin/main` is what is reported.

`git merge-base HEAD origin/main` = `04dd116b`; `git diff --stat HEAD
origin/main -- apps/web` shows 73 changed files including
`competitionSafetyGates.ts` (new, 239 lines) and `trainingHolds.ts` (+57).

---

## Journey 1 — A coach places a medical hold on a child

**Verdict: BROKEN at the first step, and silently incomplete everywhere
downstream of it.**

### 1.1 The journey cannot start. No screen in the product places a hold.

`POST /api/pilot/training-holds` with `action: 'place'` is a complete,
well-guarded, transactional endpoint. **Nothing in the application calls it.**

Every client reference to the route in `origin/main` is a `GET`:

```
origin/main:apps/web/app/coach/progression-intelligence/page.tsx:342:          `${apiBase()}/api/pilot/training-holds?athlete_id=${encodeURIComponent(selectedAthlete)}&status=active`,
origin/main:apps/web/app/coach/sports-medicine/page.tsx:97:                  `${apiBase()}/api/pilot/training-holds?athlete_id=${encodeURIComponent(athlete.athlete_id)}&status=active`,
origin/main:apps/web/components/TrainingHoldBanner.tsx:44:        const response = await fetch(`${apiBase()}/api/pilot/training-holds`, {
```

Those are the only three. `TrainingHoldBanner.tsx:44` is the athlete's own
read; the other two are staff reads with `status=active` in the query string.

**Refutation attempts, all four failed:**

1. *Maybe a component posts it without the literal path.* Searched for the
   place-action payload shape across every client file: `git grep
   "athlete_explanation\|lift_condition_text\|reason_category" origin/main --
   'apps/web/app/**/*.tsx' 'apps/web/components/*.tsx'` returns 20 hits, and
   **every one is a read** — `{shownHold.athlete_explanation}`
   (`progression-intelligence/page.tsx:593`), `{row.hold.athlete_explanation}`
   (`sports-medicine/page.tsx:199`), `{item.hold.athlete_explanation}`
   (`parent/safety/page.tsx:136`), `{hold.athlete_explanation}`
   (`TrainingHoldBanner.tsx:69`). No form fields, no `useState` for a reason
   category, no submit handler.
2. *Maybe another server module places one — a compliance violation, a failed
   video scan, a medical-status change auto-holding the child.* `git grep
   "placeTrainingHold\|liftTrainingHold" origin/main -- apps/web` returns, after
   excluding tests and READMEs, exactly two non-doc call sites — both inside
   `apps/web/app/api/pilot/training-holds/route.ts` (`:216` and `:264`), the
   route itself. `compliance.ts:154` mentions `placeTrainingHold` only in a
   comment citing its transaction pattern.
3. *Maybe raw SQL writes the table from somewhere else.* `git grep "insert into
   pilot.training_holds" origin/main -- apps/web infra scripts` returns six
   hits: five in `trainingHolds.pg.test.ts` and one at `trainingHolds.ts:180`,
   inside `placeTrainingHold`.
4. *Maybe `action: 'place'` appears in a client under a different route.* The
   only other `action: 'place'` in the app is
   `app/coach/floor-groups/page.tsx:154` — `action: 'place', plan_id:
   selectedPlanId, group_id: groupId, athlete_id: placeAthleteId,` — which posts
   to `coach/floor-groups`, placing an athlete in a floor group, not a hold.

**So the capability is API-only.** A coach cannot pause a child's training from
any screen in the platform; nor can an admin. `/admin/safety-review` and
`/coach/sports-medicine` both *display* holds and neither offers a control to
place or lift one — `admin/safety-review/page.tsx:146` renders `{hold.scope}
&middot; {hold.reason_category}` and nothing more.

Severity **HIGH**: the register that gates class registration, competition
entry, the athlete's own banner and the guardian's safety page has no writer
reachable by the people the module's own authority note names. From
`trainingHolds.ts:29-31`:

```
 * AUTHORITY (owner decision): coaches place and lift holds for their own
 * athletes; organization admins place and lift any. Role checks live at the
 * route layer (requirePrincipal + assertCoachAssignedToAthlete); this
 * module records who acted and files the escalation.
```

The authority is implemented. The surface to exercise it is absent. This is a
**capability no journey reaches**, and it is the load-bearing one.

### 1.2 Downstream, assuming the hold exists (placed by a direct API call)

Traced every reader of `pilot.training_holds` on `origin/main`. There are six,
and one non-reader that matters more than any of them.

| Surface | Reads the hold? | Which scopes bite | Where |
|---|---|---|---|
| Class registration (STOP) | yes, in-transaction | `all_training` only | `schedulerDb.ts` via `findRegistrationBlockingHold` |
| Competition entry / league roster | yes (new, #452) | `all_training` + `contact_only` | `competitionSafetyGates.ts` via `findContactEventBlockingHold` |
| Contact observation logging | yes, flags after the fact | `all_training` + `contact_only` | `trainingHolds.ts:flagContactDuringHold` |
| Admin safety review | yes, display | all | `safetyReview.ts` |
| Guardian safety page | yes, display | all | `app/api/pilot/parent/safety/route.ts:66` |
| Coach clearance board / progression | yes, display | all | `sports-medicine`, `progression-intelligence` |
| **Attendance check-in** | **no** | — | see 1.3 |

### 1.3 Attendance is the seam. A held child is marked present with no signal.

`POST /api/pilot/scheduler` with `action: 'attendance_checkin'` (route.ts:637)
and `bulk_attendance_checkin` (`:696`) consult no hold. Grepping the whole
scheduler route for hold logic returns hits only in the *registration* branch
(`:418`, `:433`, `:462`) — nothing in either attendance branch. The attendance
domain modules confirm it: `grep -n "hold" src/server/pilot/attendance*.ts`
returns **nothing** across `attendancePrecedence.ts` and
`attendanceReporting.ts`.

So the sequence a gym will actually produce:

1. Child has a pre-existing registration for Tuesday's class.
2. A coach places an `all_training` medical hold on Monday.
3. Tuesday: the registration is still live (see 1.4), the child is in the room,
   and `bulk_attendance_checkin` marks them present. No refusal, no flag, no
   near miss, no escalation.

`flagContactDuringHold` is the only post-action detector, and it fires from one
place only — `app/api/pilot/shadow/formulas/observations/route.ts:5` — and only
when `isContactObservation(input.kind, input.value)` is true
(`trainingHolds.ts:445`). Attendance is not an observation, so it never reaches
that detector. **A medically held child attending training produces no record
that anything was wrong.**

*Refutation attempt:* the module's own doctrine could justify this — a hold is
enforced as a pre-action block, and attendance is a post-action record, which
`flagContactDuringHold`'s comment defends explicitly: *"A FLAG, never a block --
refusing the write would destroy the only record the contact occurred"*
(`trainingHolds.ts:432-434`). That defence justifies not *blocking* attendance.
It does not justify not *flagging* it: the contact path chose flag-not-block and
still raises a `high` near miss. Attendance chose neither. The refutation
narrows the finding from "attendance should refuse" to "attendance records
nothing", and the narrower claim stands.

Severity **HIGH** — a child's safety state is wrong on the floor and no surface
in the gym learns of it.

### 1.4 The hold changes nothing about registrations that already exist

Corroborates the audit's existing **F-02** (downgraded to MEDIUM on
verification) from the journey side rather than the module side, so this is not
re-reported as new. `placeTrainingHold` (`trainingHolds.ts:156-232`) does
exactly three things inside its transaction: `sweepExpiredHolds`, the duplicate
check, the `insert`, then `fileEscalation`. There is no `update
pilot.scheduler_registrations`, no cancellation, no sweep of future classes.
Read the whole function; nothing else is there.

The journey consequence, which the module-level finding does not state: the
coach's *own* board never tells them the hold failed to take effect for the
sessions already booked. `/coach/sports-medicine` shows the hold, with its
explanation and lift condition, next to a clearance badge — and the child's
existing bookings are on a different page entirely.

### 1.5 The one part of this journey that is now genuinely complete

PR #452's `competitionSafetyGates.ts` is the strongest safety code read in this
pass, and the brief's instruction to re-check was right: the CRITICAL F-01 is
closed, and closed properly rather than patched. It is worth recording *why*
this one hangs together, because it is the counter-example to every other seam
in this file — the checks were extracted into one module precisely so two
capabilities could not drift:

```
 * The two capabilities need the identical
 * three checks, so the checks live here once. Duplicating them into two route
 * files is how one of the copies later stops matching the other.
```
`apps/web/src/server/pilot/competitionSafetyGates.ts:20-22`

Gate ordering is a disclosure property, stated and implemented: `await
assertActorCanAccessAthlete(input.actor, input.athleteId)` runs before either
safety read (`:161`), so *"an actor with no relationship to the child learns
nothing about that child's medical holds or their family's consent decisions
from the error they get back"* (`:132-135`). It reaches both athlete-linking
routes — `operations/external-competition/entries/route.ts` and
`operations/wrestling-league/roster/route.ts`. And it correctly widens the scope
set beyond the scheduler's, with the reason written down
(`trainingHolds.ts:420-427`): *"a wrestling match and an external competition
carry no such ambiguity -- they are contact and maximal exertion by definition
-- so the REGRESS rung ... has to stop them too, or "no contact for now" would
mean no sparring on the gym floor and a match on Saturday."*

One residual, recorded not as a defect but as a bounded fail-open the module
itself declares (`trainingHolds.ts:441-448`): a missing `pilot.training_holds`
relation reads as "no hold" on the competition path too. The module states this
is deliberate and consistent, and it is.

### Journey 1 verdict

**BROKEN** — no entry point exists. Were the hold placed by direct API call, the
journey would be **silently incomplete**: it is enforced at two pre-action gates
(registration, competition) and flagged at one post-action surface (contact
observations), while attendance and pre-existing registrations pass through with
no block and no record.

---

## Journey 2 — A guardian withdraws consent

**Verdict: SILENTLY INCOMPLETE.** The journey completes, returns success, retracts
what it says it retracts *for footage filed under that child* — and leaves two
whole classes of the same child's media untouched, one of which the confirmation
dialog explicitly promises to cover.

### 2.1 The journey, traced

Entry: `/parent/consent`, `GuardianMediaConsentPage`. The lever is one button per
child, rendered only when the guardian's own current row is signed
(`page.tsx:190-198`, `currentlySigned` from `myRow?.status === 'signed'`).

`decide(athleteId, 'withdraw', childName)` shows a confirm, then POSTs
`{athlete_id, decision:'withdraw'}` to `/api/pilot/parent/consent`.

The route (`app/api/pilot/parent/consent/route.ts`) does, in order: `requireRole
parent`; `guardianAthleteIds` membership, returning `hiddenNotFound()` on a
foreign child (`:130`); `resolveActingParent` to find *this account's* parent row
for *this* athlete; `withdrawMediaConsent` (a new append-only `pilot.waivers`
row); an audit event; then `suppressPublishedMediaForAthlete`.

The sweep is the good part and is worth crediting: it is transactional, it locks
against an in-flight publish, and the interleaving argument is written down
(`publication.ts:352-357`) — *"either the publish commits first and this sweep
then sees and retracts it, or this sweep's lock wins and the publish's re-check
runs after the withdrawal committed and refuses. In no interleaving does a
publish survive a withdrawal unsuppressed."* A failed sweep is deliberately NOT
swallowed: it 500s with a guardian-readable message and files its own audit row
(`route.ts:196-224`). That is the right shape and the opposite of the swallow
patterns pass 17 found elsewhere.

Forward-looking enforcement is real too. Consent is asserted at exactly three
places, all of them gates a guardian would want: publish
(`publications/publish/route.ts:98`), admin approve
(`admin/video-compliance/route.ts:304`), and Film Study enqueue
(`shadow/video-analysis/route.ts:106`).

### 2.2 FINDING J2-A — the sweep does not cover footage of this child filed
under another child, and the dialog promises that it does

The confirmation the guardian reads, verbatim from
`apps/web/app/parent/consent/page.tsx:65-67`:

```
        `Withdraw consent for ${childName}’s photos and videos? Anything already published of ${childName} will be retracted from distribution immediately, and future publications will be blocked until consent is granted again.`
```

"Anything already published of ${childName}". What the sweep actually does, from
its own header at `apps/web/src/server/pilot/publication.ts:341-345`:

```
 * The consent-withdrawal sweep: every currently-published publication FILED
 * UNDER this athlete_id becomes retracted, and its shelf rows suppressed,
 * in one transaction. (One publication names one athlete_id -- footage of
 * this athlete filed under another athlete's publication is outside this
 * sweep, the same single-athlete boundary the compliance console documents.)
```

and the UPDATE that implements it (`publication.ts:373-379`):

```
      `update pilot.video_publications
       set status = 'retracted',
           updated_at = now()
       where organization_id = $1 and athlete_id = $2 and status = 'published'
       returning publication_id`,
```

**The gap is not hypothetical in a boxing gym — it is the normal case.** A
publication is created from one video session and carries one `athlete_id`
(`publications/create/route.ts:54`, `:63-67`). A sparring or partner-drill clip
shows two children and is filed under one of them. When the *other* child's
guardian withdraws, that clip stays `published` and stays distributable, while
the guardian has been told in so many words that "anything already published of"
their child was "retracted from distribution immediately."

The same boundary means the **publish gate consults one child's guardians for a
two-child video**: `publications/publish/route.ts:98` is
`await assertGuardianMediaConsent(principal.organizationId, publication.athlete_id);`
— singular, the filed-under athlete. A clip of A and B publishes on A's
guardians' consent alone.

**Refutation attempts:**

1. *Maybe publications carry a second athlete list.* Checked the migration:
   `infra/azure/pilot_slice_postgres_video_sessions_migration.sql:69` is
   `  athlete_id text null,` — one nullable scalar, no join table. `git grep`
   for a participants/co-athlete column found none.
2. *Maybe the compliance console retracts the rest manually.* It can — the route
   comment calls it *"the compliance console's manual Retract lever ... the
   operator fallback"* (`parent/consent/route.ts:190-191`). But that is a human
   noticing; nothing lists "other publications containing this child", because
   nothing records it. The refutation converts this from "impossible to fix" to
   "depends on an operator knowing something the system does not store", which
   does not save the on-screen promise.
3. *Maybe the dialog is narrower than I read it.* It is not: the page header
   scopes consent honestly to publications — *"It controls one thing: whether
   photos or videos of your child may be used in gym publications"*
   (`page.tsx:113-114`) — so the over-claim is specifically the word
   **"anything"** in the confirm, against a query keyed on one column.

Severity **HIGH** — a guardian is told a withdrawal took effect on media it did
not touch, on a safeguarding decision, in a modal they clicked through to give
consent to the action.

### 2.3 FINDING J2-B — a video with no `athlete_id` is outside consent, outside
the sweep, and outside the athlete access check

`POST /api/pilot/video/upload` treats `athlete_id` as optional
(`app/api/pilot/video/upload/route.ts:64`, `:73-74`):

```
    const athleteId = typeof athleteIdValue === 'string' ? athleteIdValue.trim() : null;
...
    if (athleteId) {
      await assertActorCanAccessAthlete(principal, athleteId);
    }
```

Omit the field and three things follow at once: no `assertActorCanAccessAthlete`
runs at all; the row stores `athlete_id` null (the column is `athlete_id text
null`); and every consent surface keyed on athlete id — `checkGuardianMediaConsent`,
`suppressPublishedMediaForAthlete`, `/api/pilot/parent/consent`'s whole
`items` list — cannot see the file. A guardian withdrawing consent has no lever
that reaches it, and no screen on which it appears.

It also drops the safety escalation. `videoScanSweep.ts:166-170`, which the repo
wrote down rather than tripped over:

```
    // Skipped when the video has no athlete_id (an unattributed team upload,
    // the same case videoScanReview.ts documents) -- safety_escalations.athlete_id
...
    if (terminal && isEscalatingScanDecision(scan.decision) && claim.athlete_id) {
```

So an unattributed upload that the content screen judges negatively files **no
escalation**: the one signal that a human should look at that footage is
conditional on the field that was left blank.

*Refutation attempt:* maybe no client omits it, making this unreachable. The
route is a `formData` endpoint reachable by any coach principal and the field is
read with `formData.get('athlete_id')` — a client that does not include the input
sends nothing, and the branch is written specifically to accommodate that case,
as is `videoScanSweep`'s and (per its own comment) `videoScanReview.ts`'s. Three
modules independently handle "unattributed team upload" as an expected state, so
it is expected, not unreachable. The refutation failed.

Severity **HIGH** — footage of a child that no guardian control reaches and no
escalation surfaces.

### 2.4 What withdrawal does not reach, listed rather than re-reported

These are already this audit's findings; recorded here only as the journey's
shape, not as new claims:

- The **content vision scan** runs on every upload with no consent check in the
  path at all (E-01, CRITICAL, hand-verified). Withdrawal cannot affect a gate
  that does not exist. Note that the consent page's copy is narrowly scoped to
  "gym publications", so the page does **not** over-claim here — which is worth
  saying plainly, because it is the one place the guardian-facing wording is
  more honest than the system's behaviour would allow.
- **Film Study** re-checks nothing after enqueue (F-11, MEDIUM) and a
  lease-expiry retry re-sends frames (X-15, HIGH).
- **Consent scope** (`covers_video`, `public_use_allowed`) is recorded and
  enforced nowhere (F-12), the module's own header calling it *"a documented MVP
  cut, not an oversight"* (`guardianConsent.ts:34-38`).
- **Portrait / profile photo** is not in the consent system at all: `git show
  origin/main:apps/web/app/api/pilot/profile/photo/route.ts`,
  `profile/photo/[accountId]/route.ts` and `admin/portrait-review/route.ts` each
  return **zero** matches for `consent`. Withdrawing photo consent leaves the
  child's portrait on the coach roster and in the reviewer's queue (which #461
  just widened to show the reviewer the photograph itself).
- **SHADOW** never learns (S-05).

### Journey 2 verdict

**SILENTLY INCOMPLETE.** The guardian's lever works, is well-guarded, and does
the one thing it advertises for footage filed under their child. It does not
reach group footage filed under another child, unattributed footage, portraits,
or the vision scan — and the confirmation dialog's word "anything" claims
otherwise.

---

## Journey 3 — A guardian tries to find out what is happening with their child

**Verdict: SILENTLY INCOMPLETE, plus one live self-contradiction on a single
card.** The guardian's surfaces are unusually honest about what they do not know
— which is the codebase at its best — but the answer to "what is happening with
my child" is largely *nothing*, and one of the few things the platform does tell
them can flatly contradict itself.

### 3.1 What the guardian can actually reach

Four pages exist under `apps/web/app/parent/` (`consent`, `dashboard`,
`progression-visibility`, `safety`), plus `/guardian` and the shared
`/names`, `/print` entries in `buildingMap.ts:148-184`.

`ParentHub.tsx` makes six network reads, and that is the whole surface:
`parent/messages` (`:188`), `parent/safety` (`:223`), `parent/barrier-report`
(`:260`), `athletes/list` (`:301`), and `profile/card` per child (`:336`, `:399`).

`/parent/progression-visibility` reads gaps, assignments and completions, and
states its own boundary correctly: *"A guardian reads exactly what their child
reads, never more"* (`page.tsx:22-23`).

### 3.2 The hub is honest and almost entirely empty

The prototype-data cleanup landed properly here, and it should be credited
before the criticism. Attendance renders `Unavailable - not yet tracked`
(`ParentHub.tsx:769`) rather than a fabricated percentage, `parentObservations`
and `familyGoals` are `useState<...>([])` with no seed data (`:168`, `:170`),
and the disclosure is written into the source at `:884`: *"bar previously shown
here were hardcoded example data, not real tasks -- they have been"*.

So the honest summary of what a guardian learns about their child today: the
child's name, track, portrait, any active training hold, a list of safety-gate
outcomes, their own consent state, progression gaps and drill assignments, and
messages. **Not** attendance, **not** whether the child trained this week,
**not** membership, **not** incidents.

### 3.3 FINDING J3-A — the Safety Status card can say both "no pause" and
"Active Training Hold: Not clear" about the same child at the same moment

`/parent/safety` builds each child's card from two independent reads that are
rendered eight lines apart. `route.ts:64-66`:

```
          getAthleteById(principal.organizationId, athleteId),
          getActiveTrainingHold(principal.organizationId, athleteId),
          getGuardianGateSummary(principal.organizationId, athleteId),
```

The hold read is a **live condition**: `getActiveTrainingHold` sweeps expiry then
selects `status = 'active' and (expires_at is null or expires_at > now())`
(`trainingHolds.ts:296-302`). When it returns null the page renders
`No training pause on file right now.` (`parent/safety/page.tsx:148`).

The gate read is **the latest evaluation ever recorded**, with no recency or
currency condition at all — `getGuardianGateSummary` is a `left join lateral ...
order by e.evaluated_at desc limit 1` over `pilot.safety_gate_evaluations`
(`safetyGateMatrix.ts:186-198`). The seeded gate is displayed by name:
`gateKey: 'training_hold', name: 'Active Training Hold'`
(`safetyGateSeeds.ts:58-59`), and the guardian-facing label for `blocked` is:

```
  blocked: 'Not clear',
```
`apps/web/app/parent/safety/page.tsx:41`

**No code path ever records that gate as `passed`.** Searching every writer:
`git grep "outcome: 'passed'" origin/main -- apps/web` (tests and READMEs
excluded) returns exactly one line —
`origin/main:apps/web/src/server/pilot/contactClearanceGate.ts:156` — and that
module's key is `const GATE_KEY = 'contact_medical_clearance';`
(`contactClearanceGate.ts:8`), a different gate. The three writers that use
`'training_hold'` all write `blocked`: `scheduler/route.ts:447`,
`competitionSafetyGates.ts:193`, and nothing else.

So: one refused class registration, or one refused competition entry, stamps
`blocked` permanently. Lift the hold, and the top of the card correctly says
there is no pause while the bottom of the same card still says "Active Training
Hold — Not clear", for the rest of the child's membership.

This mechanism is the audit's existing **F-07** (LOW). What is new here is (a)
the contradiction is *within one card*, not across screens, and (b) **#452 added
two more writers of the permanent `blocked`** — `competitionSafetyGates.ts:193`
records `outcome: 'blocked'` for the same gate key on every refused competition
entry, so the merged fix widened the set of actions that can freeze a guardian's
screen in the wrong state.

*Refutation attempt, partially successful and recorded as such:* the error
direction is conservative — the guardian is told their child is *less* clear
than they are, not more — and the live hold read sits above it, which a careful
reader would weigh higher. That is a real mitigation and is why this stays
**MEDIUM** rather than being argued up to the "guardian is misinformed" HIGH bar.
It does not make a self-contradicting safety card acceptable.

### 3.4 FINDING J3-B — the module that exists to give a single honest attendance
answer has zero callers, so the guardian's attendance is structurally blank

`attendancePrecedence.ts` opens by describing itself
(`apps/web/src/server/pilot/attendancePrecedence.ts:3-21`):

```
// CT-13: the ONE way to ask this platform how many days somebody attended.
//
// Three attendance-shaped tables exist (pilot.attendance,
// pilot.scheduler_attendance, pilot.activity_log) at three different grains.
// Summing any two of them inflates participation by however many athletes
// attend more than one class in a day. The written finding is
// docs/current/ATTENDANCE_PRECEDENCE.md; the enforced version is
// pilot.attendance_reconciled, which this module is the only reader of.
```

It exports four functions — `listAthleteAttendanceDays` (`:64`),
`getAthleteAttendanceTotals` (`:101`), `getOrganizationParticipationTotals`
(`:166`), `listOverlappingSourceDays` (`:205`). **Each was searched by name
across `apps/web` on `origin/main`; every one returns hits only inside
`attendancePrecedence*.ts` and its own tests.** Nothing calls the reconciled
view.

What the platform *does* read is `attendanceReporting.ts`, whose own header
scopes it to one of the three sources: *"Read-side rollups over
pilot.scheduler_attendance"* (`attendanceReporting.ts:3`). That feeds
`scheduler/attendance-summary`, and the roster CSV export carries a **third,
hand-copied** version of the same formula: *"Same formula as
attendanceReporting.ts#computeAttendanceRate: present /"*
(`app/api/pilot/admin/export/roster/route.ts:57`).

And the guardian gets none of them: `scheduler/attendance-summary` excludes the
role by design, stating it in the file — *"athlete, parent, board, volunteer,
staff: forbidden here. This is an operations/reporting surface, not a
self-service one"* (`route.ts:23-24`) — while `ParentHub.tsx:318` hardcodes
`attendancePercent: null,`.

The journey therefore has three different attendance numbers available to staff,
a reconciliation module written specifically to prevent that, unreachable, and a
guardian who is shown nothing. Severity **MEDIUM** — no child is unsafe and
nobody is told a false number; the platform simply cannot answer the most basic
question a parent asks, and the code that would answer it is dead.

### 3.5 FINDING J3-C — three "not yet tracked" statements on the hub became
false when #458/#462 merged

`ParentHub.tsx:773-777` carries this justification:

```
                      {/* Membership/scholarship/community-service status has no
                          backing column anywhere in the schema -- these used to
                          be hardcoded to the same "supported" values for every
                          family regardless of their actual status, which is a
                          real billing-adjacent misstatement, not a placeholder.
                          Show unavailable honestly until a real field exists. */}
```

followed by three `Unavailable - not yet tracked` rows for Membership,
Scholarship and Community Service Support.

All three now have backing columns on `origin/main`:

- `pilot.program_memberships`, with `status: MembershipStatus` over `'active' |
  'lapsed' | 'ended'` **and** `scholarship_percent` — *"a scholarship is a
  DISCOUNT PERCENTAGE on a real membership row (100 = full scholarship), never a
  bypass"* (`programMemberships.ts:7-11`); migration
  `infra/azure/pilot_slice_postgres_program_memberships_migration.sql`.
- community service hours in `pilot.activity_log` under
  `activity_domain='community_service'`
  (`infra/azure/pilot_slice_postgres_activity_log_migration.sql:96`), read by
  `getCommunityServiceTotals` via `/api/pilot/admin/community-service`.

Membership status is even read at class registration now, which is what #458
did. So the family is told a fact about the platform that stopped being true.

*Refutation attempt, and it half-succeeds:* the *disclosure* decision may still
be correct — `programMemberships.ts:14-16` says *"Admin-only in both directions
-- enrollment and scholarship decisions are administrative records about
families, not floor data."* Withholding it from the hub is defensible. What is
not defensible is the stated reason: the comment asserts no backing column
exists anywhere in the schema, and three now do. Severity **LOW**, filed as
staleness introduced by a merge, not as a data defect.

### 3.6 Coherence across screens, as asked

- Hold: coherent. `/parent/safety`, the athlete's own `TrainingHoldBanner`, and
  `/coach/sports-medicine` all render the same `athleteFacing()` projection, and
  `parent/safety/route.ts:15-22` documents that deliberately.
- Safety gates: **incoherent with the hold on the same card** (3.3).
- Attendance: no guardian view; staff views disagree with each other (3.4).
- A withdrawn child: `athletes/list` does not filter `deleted_at` (zero matches
  in the route), which is the audit's **X-02 / F-26**; a guardian's list is
  driven by `guardianAthleteIds`, whose queries carry no `deleted_at` predicate
  either (`guardianAccess.ts:43`, `:65`). Not re-reported — noted as reaching the
  guardian journey too.

### Journey 3 verdict

**SILENTLY INCOMPLETE.** The guardian can complete the parts of the journey the
platform implements, and the screens are honest about their blanks — but the
central question is unanswerable, the module that would answer it is dead code,
and the one safety surface they do get can contradict itself on a single card.

---

## Journey 4 — A new athlete is enrolled

**Verdict: SILENTLY INCOMPLETE.** Enrollment succeeds with no guardian, no
liability waiver and no medical release on file, and the child can be registered
for class and marked present in that state. Nothing downstream *assumes* those
were filled — which is why nothing complains. The paperwork the intake surfaces
collect gates exactly one action, and it is not training.

### 4.1 The steps that exist

- **Athlete record**: `/admin/people` posts `/api/pilot/athletes`
  (`admin/people/page.tsx:663`). The payload is fully required —
  `validateAthletePayload` calls `requireString` on `athlete_id`, `full_name`,
  `dob`, `weight_class`, `gym_status`, `emergency_contact`, `coach_id`
  (`validation.ts`), and `insertAthleteIfAbsent` is create-only with a good
  reason written down (`app/api/pilot/athletes/route.ts:22-28`): *"an 'on
  conflict do update' here would silently overwrite an existing athlete's name,
  dob, weight class ... a typo can land on a real teammate."*
- **Athlete sign-in account**: separate, `/api/pilot/admin/athlete-accounts`
  (`admin/people/page.tsx:723`). See A-01 for the shell-account finding.
- **Guardian account + link**: `/admin/people` again, role `guardian`
  (`page.tsx:84`), through `staffProvisioning.ts`. **This step is rigorous and
  should be credited.** `staffProvisioning.ts:183-186`:

```
  if (role === 'parent' && !guardian) {
    throw new Error(
      'Missing guardian link: a parent account is only created together with the athlete they are the guardian of, because a parent with no link signs in successfully and sees no children',
```

  The account, the `pilot.parents` row and the `pilot.guardian_links` row are one
  transaction (`:215-217`), and the claim-vs-mint logic refuses ambiguity rather
  than guessing (`:449-453`).
- **Waivers**: `/admin/consent` posts `entity_type: 'waiver'` to
  `intake/domain-upsert` (`admin/consent/page.tsx:195-203`).
- **Clearance**: `pilot.shadow_medical_administrative_status` via
  `/api/pilot/shadow/medical-status` (see S-01).
- **First registration**: `POST /api/pilot/scheduler` `action:
  'register_class'`.

### 4.2 FINDING J4-A — nothing in the enrollment journey is a precondition for
training; the only enforced waiver is the travel one, and only for competitions

`registerForClassTransactionally` is the complete gate on a child entering a
class. Read end to end (`schedulerDb.ts:197-292`), it performs: a `for update`
lock on the class row; `findRegistrationBlockingHold`; the already-registered
check; the capacity count; the insert; the full-status flip; and
`listMembershipFlagsForAthlete`. That is all of it.

**It does not read `pilot.waivers`, `pilot.guardian_links`, or
`pilot.shadow_medical_administrative_status`.** So a child with zero guardians
linked, no `general` (liability) waiver, and no `medical_release` on file
registers and trains normally.

The waiver register itself is real and complete — `TRACKED_WAIVER_TYPES =
['general', 'medical_release', 'photo_media', 'travel']`
(`waiverCompliance.ts:20`), with an org-wide rollup and an `/admin/waiver-status`
console. But `getAthleteWaiverStatus`, the per-athlete gate accessor, has exactly
**one** non-test caller in the whole application:

```
origin/main:apps/web/src/server/pilot/competitionSafetyGates.ts:235:  const travelStatus = await getAthleteWaiverStatus(organizationId, input.athleteId, TRAVEL_WAIVER);
```

`general` and `medical_release` are collected, displayed, and consumed by no
predicate anywhere. The codebase says as much about itself, in a comment that
`#452` has since made stale in an instructive direction
(`auditEventTypes.ts:36-39`):

```
  // indistinguishable from any other waiver row edit in the audit stream,
  // and this is the one waiver_type this platform gates something on.
```

That comment names `photo_media`. #452 added `travel` as a second. Neither
version of the sentence includes the liability waiver or the medical release.

**Refutation attempts:**

1. *Maybe the compliance-rules engine files a violation for a missing waiver.*
   `git grep "waiver" origin/main -- .../compliance.ts .../safetyGateSeeds.ts
   .../safetyReview.ts` returns **no output at all**. No seeded rule, no gate,
   no review surface reads the waiver register.
2. *Maybe `dob` being a plain `requireString` lets an unknown age through, so
   the minor/adult determination silently mis-classifies.* This one **refuted
   cleanly and is worth recording as a non-finding**: `pilot_slice_postgres.sql:65`
   is `  dob date not null,`, so a non-date is rejected by Postgres, and
   `competenceCohorts.ts:205`'s claim — *"null only when dob is unknown, which
   pilot.athletes does not permit"* — is true. The redaction path fails safe too
   (`contracts.ts:40`: *"wallDisplay.ts#isMinor reads a null dob as a minor,
   never as an adult"*).
3. *Maybe the guardian requirement is enforced from the athlete side.* No: the
   guard quoted in 4.1 runs when creating a **parent** account. Creating an
   athlete never mentions guardians. And the consent module treats zero
   guardians as fail-closed for media (`guardianConsent.ts:27-31`), which is
   correct — but media is the only thing it fails closed *for*.

Severity **HIGH** — a minor can be enrolled and put on the floor with no
liability waiver, no medical release, and no adult linked to them in the system.
The registers to prevent that all exist; nothing consults them at the moment it
would matter. This is the purest "silently incomplete" shape in the pass: every
component is correct, and the seam between intake and the scheduler is empty.

### 4.3 FINDING J4-B — `parent_reviewed` is a guardian-consent signal that
nothing consumes, and an admin can set it in a guardian's name

When an athlete self-registers, the registration is written unreviewed
(`scheduler/route.ts:393-401`):

```
        // true means "a parent has reviewed this registration" (see
        // markSchedulerRegistrationReviewed). Only a parent registering their
        // own child satisfies that at insert time; an athlete self-registering
        // is exactly the case the review step exists for.
        parent_reviewed: actor.role === 'parent',
```

Two problems in one field.

**It gates nothing.** `parent_reviewed` is read in exactly two places outside the
scheduler module: the type declaration and the display line at
`app/schedule/page.tsx:585` — `Status: {item.status} | Parent Reviewed:
{item.parent_reviewed ? 'Yes' : 'No'}`. No registration status depends on it, no
attendance path checks it, no escalation is filed for a class full of unreviewed
minors. The review step "exists for" a case whose outcome changes nothing.

**An admin can satisfy it on the guardian's behalf, and is recorded as the
guardian.** The client control is gated by `roleCanManageParents`
(`app/schedule/page.tsx:82-84`):

```
function roleCanManageParents(role: SchedulerRole | null): boolean {
  return role === 'parent' || role === 'admin' || role === 'organization_admin';
}
```

and the server agrees — `if (!(actor.role === 'parent' || canManageAll(actor)))`
(`scheduler/route.ts:486`). The write then stamps whoever acted into the column
named for the parent (`schedulerDb.ts:300-306`):

```
    `update pilot.scheduler_registrations
     set parent_reviewed = true,
         parent_reviewed_at = $3,
         parent_reviewer_account_id = $4,
```

called as `markSchedulerRegistrationReviewed(actor.organizationId,
registrationId, actor.accountId, ...)` (`scheduler/route.ts:502-507`). So an
admin clicking "Mark Parent Reviewed" produces a row asserting a parent reviewed
a minor's class registration, attributed to the admin's own account id, and the
schedule screen then renders `Parent Reviewed: Yes`.

*Refutation attempt:* an admin acting for a parent who phoned in is a legitimate
gym workflow, and `parent_reviewed_at` plus `parent_reviewer_account_id` do
preserve who really clicked — the record is not falsified at the database level,
only at the label. That mitigation is real, and it is why this is **MEDIUM** and
not higher. The `UPDATE` also carries no `where parent_reviewed = false`
predicate, so a second review silently re-attributes the first — the opposite of
the guarded-UPDATE discipline `liftTrainingHold` uses two modules away.

### Journey 4 verdict

**SILENTLY INCOMPLETE.** Every enrollment step works and most are well built.
The journey's output is an athlete who can train while every safeguarding
register about them is empty, and the one parental-review signal the scheduler
collects is decorative.

---

## Journey 5 — An incident is reported

**Verdict: COMPLETE as a record, BROKEN as a response.** Filing, dedup,
escalation and the open/acknowledged/resolved state machine are among the best
code in the repository. What the journey cannot do is *change anything about the
child*, and it cannot tell the child's guardian.

### 5.1 Filing and the ladder — genuinely complete

Entry exists and is real: `/coach/decision-loop`, `handleReportIncident`, posting
to `/api/pilot/incidents` (`coach/decision-loop/page.tsx:322`). The route forces
the severity floor, bounds every string, and calls `assertActorCanAccessAthlete`
before writing (`incidents/route.ts:41-58`).

`fileIncidentReport` defends its own floor rather than trusting the route, and
says why — this is the pattern journeys 1 and 4 are missing everywhere else
(`escalationLadder.ts`, in `fileIncidentReport`):

```
  // The 'high'/'critical' floor above is a TypeScript-only guarantee -- it
  // does not survive past this module's own boundary. Round 9 review: the
  // only actual enforcement was api/pilot/incidents/route.ts's own
  // allow-list check, so any other caller (a script, a future route) could
  // file a sub-floor severity
```

The insert is a `select ... where not exists` dedup inside one statement, and on
a duplicate it re-reads and returns the existing row rather than lying either
direction — *"never fabricate a report that does not exist; a real error here is
honest, a synthesized one is not."*

The state machine is well-formed and guarded:

```
const LEGAL_PRIOR_STATES: Record<'acknowledged' | 'resolved', SafetyEscalationStatus[]> = {
  acknowledged: ['open'],
  resolved: ['open', 'acknowledged'],
};
```
`apps/web/src/server/pilot/escalationLadder.ts:384-387`

with the legal-prior-state set applied as a predicate **on** the UPDATE
(`:411-412`), and a re-read to distinguish "no such row" from "illegal
transition". Coach scoping on both read and acknowledge is careful, including the
`athlete_voice` exclusion and the probe-resistant identical error
(`escalations/route.ts:108-121`). `/admin/safety-escalations` is a five-line
`redirect('/admin/escalations')`, so there is no second console to disagree.

`resolved` is terminal — no reopen exists, unlike publications, which have
`reopenRetractedPublication`. Noted as a **state machine with no exit** as asked,
at LOW: an admin who resolves the wrong row cannot undo it, though a new incident
can be filed. Not raised further because nothing about the child's safety depends
on it.

### 5.2 FINDING J5-A — no guardian is ever told, and the stated reason covers
one of nine source types

`/api/pilot/parent/safety` is the guardian's only safety surface, and it excludes
the escalation table wholesale. Its own header, `route.ts:34-41`:

```
 * Deliberately excludes pilot.safety_escalations entirely: an
 * 'athlete_voice' escalation exists because a child typed something into
 * the feedback box, and escalationLadder.ts's own doctrine is that this
 * must never reach a surface the athlete's own guardian can read (a
 * guardian may be exactly who a child is disclosing about, or leaking
 * "an escalation exists" at all could itself be unsafe).
```

Every word of that reasoning is about `athlete_voice`. The union it excludes has
nine members (`escalationLadder.ts:29`):

```
export type SafetyEscalationSourceType = 'near_miss' | 'pain_report' | 'safety_gate_evaluation' | 'repeated_pattern' | 'athlete_voice' | 'training_hold' | 'incident' | 'video_scan' | 'compliance_violation';
```

`'incident'` is in that list, and by construction an incident is `'high'` or
`'critical'` — *"severity is forced to 'high'/'critical' here so it always
surfaces at the top of that queue"* (`incidents/route.ts:21-23`). So a coach
filing "this actually happened, critical" about a child produces a record that
the child's guardian cannot see on any screen.

And there is no other channel. `escalationLadder.ts:11-13`:

```
 * human without them needing to already know where to look. There is no
 * notification channel in this platform (no email, ever), so this table and
 * the /admin/escalations page that reads it ARE the escalation mechanism.
```

`escalated_to_role` cannot name a guardian either, and that too is deliberate and
documented (`escalationLadder.ts:41-50`), with the gap acknowledged: *"'parent'
would let a guardian learn an escalation exists at all ... until a real
product/safety decision creates a safe board- or parent-facing surface for
individual safety records -- this is reported as a known gap, not silently
widened."*

*Refutation attempt, and it is the honest half of this finding:* the repository
already knows and has recorded this as an open product decision rather than
overlooking it, and the disclosure-safety argument for `athlete_voice` is sound.
What the recorded decision does **not** address is that the exclusion is
implemented at the table, not the source type, so a broken wrist and a
safeguarding disclosure are hidden by the same clause for the same stated reason.
`listEscalations` already accepts `excludeAthleteVoice` as a discriminating
filter (`escalations/route.ts:74`), so the discrimination is available and simply
is not used on the guardian side.

Severity **HIGH** — a guardian is not informed that a critical safety incident
involving their child was recorded, and no surface of the platform could inform
them.

### 5.3 FINDING J5-B — filing an incident, at any severity, changes nothing
about the child, and no screen offers the lever that would

`fileIncidentReport` writes exactly one row into `pilot.safety_escalations` with
`source_id: null` — there is no incident table, and the free-text `reason`
(≤4000 chars) is the entire record. Read the function: after the insert there is
no hold, no clearance write, no registration sweep, no flag on the athlete row.

Then trace what an admin reading `/admin/escalations` can actually *do*. The
route's three actions are `acknowledge`, `resolve`, `scan_patterns`
(`escalations/route.ts:82`). None of them touches the child's training state.

So the admin's options after reading "critical incident, this child" are: mark it
acknowledged, or mark it resolved with an optional note. To pause the child's
training they would need a training hold — and **journey 1 established that no
screen in this platform can place one.**

I then checked whether *any* other in-product control stops a specific child from
being registered for a class, and could not find one:

- `registerForClassTransactionally` reads the class row, the hold, the duplicate,
  the capacity, and the membership flags. It never reads `pilot.athletes`, so
  `active_flag = false` does not block registration — every `active_flag`
  predicate in `apps/web/src/server/pilot` is a *list filter*
  (`attendanceReporting.ts:125`, `safetyReview.ts:93`, `competenceCohorts.ts:177`,
  `onePercentClub.ts:100`, `compliance.ts:472`) or is about an account rather than
  an athlete (`access.ts:120-135`, `auth.ts:290`).
- Membership status is explicitly non-blocking, per #458's own comment in
  `schedulerDb.ts:286-288`: *"with the family; the owner's product-policy call on
  whether it should ever hard-block is deliberately still open."*
- No waiver or clearance is consulted at registration (journey 4, 4.2).

*Refutation attempt:* an incident report is a *record* of something past, so it
is arguably correct that it does not itself act — the same block-versus-flag
doctrine `competitionSafetyGates.ts:28-44` reasons through. Accepted for the
filing step. It does not answer the compound question, which is the one only this
pass asks: **the response the record exists to trigger has no user interface.**
The escalation queue is a to-do list whose only actionable item cannot be
actioned from the product.

Severity **HIGH**, and this is the compound break I would put first: a critical
incident is recorded, the guardian cannot be told (5.2), and the person told has
no control that changes the child's situation (5.3 + journey 1.1).

### Journey 5 verdict

**Filing: COMPLETE. Response and closure: BROKEN.** The ladder is exemplary as a
durable record. As a journey it terminates in an admin queue with no outbound
edge — neither to the guardian nor to the child's training state.

---

## Journey 6 — An admin onboards a coach

**Verdict: SILENTLY INCOMPLETE on the way in, BROKEN on the way out.** Account and
role work well. The clearance step — background checks for adults working with
minors — has a schema, a module, a migration and a test, and **no surface
whatsoever**. And a gym admin cannot remove a coach's access at all.

### 6.1 Account, role and athlete assignment — the parts that work

`/admin/people` → `POST /api/pilot/admin/staff` → `staffProvisioning.ts`
(Microsoft-authenticated, org-admin only). The module is careful, and the
guardian-link invariant quoted in journey 4 lives here.

Athlete assignment is `pilot.athletes.coach_id`, and the authority split is
correctly reasoned and enforced — `assertAthleteUpdateAllowed`
(`access.ts:445-447`):

```
  if (actor.role === 'coach' && before.coach_id !== after.coach_id) {
    throw new Error('Forbidden: coach cannot change coach assignment');
  }
```

with the escalation it prevents written out in full at `access.ts:427-433`,
including the part that matters most: *"profileDb grants 'coach_of_subject'
straight from athletes.coach_id, and that relationship is one of the three in
profileVisibility's MINOR_CIRCLE -- the circle a minor's PHOTOGRAPH never leaves
... So this column is not only roster bookkeeping; writing to it admits the
writer to a child's portrait."*

Temporary coverage is a separate, validated path: `grantCoachCoverage` calls
`assertActiveCoachAccount(params.organizationId, params.coveringCoachId,
'covering_coach_id')` (`access.ts:153`).

### 6.2 FINDING J6-A — the clearance register (PA Act 153 / Act 15) is reachable
from nothing

`apps/web/src/server/pilot/clearanceRegister.ts` exists, with
`infra/azure/pilot_slice_postgres_clearance_register_migration.sql`,
`clearanceRegister.pg.test.ts`, and `scripts/pilot-apply-clearance-register-migration.mjs`.
Its five exported functions are `listClearanceTypes` (`:103`),
`listPersonClearances` (`:117`), `recordPersonClearance` (`:143`),
`listActivityClearanceRequirements` (`:189`), `getClearanceStatus` (`:209`).

**Each was searched by name across `apps/web` on `origin/main`; every one returns
hits only inside `clearanceRegister.ts` and its own pg test.** No API route
imports the module, no page renders it. `git grep -ln "person_clearances"
origin/main` returns four paths: the module, its test, the migration, and the
apply script. Nothing else in the repository mentions the table.

So the platform can hold a clearance register and cannot be told anything to put
in it. The `ActivityScope` union it defines names precisely the acts that need a
clearance in a youth gym (`clearanceRegister.ts:23-32`):

```
export type ActivityScope =
  | 'supervise_sparring'
  | 'corner_competition'
  | 'coach_youth_session'
  | 'unsupervised_youth_contact'
```

*Refutation attempts:*

1. *Maybe it deliberately authorizes nothing, so having no caller is the point.*
   The module does say `THIS MODULE DOES NOT AUTHORIZE ANYTHING` (`:12`) and
   explains that the legal determination belongs to humans — which is right, and
   which is why this is not filed as a missing gate. But it also says
   `getClearanceStatus reads a read-only view that DISPLAYS a factual
   comparison` (`:13-14`). A display function with no screen displays nothing.
   The refutation narrows the finding from "a gate is missing" to "the recording
   and display surface the module was written to serve does not exist", and the
   narrower claim holds.
2. *Maybe the coach-clearance requirement is enforced elsewhere under another
   name.* `assertActiveCoachAccount` checks `role = 'coach' and active_flag =
   true` (`access.ts:127-131`) — employment status, not clearance. Nothing
   anywhere reads a background check before a coach is assigned a child.

Severity **HIGH** — the one register in this codebase whose subject is "may this
adult be alone with children" cannot be populated or read through the product.
Whether the gym's real Act 153 records live in a filing cabinet is outside what I
can see from the repository, and I am not claiming otherwise; what I am claiming
is that this platform's own answer to that question is unreachable, while it
assigns adults to children daily.

### 6.3 FINDING J6-B — a gym admin cannot off-board a coach; the only lever they
have is a session revoke the coach can undo by signing in again

Searched every writer of `pilot.accounts.active_flag`. The one that turns a staff
account off is reached by exactly one route,
`/api/pilot/platform/users/status`, whose first act is:

```
    requireRole(principal, ['platform_owner']);
```
`apps/web/app/api/pilot/platform/users/status/route.ts:13`

`platform_owner` is not a role inside a gym. What an organization admin has
instead is `/api/pilot/admin/accounts/revoke`, and it does one thing —
`await revokeAllSessionsForAccountInOrganization(accountId, principal.organizationId);`
(`revoke/route.ts:26`) — with the audit detail `{ action: 'session_revoke' }`.
The account's `active_flag` is untouched, so the coach signs in again through the
Microsoft path and is issued a new session.

`DELETE /api/pilot/admin/staff` is not an off-boarding lever either: it removes
**one guardian link** (`route.ts:214-218`, `removeGuardianLink`).

And the people console already renders a state it cannot set —
`apps/web/app/admin/people/page.tsx:140`:

```
    return { label: 'Deactivated', tone: 'blocked' };
```

An admin can see that an account is deactivated. There is no control on the page,
and no route available to their role, that deactivates one.

*Refutation attempts:*

1. *Maybe removing the athlete assignments is the intended off-boarding.* An
   admin can reassign `coach_id` and let coverage grants lapse. But that removes
   the coach's *athlete* access while leaving them a live, signing-in staff
   account in the organization — and it is manual, per child, with nothing
   listing what is left.
2. *Maybe Microsoft-side account disablement is the real answer.* Plausible as
   an operational practice, and it would work. It is also outside this platform,
   performed by whoever administers the tenant, and nothing in the product says
   so or prompts it. I cannot verify tenant practice from the repository and am
   not asserting either way; the in-product journey has no exit.

Severity **HIGH** — the action a gym takes when a coach must be kept away from
children is the one action its own admin cannot perform here.

### Journey 6 verdict

**SILENTLY INCOMPLETE in, BROKEN out.** Onboarding produces a working coach with
athletes assigned and no clearance record possible. Off-boarding does not exist
for the role that would need it.

---

## Journey 7 — A child is entered into a competition (re-checked against #452)

**Verdict: COMPLETE at the moment of entry. SILENTLY INCOMPLETE afterwards.**
F-01 is genuinely closed. What #452 did not add — and did not claim to — is any
re-check between the entry and the child stepping onto the mat.

### 7.1 The entry journey, end to end, as it stands on `origin/main`

UI: `/operations/external-competition` (and `/operations/wrestling-league`). The
entry POST is `page.tsx:221-229`, and it surfaces the server's own words on
refusal — `throw new Error(err.error || 'Entry failed (${response.status})')` —
so the gate's carefully written refusal text actually reaches the screen rather
than being replaced by a generic failure.

Route: `POST /api/pilot/operations/external-competition/entries`. Ordering is
correct and the comment says why (`entries/route.ts:66-71`):

```
    // The three safety gates, before the entry exists: this actor's standing
    // with this child, an active hold covering contact, and the guardian's
    // travel consent. An entry is the moment a child is committed to competing
    // somewhere else, and until now it was committed on a role string alone.
    // Run BEFORE the competition lookup inside addCompetitionEntry so no entry
    // row can be created down any path that skipped them.
```

Gate module: `competitionSafetyGates.ts` (see journey 1.5 for the quotes on why
it exists once rather than twice, and why all three gates refuse rather than
warn). It reaches both athlete-linking routes and nothing else —
`assertAthleteMayBeEnteredInCompetition` is imported by
`external-competition/entries/route.ts` and `wrestling-league/roster/route.ts`,
and by no third caller.

**F-01 is closed. Re-checked as instructed, and the fix is better than the
finding asked for**: it also covers the wrestling-league roster, widens the hold
scope set correctly, and treats every competition as travel because the schema
cannot distinguish home from away — *"guessing wrong in the permissive direction
is a child in a vehicle without consent. Fail closed until a real home/away
distinction exists to read."* (`competitionSafetyGates.ts:229-233`).

### 7.2 FINDING J7-A — nothing re-runs the gate after the entry exists

`assertAthleteMayBeEnteredInCompetition` runs on `POST` only. Traced both
directions:

- **A hold placed after entry does not remove the entry.** `placeTrainingHold`
  writes the hold row and files its escalation, and nothing else (journey 1.4).
  There is no `update pilot.external_competition_entries`, and no sweep. The
  child remains entered, with a hold covering contact active. (Same shape as
  F-02 for registrations; recorded here because the consequence is different in
  kind — a competition is a single scheduled contact event with travel attached,
  not a recurring class.)
- **Nothing re-checks at result-recording time.** `PATCH` on the same route
  handles `status` (withdrawal) and `result` (`entries/route.ts:104-120`) and
  calls no gate.
- The gate's own blocked-attempt record is written to
  `pilot.safety_gate_evaluations` for the *refused* attempt
  (`competitionSafetyGates.ts:193`), which is the right thing; there is no
  corresponding periodic re-evaluation of entries already granted.

So the honest statement of the current gate: **an entry proves the child was
clear at the instant the entry was typed.** The screen that lists entries shows
no hold state, so an admin looking at the entry list on competition morning
cannot see that one of the entered children has been held since.

### 7.3 FINDING J7-B — the travel waiver is the only waiver that gates a
safety-critical action, and a guardian has no way to withdraw it

Gate 3 reads `getAthleteWaiverStatus(organizationId, athleteId, TRAVEL_WAIVER)`
(`competitionSafetyGates.ts:235`) and refuses on anything but `'signed'`, with
refusal text that correctly distinguishes `declined` and `withdrawn` from missing
paperwork — *"That is a decision on file, not missing paperwork -- only a newly
signed travel waiver changes it."*

But the guardian's own consent page handles exactly one waiver type. `POST
/api/pilot/parent/consent` routes both decisions through
`grantMediaConsent`/`withdrawMediaConsent`, and the type is fixed at
`guardianConsent.ts:44`:

```
export const MEDIA_CONSENT_WAIVER_TYPE = 'photo_media';
```

The only surface that can write a `travel` row is `/admin/consent`, whose form
carries `{ value: 'travel', label: 'Travel and competition' }`
(`admin/consent/page.tsx:65`) and statuses `signed / declined / withdrawn`
(`:76-80`) — an **admin-only** screen. So the consent that decides whether a
minor gets into a vehicle can only be recorded, or revoked, by the gym, on the
guardian's behalf, with `signed_by_role` self-declared from a dropdown (F-27's
mechanism).

*Refutation attempt, successful in one direction:* the `/parent/consent` page does
**not** over-claim — its scope sentence is explicit: *"It controls one thing:
whether photos or videos of your child may be used in gym publications"*
(`page.tsx:113-114`). So the guardian is not misled about what the button
covers. That keeps this at **MEDIUM**: it is a missing capability on the
guardian's side, not a false statement. The asymmetry is still worth naming — the
platform gives a guardian a self-service lever for the consent that gates a
photograph, and none for the consent that gates transporting their child.

### Journey 7 verdict

**COMPLETE at entry, SILENTLY INCOMPLETE thereafter.** #452 turned the worst
finding in this audit into one of its best pieces of code. The remaining gap is
that the gate is a point check on a commitment that lasts until the event.

---

# Summary

## Journeys traced: 7 of 7

| # | Journey | Verdict |
|---|---|---|
| 1 | Coach places a medical hold | **BROKEN** — no screen can place one; silently incomplete downstream |
| 2 | Guardian withdraws consent | **SILENTLY INCOMPLETE** |
| 3 | Guardian finds out what is happening | **SILENTLY INCOMPLETE** + self-contradicting card |
| 4 | New athlete enrolled | **SILENTLY INCOMPLETE** |
| 5 | Incident reported | **Filing COMPLETE; response BROKEN** |
| 6 | Admin onboards a coach | **SILENTLY INCOMPLETE in, BROKEN out** |
| 7 | Child entered into competition | **COMPLETE at entry, SILENTLY INCOMPLETE after** (F-01 confirmed closed) |

## Findings by severity

All are new to this audit unless marked. Every one carries its quote and
`path:line` in the journey above; the table is an index, not the evidence.

### HIGH

| ID | Finding | Journey |
|---|---|---|
| **J1-A** | **No screen in the platform places or lifts a training hold.** `POST /api/pilot/training-holds` `action:'place'` has zero client callers; the only three client references are GETs. The register that gates class registration, competition entry, the athlete banner and the guardian's safety page has no writer any coach or admin can reach | 1 |
| **J1-B** | Attendance check-in consults no hold and raises no flag. A medically held child is marked present with no block, no near miss and no escalation — `attendance*.ts` contains no `hold` reference at all | 1 |
| **J2-A** | The consent-withdrawal sweep is keyed on `video_publications.athlete_id`, so group footage of the child filed under another child stays published — while the confirm dialog promises "**Anything** already published of {childName} will be retracted from distribution immediately". The publish gate likewise consults one child's guardians for a two-child clip | 2 |
| **J2-B** | A video uploaded with no `athlete_id` is outside the access check, outside every consent read, outside the withdrawal sweep, and outside the safety escalation — `videoScanSweep.ts:170` gates the escalation on `claim.athlete_id` | 2 |
| **J4-A** | Enrollment is not a precondition for training. `registerForClassTransactionally` reads no waiver, no guardian link and no clearance; `getAthleteWaiverStatus` has exactly one gate caller (the travel waiver, competitions only). `general` and `medical_release` gate nothing | 4 |
| **J5-A** | A guardian is never told about an incident involving their child. `/api/pilot/parent/safety` excludes `pilot.safety_escalations` wholesale on reasoning written entirely about `athlete_voice`, one of nine source types; incidents are forced to `high`/`critical`; there is no notification channel by design | 5 |
| **J5-B** | Filing an incident changes nothing about the child, and the escalation queue's three actions (acknowledge / resolve / scan_patterns) cannot either. Combined with J1-A, an admin reading "critical incident" has **no in-product control that pauses that child's training** | 5 |
| **J6-A** | The clearance register (PA Act 153 / Act 15) — module, migration, view, pg test, apply script — is imported by nothing. All five exported functions have zero non-test callers; `person_clearances` appears in four files, none of them a route or a page | 6 |
| **J6-B** | A gym admin cannot off-board a coach. Deactivation requires `platform_owner`; the admin's only lever is a session revoke that leaves `active_flag` true, so the coach signs in again. `/admin/people` renders a `Deactivated` badge for a state it cannot set | 6 |

### MEDIUM

| ID | Finding | Journey |
|---|---|---|
| **J3-A** | `/parent/safety` can render "No training pause on file right now" and "Active Training Hold — Not clear" on the same card: one is a live condition, the other is the latest-ever evaluation, and no writer ever records that gate as `passed`. Mechanism is the audit's F-07 (LOW); **#452 added two more writers of the permanent `blocked`** | 3 |
| **J3-B** | `attendancePrecedence.ts` — "the ONE way to ask this platform how many days somebody attended" — has zero callers, while `attendanceReporting.ts` answers from one of three sources and the roster CSV carries a hand-copied third formula. The guardian is shown nothing | 3 |
| **J4-B** | `parent_reviewed` is consumed by nothing but a display string, and an admin can set it in the guardian's name — `markSchedulerRegistrationReviewed` stamps the acting account into `parent_reviewer_account_id`, and the `UPDATE` carries no `where parent_reviewed = false` guard | 4 |
| **J7-A** | Nothing re-runs the competition gate after entry. A hold placed, or travel consent withdrawn, after the entry leaves the entry standing, and the entry list shows no hold state | 7 |
| **J7-B** | The travel waiver is the only waiver gating a safety-critical action, and no guardian-facing surface can grant or withdraw it — `/parent/consent` is fixed to `photo_media`; `travel` is admin-only, with `signed_by_role` chosen from a dropdown | 7 |
| **J6-C** | `assertActiveCoachAccount` guards the coverage-grant and 1:1-assignment paths but **not** the permanent `coach_id` assignment; the only constraint there is an FK to `pilot.accounts(account_id)`, so a non-coach or deactivated account can hold a column that `profileDb` converts into `coach_of_subject` minor-circle access | 6 |

### LOW

| ID | Finding | Journey |
|---|---|---|
| **J3-C** | Three "Unavailable - not yet tracked" rows on the parent hub sit under a comment asserting *"Membership/scholarship/community-service status has no backing column anywhere in the schema"*. `pilot.program_memberships` (with `scholarship_percent`) and `pilot.activity_log`'s `community_service` domain both now exist. Withholding may still be the right call; the stated reason is false | 3 |
| **J5-C** | `resolved` is terminal on `pilot.safety_escalations` — no reopen exists, unlike `reopenRetractedPublication`. A mis-resolved incident cannot be reopened, only superseded by a new filing | 5 |
| **J4-C** | `auditEventTypes.ts:39` states `photo_media` is *"the one waiver_type this platform gates something on"*; #452 made `travel` a second. Stale-by-merge | 4 |

## The single worst break

**J1-A compounded with J5-B.** Not either one alone.

The platform's answer to "a child must stop training right now" is the training
hold. The module is excellent: transactional, attributed, expiring, linear, with
its escalation filed in the same transaction, an athlete-safe projection reused
identically on four screens, and — since #452 — enforcement at class
registration and at competition entry with correctly differentiated scope sets.
Six surfaces read it.

**Nothing can write it.** No coach page, no admin page, no other server module,
no raw SQL outside the route and its tests. And the register that would trigger
its use — the safety-escalation ladder, which is where a filed incident lands
and the only escalation mechanism the platform has — offers exactly three
actions, none of which changes anything about the child.

So the end-to-end journey that matters most in a gym holding minors' records is:
a coach files a critical incident → it is recorded correctly, deduplicated,
severity-floored, and lands in the admin queue → the guardian cannot be told
→ and the admin has no control anywhere in the product that stops the child
training. The stopping mechanism exists, is enforced in the right places, and is
unreachable.

That is exactly the seam this pass was run to find: two individually correct
modules — `trainingHolds.ts` and `escalationLadder.ts` — with nothing between
them and no door into either.

## Also noted, as asked

**Contradictions between screens about the same child**

1. `/parent/safety`: "No training pause on file right now" vs. "Active Training
   Hold — Not clear", same card (J3-A).
2. Attendance: `attendanceReporting.ts` (one source), the roster CSV (copied
   formula), `attendancePrecedence.ts` (reconciled view, unreachable) — three
   possible answers, and the guardian gets none (J3-B).
3. `/coach/sports-medicine` shows a hold with its lift condition while the
   child's existing class bookings — unaffected by that hold — live on another
   screen entirely (1.4).
4. Not re-reported: the waiver console vs. the media gate (F-16), and the live
   coach roster vs. a withdrawn child (F-26 / X-02), both of which reach the
   guardian journey.

**State machines with no exit**

- `pilot.safety_escalations`: `resolved` is terminal, no reopen (J5-C).
- `pilot.video_publications`: has one, and it is the model to copy —
  `reopenRetractedPublication` goes *backwards* into review with the compliance
  check reset, so *"Re-consent alone republishes nothing."*
- The `training_hold` safety gate has no `passed` transition at all, which is
  why the guardian's badge never clears (J3-A).

**Capabilities no journey reaches**

- Placing or lifting a training hold — API only (J1-A).
- The clearance register in its entirety (J6-A).
- `attendancePrecedence.ts`, all four functions (J3-B).
- Coach deactivation, for any role inside a gym (J6-B).
- `parent_reviewed`, collected and consumed by nothing (J4-B).
- Already known: `readinessMath.ts` (F-08), `seatRequiresMicrosoft` (A-03),
  `/admin/data-deletion` (D-03). Consistent with those, not new evidence for them.

## Where tracing stopped, and why — no gap filling

Stated plainly rather than papered over:

1. **Runtime behaviour was not observed.** Every finding here is read from source
   at `origin/main` `0485cf81`. Per this repository's own invariant 5, code
   reading is not runtime proof. Nothing in this file was executed; no test was
   run; no database was queried.
2. **J6-B's Microsoft-tenant question is open.** Disabling the coach's account in
   the Entra tenant would work and is outside the repository. I checked that no
   in-product route does it and that nothing in the product says to; I did not
   and cannot establish what the gym actually does.
3. **J6-A's real-world Act 153 records are outside scope.** The finding is that
   the platform's clearance register is unreachable, not that clearances do not
   exist in a filing cabinet.
4. **J2-A's group-footage frequency is inferred, not measured.** The schema
   permits it (`athlete_id` is one nullable scalar; publications carry one
   athlete) and the module documents the boundary. I did not examine any data and
   cannot say how many published clips contain a second child.
5. **The SHADOW journeys were not traced.** A coach or athlete conversing with
   SHADOW, and the recommendation → decision → outcome loop, are whole journeys
   this pass did not reach. Passes 8 and 16 cover the subsystem; the *journey*
   through it is an admitted hole in this pass.
6. **Payments, gear, grants, volunteers, board and the wall were not traced as
   journeys.** The brief named seven; these are not among them, and I did not
   sample them.
7. **`/guardian` (the Guardian Portal nav entry) was not opened.** It appears in
   `buildingMap.ts:172` and I traced the four `app/parent/*` pages instead. If it
   carries a fifth guardian surface, journey 3 is incomplete by that much.
8. **J6-C's cross-organization consequence was not established.** The FK is on
   `account_id` alone, so a same-id cross-org `coach_id` is not blocked by the
   database — but `profileDb`'s relationship resolution runs inside an
   org-scoped principal and I did not follow it far enough to say whether a
   cross-tenant read is actually reachable. Filed at MEDIUM on the
   within-organization consequence only.

