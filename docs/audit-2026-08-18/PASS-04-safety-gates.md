# Pass 4 — Safety gates

Read-only audit of the enforcement side of every safety mechanism, run against
`origin/main` at `04dd116b` on branch `docs/full-spectrum-audit-2026-08-18`.
No application code was changed. This file is the pass's only write.

---

## URGENT

**A child under an active `all_training` training hold can be entered into an
external boxing competition, or added to a wrestling league season roster, today,
with one authenticated request. Neither write consults the hold, the medical
administrative status, the safety-gate matrix, the clearance register, or a
waiver.** The full finding is [F-01](#f-01-critical--competition-entry-and-league-roster-consult-no-safety-record-at-all)
below.

This is **already known and already fixed on an unmerged branch**
(`origin/fix/competition-safety-gates`, three commits ahead of `main`, adding
`apps/web/src/server/pilot/competitionSafetyGates.ts`). `docs/capabilities/NETWORK_STATUS.md`
lists "the competition-entry gates" among the findings that had a PR open when
it was written. It is reported here at the top anyway because **the branch has
not merged**, and the audit's own README says anything indicating a child is
currently unsafe is raised immediately rather than held. The action needed today
is a merge decision by a human, not new work.

Second, lower but same day: **placing a training hold does not cancel or flag the
registrations the athlete already holds**, and the attendance check-in path never
re-checks the hold. See [F-02](#f-02-high--the-stop-rung-is-checked-once-at-registration-and-never-again).

---

## Method

### Read in full (26 files)

Server modules: `trainingHolds.ts`, `escalationLadder.ts`, `contactClearanceGate.ts`,
`clearanceRegister.ts`, `sparringExposure.ts`, `safetyReview.ts`, `safetyGateSeeds.ts`,
`readinessBoard.ts`, `readinessMath.ts`, `coachIntelligence.ts`, `shadowMedicalStatus.ts`,
`shadowAuthority.ts`, `externalCompetition.ts` (partial — the entry/result/withdraw
half), `wrestlingLeague.ts` (partial — the roster half), `formulas/painReportAlert.ts`
(head), `formulas/primitives.ts` (the ACWR primitive).

Routes: `api/pilot/training-holds/route.ts`, `api/pilot/incidents/route.ts`,
`api/pilot/escalations/route.ts`, `api/pilot/parent/safety/route.ts`,
`api/pilot/shadow/formulas/observations/route.ts`, `api/pilot/shadow/medical-status/route.ts`,
`api/pilot/admin/coach-coverage/route.ts`, `api/pilot/coach/behavior-standards/route.ts`,
`api/pilot/operations/external-competition/entries/route.ts`,
`api/pilot/operations/wrestling-league/roster/route.ts`,
`api/pilot/intake/domain-upsert/route.ts`, and the attendance/registration half of
`api/pilot/scheduler/route.ts`.

Screens: `app/admin/safety-review/page.tsx`, `app/admin/escalations/page.tsx`,
`app/parent/safety/page.tsx`, `components/TrainingHoldBanner.tsx`,
`app/operations/external-competition/page.tsx`, `app/schedule/page.tsx` (grepped
for hold references, not read line by line).

### Grepped (the bypass hunt)

Every writer of `pilot.training_holds` (3 statements, all in `trainingHolds.ts`);
every writer of `pilot.safety_escalations` (2 statements in `escalationLadder.ts`,
reached by 7 distinct callers); every caller of `fileEscalation` / `fileIncidentReport`;
every caller of `recordSafetyGateEvaluation` (3 sites); every writer of
`pilot.shadow_formula_observations` (1 site); every writer of
`pilot.scheduler_registrations` / `pilot.scheduler_attendance` (3 statements);
every reference to `clearanceRegister` / `person_clearances` / `v_clearance_status`
outside its own test; every occurrence of `conditioning_only`; every duplicate
definition of `TrainingHoldScope`, `SafetyEscalationSourceType` and
`SafetyEscalationSeverity`; every caller of `assertShadowAuthority` and every
value of `restrictionConflict`.

Cross-checked against `git log --oneline origin/main -40` and all 143 remote
branches to separate "not built" from "built on a branch that has not merged".

### Not reached

- No code was executed. Every claim here is source-read; per invariant 5 of
  `AGENT_KERNEL.md`, code-reading alone is not runtime proof.
- The 93 Postgres-backed suites were not run, so claims about what the database
  itself enforces rest on reading the migration SQL, not on observing a
  constraint fire.
- SHADOW chat, video scan internals, and the formula runner were touched only
  where they write into a safety register. Passes 8 and 9 own those.
- `packages/execution/safetyGate.ts` was not re-examined; the 2026-08-17
  full-spectrum audit already established it as dead legacy code never imported
  by the live app, and nothing found here contradicts that.

---

## Gate inventory

### 1. Training hold — STOP (`all_training`, class registration)

**Enforces:** an active `all_training` hold refuses a new class registration.
**Enforced at:** `apps/web/src/server/pilot/schedulerDb.ts:221`, inside
`registerForClassTransactionally`'s own transaction, via
`findRegistrationBlockingHold` (`apps/web/src/server/pilot/trainingHolds.ts:372`).
Returns a 403 at `apps/web/app/api/pilot/scheduler/route.ts:461`.

Bypasses looked for:
- *Another registration writer?* No. `pilot.scheduler_registrations` has exactly
  one INSERT, at `schedulerDb.ts:252`, inside the same transaction. **Sound.**
- *Another hold writer that could pre-empt it?* No. `pilot.training_holds` has
  exactly three write statements, all in `trainingHolds.ts` (117, 180, 252).
  **Sound.**
- *A stale `status='active'` row surviving its expiry?* Guarded twice — the
  read-time predicate `(expires_at is null or expires_at > now())` at
  `trainingHolds.ts:381`, and `sweepExpiredHolds`. **Sound.**
- *A path to the class that skips registration?* **Yes — attendance.** See
  [F-02](#f-02-high--the-stop-rung-is-checked-once-at-registration-and-never-again).
- *Does deactivating the `safety_gates` row disarm it?* No — `findRegistrationBlockingHold`
  never reads `pilot.safety_gates`; the gate row is consulted only to decide
  whether an evaluation can be *recorded*. Fails safe. **Sound.**

### 2. Training hold — REGRESS (`contact_only`, contact observation)

**Enforces:** nothing. It *flags*. Contact logged while an `all_training` or
`contact_only` hold is active raises a `high` near miss, which auto-escalates.
**Enforced at:** `trainingHolds.ts:438` (`flagContactDuringHold`), called from
`apps/web/app/api/pilot/shadow/formulas/observations/route.ts:141`.

Bypasses looked for:
- *Another contact-observation writer?* `saveFormulaObservation` has one caller,
  the same route. `sparringExposure.ts:111` (`recordSparringExposure`) is a
  second, structurally independent way to record that a child took contact —
  and it consults nothing — but it has **zero callers** outside its own test
  file, so it is not reachable. Recorded under
  [Checked and found sound](#checked-and-found-sound), not as a finding.
- *Union drift on the contact vocabulary?* `CONTACT_OBSERVATION_KINDS` is
  defined once (`contactClearanceGate.ts:27`) and `trainingHolds.ts` imports
  `isContactObservation` from it rather than restating the list. **Sound, and
  the right shape.**

### 3. Training hold — REGRESS (`conditioning_only`)

**Enforces:** nothing, anywhere. Independently verified — see
[F-06](#f-06-medium--all-three-hold-scopes-overstate-their-enforcement-not-only-conditioning_only).

### 4. Contact medical clearance (`contact_medical_clearance`)

**Enforces:** flags — never blocks, by explicit doctrine
(`contactClearanceGate.ts:91`, "WHY THIS DOES NOT REFUSE THE WRITE"). Contact
logged for an athlete whose latest `pilot.shadow_medical_administrative_status`
is not exactly `'cleared'` raises a near miss at `critical` (for `not_cleared` /
`restricted`) or `high` (for `pending` / no record).
**Enforced at:** `contactClearanceGate.ts:119`, called at
`observations/route.ts:126`, before the observation is persisted.

Bypasses looked for:
- *Is the fail-closed default real?* Yes: `if (record?.status === 'cleared')` at
  `contactClearanceGate.ts:144` is the only pass. Absence of a record flags.
  **Sound.**
- *Can an org disarm it?* Yes, deliberately: `if (gate && !gate.active_flag)
  return { flagged: false }` at `contactClearanceGate.ts:134`. Documented as a
  per-org configuration decision. Recorded, not a finding.
- *Second writer of medical status?* `setMedicalAdministrativeStatus` has exactly
  one caller, `api/pilot/shadow/medical-status/route.ts:76`. **Sound.**
- *But can the restricting statuses ever be set?* Only by an API call — the
  one screen that reads this data, `/coach/sports-medicine`, issues `GET` only.
  See [Could not establish](#could-not-establish).

### 5. Competition entry / league roster

**Enforces:** nothing. See [F-01](#f-01-critical--competition-entry-and-league-roster-consult-no-safety-record-at-all).

### 6. Act 153 / SafeSport clearance register

**Enforces:** nothing, by its own declaration. `clearanceRegister.ts:12`:
`// THIS MODULE DOES NOT AUTHORIZE ANYTHING.` Zero callers outside
`clearanceRegister.pg.test.ts` — grep across `apps/`, `packages/` and `scripts/`
for `clearanceRegister`, `person_clearances`, `clearance_types`,
`activity_clearance_requirements` and `v_clearance_status` returns only the
module, its test, and the migration. **NETWORK_STATUS.md's claim of zero callers
is confirmed exactly.**

### 7. Coach Coverage grant

**Enforces:** that the grantee is an active coach account in the same org, and
that the athlete belongs to the org. Nothing about clearance.
`apps/web/src/server/pilot/access.ts:153`:

> `await assertActiveCoachAccount(params.organizationId, params.coveringCoachId, 'covering_coach_id');`

Confirmed as NETWORK_STATUS.md describes it. **Already known — cited, not
re-reported.** One consequence worth adding, which that document does not draw
out: `assertCoachAssignedToAthlete` admits coverage-grant holders, and the
training-holds route uses that same function to authorise a **lift**
(`training-holds/route.ts:258`), so a covering coach can lift a `medical`-category
hold placed by an org admin. That follows from the recorded owner decision at
`training-holds/route.ts:33-40` and is listed under
[Checked and found sound](#checked-and-found-sound) as a decision, not a defect.

### 8. Incident report filing

**Enforces:** a severity floor of `high`/`critical`, and idempotency within a
30-second window. **Enforced at:** `escalationLadder.ts:241` (the floor, checked
inside the module so it survives a caller that bypasses TypeScript) and
`escalationLadder.ts:257` (the `where not exists` on the INSERT).
**Bypass found:** a second writer of `source_type = 'incident'` that passes
through neither. See [F-04](#f-04-medium--a-second-incident-filer-bypasses-both-the-severity-floor-and-the-idempotency-window).

**Who is notified:** nobody. There is no notification channel — `escalationLadder.ts:12`
states it plainly ("no email, ever"), so the register and the pages that read it
*are* the mechanism. An incident filed at `critical` reaches `/admin/escalations`
and the coach-scoped `GET /api/pilot/escalations`, and reaches the Morning Read
(`coachIntelligence.ts`) **not at all** — its five items are stalled gaps,
readiness reds, fading attendance, unreviewed sessions and expiring holds. That
blind spot is already recorded (NETWORK_STATUS.md, "the Morning Read digest's
blind spot") and has an unmerged branch, `origin/fix/morning-read-safety-blind-spot`.

### 9. Acute:chronic workload

**Not a gate.** `acuteChronicWorkloadRatio` (`formulas/primitives.ts:160`) is a
division with three input guards and no threshold; nothing compares its output to
a band, and no caller refuses anything on it. `sparringExposure.ts:10` states the
matching refusal: `// WHAT THIS MODULE REFUSES TO DO ... no damage score, no
cumulative risk index, no recommended limit, no clearance.` This is a deliberate
absence, correctly documented. Listed here so a reader does not go looking for a
threshold that was never meant to exist.

---

## The safety escalation register: writers and readers

`pilot.safety_escalations` has exactly **two INSERT statements**, both in
`escalationLadder.ts` (lines 100 and 250). Everything below reaches one of them.

### Writers — 8 call paths, 7 distinct source types

| # | Writer | `source_type` | Trigger | Severity source | Transactional with its own record? |
|---|---|---|---|---|---|
| 1 | `shadowNearMisses.ts:85` (`flagNearMiss`) | `near_miss` | any near miss at `high`/`critical` | the near miss's own | yes, same client |
| 2 | `trainingHolds.ts:211` (`placeTrainingHold`) | `training_hold` | every hold placement | `high` if `all_training`, else `moderate` | yes, same client |
| 3 | `compliance.ts:183` (`createComplianceViolation`) | `compliance_violation` | violation whose rule's `escalation_level` maps to `coach`/`organization_admin` | mapped from compliance vocabulary | yes, same client |
| 4 | `videoScanSweep.ts:171` (`sweepQuarantinedVideos`) | `video_scan` | terminal negative scan verdict, only when `claim.athlete_id` is set | mapped from scan decision | no — deliberately not swallowed, sweep retries |
| 5 | `athleteVoice.ts:128` (`fileAthleteVoiceEscalation`) | `athlete_voice` | feedback submission matching the safety-language scan | derived from cues | no |
| 6 | `escalationLadder.ts:515` (`detectRepeatedPatternEscalations`) | `repeated_pattern` | on-demand admin scan; ≥3 near misses on one athlete+trigger in 30 days | max severity in the group | no — query-then-insert, documented accepted race |
| 7 | `escalationLadder.ts:250` (`fileIncidentReport`) | `incident` | `POST /api/pilot/incidents` | caller's, floored at `high` | n/a — single atomic INSERT…SELECT |
| 8 | **`behaviorStandards.ts:165` (`raiseConductConcern`)** | **`incident`** | `POST /api/pilot/coach/behavior-standards` with `action: 'raise_concern'` | **caller's, no floor** | no |

Writers 7 and 8 are two capabilities filing the same `source_type` under
different invariants — the collision class NETWORK_STATUS.md names. See
[F-04](#f-04-medium--a-second-incident-filer-bypasses-both-the-severity-floor-and-the-idempotency-window).

`safety_gate_evaluation` is a declared member of the union
(`escalationLadder.ts:29`) and of the database CHECK constraint
(`pilot_slice_postgres_safety_escalations_migration.sql:121`) with **no writer at
all**. A safety-gate evaluation reaches the ladder only indirectly, as a near
miss.

### Readers — 6

| Reader | Path | Scope | Notes |
|---|---|---|---|
| `GET /api/pilot/escalations` | `app/api/pilot/escalations/route.ts:72` | coach → own + covered athletes, `athlete_voice` excluded; org_admin/admin → all | role split is correct and tested in-file |
| `/admin/escalations` | `app/admin/escalations/page.tsx:295` | admin surface | **stale local union — see F-05** |
| `CoachWorkspace.tsx:1370` | component | coach | reads `source_type: string` with a `?? escalation.source_type` fallback — drift-safe |
| `safetyReview.ts:106` → `/admin/safety-review` | `app/admin/safety-review/page.tsx:171` | admin | **double-counts — see F-03** |
| `GET /api/pilot/board/escalation-summary` | `escalationLadder.ts:562` | board | count-only, k-anonymity gated at `BOARD_MINIMUM_COHORT_SIZE = 5`; never returns rows |
| `escalationLadder.ts:502` | internal | pattern detector's own idempotency check | reads to avoid a duplicate `repeated_pattern` |

Deliberate non-readers, verified: `parent/safety/route.ts:25` excludes the table
entirely with its reasoning stated; `coachIntelligence.ts` does not read it (the
Morning Read blind spot, known); board reads only the summary.

---

## Safety constants

| Constant | Value | Defined at | Read at | Agrees? |
|---|---|---|---|---|
| `READINESS_FRESHNESS_HOURS` | `24` | `readinessBoard.ts:19` | `readinessBoard.ts:58` | yes — single definition, single read |
| `READINESS_GREEN_MIN` | `7` | `readinessBoard.ts:24` | `readinessBoard.ts:37` | yes |
| `READINESS_YELLOW_MIN` | `4` | `readinessBoard.ts:25` | `readinessBoard.ts:38`; imported by `coachIntelligence.ts:4` and used as the RED cutoff at `coachIntelligence.ts:80` | yes — imported, not restated, exactly as its own comment claims |
| `READINESS_RED_DAYS` | `3` | `coachIntelligence.ts:21` | `coachIntelligence.ts:80` | yes |
| `READINESS_RED_WINDOW_DAYS` | `7` | `coachIntelligence.ts:22` | `coachIntelligence.ts:80` | yes |
| `HOLD_EXPIRY_DAYS` | `14` | `coachIntelligence.ts:28` | `coachIntelligence.ts:110` | yes — but the query it feeds does not exclude *already*-lapsed holds; see F-07 |
| `STALLED_GAP_DAYS` | `14` | `coachIntelligence.ts:19` | `coachIntelligence.ts:62` | yes |
| `UNREVIEWED_SESSION_DAYS` | `7` | `coachIntelligence.ts:26` | `coachIntelligence.ts:99` | yes |
| `ATTENDANCE_WINDOW_DAYS` | `28` | `coachIntelligence.ts:24` | `coachIntelligence.ts:83` | yes |
| `TRAINING_DAYS_MIN_EARLY` | `3` | `progressionSuggestions.ts:41` | imported at `coachIntelligence.ts:3`, used `coachIntelligence.ts:126` | value agrees; the **comparison operator does not** — already recorded in NETWORK_STATUS.md ("a comment claims an invariant the code does not hold"), not re-reported |
| `TRAINING_DAYS_DROP_RATIO` | `0.5` | `progressionSuggestions.ts:42` | `coachIntelligence.ts:127` | same as above |
| `READINESS_DROP_POINTS` | `1.0` | `progressionSuggestions.ts:39` | `progressionSuggestions.ts` internal | yes |
| delta-RPE lock threshold | `2` | `readinessMath.ts:26` (`if (deltaRpe < 2)`) | **nowhere** | **disagrees — zero callers. See F-08** |
| readiness clamp | `1`–`10` | `readinessMath.ts:17` (`clamp(rawScore, 1, 10)`) | **nowhere** | **disagrees — zero callers, and the score that *is* stored is unvalidated. See F-08** |
| pain-report severity bands | `>= 7` critical, `>= 4` high | `formulas/painReportAlert.ts:57-59` — bare literals, not named | same function | yes, but unnamed; a second copy would be invisible to grep |
| `PAIN_REPORT_ALERT_WINDOW_DAYS` | `7` | `formulas/painReportAlert.ts:43` | its own module + surfaced to the coach | yes |
| `INCIDENT_DEDUP_WINDOW_SECONDS` | `30` | `escalationLadder.ts:208` | `escalationLadder.ts:277`, `:322` | yes — but bypassed entirely by writer 8. See F-04 |
| `DEFAULT_PATTERN_WINDOW_DAYS` / `DEFAULT_PATTERN_THRESHOLD` | `30` / `3` | `escalationLadder.ts:452-453` | `escalationLadder.ts:481-482`, clamped to `[1,365]` and `>= 2` | yes |
| `DEFAULT_COVERAGE_TTL_HOURS` / `MAX_COVERAGE_TTL_HOURS` | `24` / `336` | `access.ts:95`, `access.ts:101` | `resolveCoverageTtlHours` | yes |
| `BOARD_MINIMUM_COHORT_SIZE` | `5` | `boardSummary.ts:3` | `escalationLadder.ts:587`, compliance summary | yes |
| contact limits | — | **do not exist** | — | n/a — `sparringExposure.ts:10-13` refuses to define one, deliberately |

**Duplicate union definitions found (the drift class):**

- `TrainingHoldScope` — **5 definitions**: `trainingHolds.ts:45` (canonical),
  `components/TrainingHoldBanner.tsx:24`, `app/parent/safety/page.tsx:8`,
  `app/admin/safety-review/page.tsx:14`, `app/coach/progression-intelligence/page.tsx:89`.
  Three of the four copies back an exhaustive `Record<…, string>`. See F-09.
- `SafetyEscalationSourceType` — **2 definitions**: `escalationLadder.ts:29`
  (9 members) and `app/admin/escalations/page.tsx:11` (6 members). Already
  divergent. See F-05.
- `SafetyEscalationSeverity` — **7 textually identical definitions** across
  `escalationLadder.ts:28`, `shadowNearMisses.ts:5`, `CoachWorkspace.tsx:139` and
  `:174`, `admin/safety-review/page.tsx:8`, `admin/escalations/page.tsx:9`,
  `coach/decision-loop/page.tsx:10`. All currently agree; all would need to be
  found by grep if a member were ever added, and only the two server-side ones
  would fail typecheck.

---

## Findings

### F-01 [CRITICAL] — Competition entry and league roster consult no safety record at all

`addCompetitionEntry` verifies exactly two things: that the competition exists in
the caller's organization, and that the athlete exists in the caller's
organization. Then it inserts.

`apps/web/src/server/pilot/externalCompetition.ts:160-165`:

> ```
>   const athlete = await queryOne<{ athlete_id: string }>(
>     `select athlete_id from pilot.athletes
>      where organization_id = $1 and athlete_id = $2`,
>     [input.organizationId, input.athleteId],
>   );
>   if (!athlete) return null;
> ```

That is the last check before the INSERT at `externalCompetition.ts:169`. There
is no read of `pilot.training_holds`, `pilot.shadow_medical_administrative_status`,
`pilot.safety_gates`, `pilot.person_clearances`, or any waiver table anywhere in
the function.

`addLeagueRosterEntry` is byte-for-byte the same shape —
`apps/web/src/server/pilot/wrestlingLeague.ts:214-219` — and inserts at
`wrestlingLeague.ts:223`.

The routes above them add nothing. `apps/web/app/api/pilot/operations/external-competition/entries/route.ts:49-57`:

> ```
>     if (!body.competition_id?.trim()) throw new ValidationError('Missing competition_id.');
>     if (!body.athlete_id?.trim()) throw new ValidationError('Missing athlete_id.');
>
>     const item = await addCompetitionEntry({
>       organizationId: principal.organizationId,
>       competitionId: body.competition_id.trim(),
>       athleteId: body.athlete_id.trim(),
>       createdByAccountId: principal.accountId,
>     });
> ```

**Refutation attempted, four ways, all failed.**

1. *Does the UI narrow the athlete list?* No. `app/operations/external-competition/page.tsx:156`
   loads `/api/pilot/athletes/list` unfiltered and renders every row into the
   picker at `:447-449`. No hold badge, no clearance column, no disabled option.
2. *Does a role gate stand in?* `COMPETITION_WRITE_ROLES = ['organization_admin',
   'admin']` (`externalCompetition.ts:20`) restricts *who*, never *whom*. An org
   admin is precisely the person who would enter a held child by mistake.
3. *Does the database refuse it?* The only constraints reached are the org-scoped
   FK and `pilot_external_competition_entries_unique` (caught at
   `externalCompetition.ts:177` as a duplicate). No check involves a hold.
4. *Is it enforced somewhere upstream I have not read?* Grep for `training_hold`,
   `clearance`, `medical` and `safety` across both route files and both server
   modules returns one hit — a comment in `wrestlingLeague.ts:11` about name
   copying, unrelated to gating.

**De-duplication.** Known. NETWORK_STATUS.md lists the competition-entry gates
among the findings that had a PR open. That PR is `origin/fix/competition-safety-gates`,
which is **three commits ahead of `origin/main` and not merged** as of `04dd116b`.
Its own module doc corroborates this finding independently
(`competitionSafetyGates.ts` on that branch): "they are the only two
athlete-linking capabilities in the app that consulted nothing about the child
before writing the link". It adds three checks — actor access, a contact-blocking
hold, and a travel waiver — and a new `findContactEventBlockingHold` in
`trainingHolds.ts` that does not exist on `main`.

**Consequence for a child.** A child held out of all training after a head
knock — the hold placed correctly, the escalation filed correctly, the parent's
`/parent/safety` page reading "Training is paused right now" — is entered into a
sanctioned bout by an org admin working from the competition page, which shows
none of that. The platform's own record says the child must not train; the
platform's own competition surface enters them anyway, and files nothing to say
so.

**What is needed today:** a human decision to merge or reject
`origin/fix/competition-safety-gates`. No new implementation.

---

### F-02 [HIGH] — The STOP rung is checked once, at registration, and never again

`placeTrainingHold` does two things: it inserts the hold and it files the
escalation (`trainingHolds.ts:156-232`). It does not touch
`pilot.scheduler_registrations`. Registrations the athlete already holds survive
the hold untouched, and attendance check-in re-validates only that the
registration exists:

`apps/web/app/api/pilot/scheduler/route.ts:665-668`:

> ```
>       const registeredIds = await listRegisteredAthleteIdsForClass(actor.organizationId, classId);
>       if (!registeredIds.includes(athleteId)) {
>         throw new Error('Missing registration: athlete is not registered for this class');
>       }
> ```

Neither `attendance_checkin` nor `bulk_attendance_checkin` calls
`findRegistrationBlockingHold`, `getActiveTrainingHold`, or `flagContactDuringHold`.
Grep for `hold` across the whole 770-line route returns only the registration
block at `:418-461` and one comment.

**Refutation attempted, three ways.**

1. *Does anything cancel registrations when a hold lands?* No.
   `pilot.scheduler_registrations` has one UPDATE, `markSchedulerRegistrationReviewed`
   at `schedulerDb.ts:292`, which sets parent-review columns only.
2. *Does the coach see the hold at the door?* No. `app/schedule/page.tsx` — the
   only screen issuing `attendance_checkin` / `bulk_attendance_checkin` — contains
   no reference to holds; grep for `hold` returns six matches, all the word
   `placeholder`. `CoachWorkspace.tsx` likewise carries no hold surface.
3. *Is post-action flagging the intended answer, as it is for contact?* The
   module's own doctrine says a post-action record during a hold raises a near
   miss (`trainingHolds.ts:427-437`). Attendance is exactly that shape and raises
   nothing. So this is an inconsistency inside the module's stated doctrine, not
   a deliberate omission it documents.

**Not previously reported.** Neither prior audit mentions the registration/attendance
seam. `origin/fix/competition-safety-gates` does not touch the scheduler.

**Consequence for a child.** A child registers Monday for Saturday's class. On
Wednesday a coach places an `all_training` hold — concussion, `reason_category:
'medical'`. On Saturday the child arrives; the roster still lists them; the coach
taps check-in; it succeeds; nothing is flagged and no escalation is filed. The
STOP rung stopped a registration that had already happened. The gate is real but
its window is one instant.

**Severity note.** Marked HIGH, not CRITICAL, deliberately. Marking attendance is
a record of presence, not an authorisation to train, and the same doctrine that
makes `flagContactDuringHold` a flag rather than a block argues against refusing
the attendance write. The defect is that it flags *nothing at all* — and that no
surface a coach reads at the door shows the hold. I am not inflating it to
CRITICAL on the reading that "present" implies "trained", because the code does
not say that.

---

### F-03 [MEDIUM] — /admin/safety-review counts one incident twice, in the headline number

`getOrganizationSafetyReview` reads four registers in one `Promise.all` and
returns all four (`safetyReview.ts:103-134`). Two of them overlap by
construction: `createComplianceViolation` files a `compliance_violation`
escalation in the same transaction as the violation (`compliance.ts:183`, merged
as #440 on 2026-08-17), and `placeTrainingHold` files a `training_hold`
escalation in the same transaction as the hold (`trainingHolds.ts:211`).
`listEscalations(organizationId, {})` returns both.

Nothing deduplicates. The page then sums all four lists:

`apps/web/app/admin/safety-review/page.tsx:96-98`:

> ```
>   const totalOpen = review
>     ? review.openHolds.length + review.failingGates.length + review.openEscalations.length + review.openViolations.length
>     : 0;
> ```

**Refutation attempted, three ways.**

1. *Does `safetyReview.ts` filter by `source_type`?* No — `listEscalations(organizationId, {})`
   at `:106` passes an empty filter object, and the only post-filter is
   `escalation.status !== 'resolved'` at `:129`.
2. *Does the escalation carry a link the page could join on?* It does —
   `metadata.violation_id` (`compliance.ts:196`) and `metadata.hold_id`
   (`trainingHolds.ts:225`) — but the page's `EscalationItem` interface
   (`page.tsx:27-35`) does not declare a `metadata` field at all, so it could not
   join even if it wanted to.
3. *Is this the collision NETWORK_STATUS.md already caught?* Partly, and this is
   the important distinction. That document records the collision being caught
   **before merge, on the Morning Read** ("Items 6 and 7 were about to report the
   same incident twice" — `origin/fix/morning-read-safety-blind-spot`). The same
   two writers land on `/admin/safety-review`, which merged first and was never
   revisited. So this is the *second instance of a known collision class on a
   different reader*, not a re-report of the same instance.

**Consequence for a child.** Not direct. It degrades the one screen whose whole
purpose is "everything open, right now, across the four safety systems"
(`page.tsx:108`). An admin working that list sees two rows for one event and a
headline count roughly double the real one, twice over — once for every hold and
once for every escalating violation. A number an admin learns to distrust is a
number that stops driving action.

---

### F-04 [MEDIUM] — A second `incident` filer bypasses both the severity floor and the idempotency window

`fileIncidentReport` defends its invariants inside the module, on purpose:

`apps/web/src/server/pilot/escalationLadder.ts:241-243`:

> ```
>   if (input.severity !== 'high' && input.severity !== 'critical') {
>     throw new Error(`fileIncidentReport: severity must be 'high' or 'critical', got '${String(input.severity)}'`);
>   }
> ```

Its own comment at `:232-240` explains why the check is duplicated there: "any
other caller (a script, a future route) could file a sub-floor severity with
nothing in this function or the database … to stop it."

That future caller exists. `raiseConductConcern` files the same `source_type`
through `fileEscalation` instead, and takes the severity straight from the
request.

`apps/web/src/server/pilot/behaviorStandards.ts:160` and `:165-167`:

> ```
>   severity: SafetyEscalationSeverity;
> ```
> ```
>   const escalation = await fileEscalation({
>     organizationId: input.organizationId,
>     sourceType: 'incident',
> ```

And the route feeding it accepts all four severities —
`apps/web/app/api/pilot/coach/behavior-standards/route.ts:37` and `:140-142`:

> ```
> const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
> ```
> ```
>       if (!isSeverity(body.severity)) {
>         throw new ValidationError("severity must be 'low', 'moderate', 'high', or 'critical' -- your judgment, stated.");
>       }
> ```

Consequences, both mechanical: an `incident` row can exist at `low`/`moderate`,
which the migration's design intent and `escalationLadder.ts:181-186` both say is
impossible; and the 30-second dedup window added by #433 ("Incident reports could
be double-filed by a retry", NETWORK_STATUS.md closed list) does not cover this
path — a double-tapped "raise concern" button files two identical rows.

**A second defect on the same route, found while checking this one.** The
`raise_concern` action performs `requireRole(principal, [...FLOOR_ROLES])` at
`route.ts:130` and no athlete-scoped check. Grep for
`assertActorCanAccessAthlete` and `assertCoachAssignedToAthlete` across the whole
file returns nothing. The comparable path, `POST /api/pilot/incidents`, does call
it (`incidents/route.ts:58`). So any coach in the organization can file a
conduct-concern escalation naming any athlete in that organization. Cross-org is
blocked by `principal.organizationId` scoping; cross-roster within an org is not.

**Refutation attempted.** I re-read the whole 200-line route looking for the
check under another name, and re-read `raiseConductConcern` and `fileEscalation`
looking for a floor or an access assertion inside them. `fileEscalation`
(`escalationLadder.ts:158`) validates nothing — it is a thin insert wrapper by
design, which is exactly why `fileIncidentReport` carries its own floor.

**De-duplication.** The severity/idempotency bypass is not in either prior audit.
The missing athlete-scope check is adjacent to, but distinct from, the guardian-link
`parent_id` finding NETWORK_STATUS.md escalated — different route, different
table, different actor. Pass 2 (authorization) owns the access half; it is
recorded here because it is an incident-filing path.

**Consequence for a child.** A safeguarding record about a named minor can be
created by a coach with no standing over that child, at a severity the ladder's
own design says an incident can never carry, with no idempotency. Both halves
push in the same direction: the incident queue about real children becomes less
trustworthy than the code claims it is.

---

### F-05 [LOW — already known] — /admin/escalations renders a blank Source cell for three source types

`apps/web/app/admin/escalations/page.tsx:11`:

> ```
> type EscalationSourceType = 'near_miss' | 'pain_report' | 'safety_gate_evaluation' | 'repeated_pattern' | 'athlete_voice' | 'training_hold';
> ```

versus `escalationLadder.ts:29`, which carries nine members including `'incident'`,
`'video_scan'` and `'compliance_violation'`. `SOURCE_LABEL` is
`Record<EscalationSourceType, string>` (`page.tsx:31`) and is indexed unguarded at
`page.tsx:295`.

**Already reported verbatim in `docs/capabilities/NETWORK_STATUS.md`** ("Found
after the map", second item). Confirmed still present at `04dd116b`. Cited and
moved on. Recorded here only because this pass's own union-drift sweep found it
independently, which is evidence the sweep works.

---

### F-06 [MEDIUM] — All three hold scopes overstate their enforcement, not only `conditioning_only`

NETWORK_STATUS.md records that `conditioning_only` enforces nothing while
`/parent/safety` says "Conditioning is paused right now". **Verified and
confirmed**, and the fuller truth is that no scope's copy matches its
enforcement.

`apps/web/app/parent/safety/page.tsx:35-39`:

> ```
> const SCOPE_HEADLINE: Record<TrainingHoldScope, string> = {
>   all_training: 'Training is paused right now',
>   contact_only: 'Contact work is paused right now',
>   conditioning_only: 'Conditioning is paused right now',
> };
> ```

`components/TrainingHoldBanner.tsx:31-35` says the same to the child.

What each actually does:

- `conditioning_only` — nothing. Grep for the literal across `apps/`, `packages/`,
  `infra/` and `scripts/` returns eleven hits: the type declarations, the SQL
  CHECK constraints, three UI label maps, one route error string, and one test
  asserting it does *not* flag contact (`trainingHolds.test.ts:450`). No
  enforcement path, no flag path.
- `contact_only` — flags, never pauses. `flagContactDuringHold` raises a near
  miss (`trainingHolds.ts:483`); nothing refuses contact, and
  `findRegistrationBlockingHold` filters `scope = 'all_training'`
  (`trainingHolds.ts:380`) so a contact-only hold does not touch registration.
- `all_training` — pauses *new registrations only*, per F-02.

`trainingHolds.ts:362-368` states the design honestly for the scoped rungs
("classes are untyped in the scheduler, so a scoped hold cannot know whether a
class involves contact; the scoped rungs enforce at the contact surface … and
inform on the athlete banner instead"). The defect is the gap between that
comment and the guardian-facing copy, which promises a pause.

**Refutation attempted.** I searched for a second consumer of the scope value
that might enforce something — workout templates, session scripts, drill
assignment, multidiscipline. `listTrainingHolds` has one non-test consumer
(`safetyReview.ts:6`), `getActiveTrainingHold` has two (the training-holds route
and the parent-safety route), and both are read-only displays.

**De-duplication.** The `conditioning_only` half is known and cited. The
`contact_only` and `all_training` halves — that all three headlines overstate, not
one — are new here.

**Consequence for a child.** A guardian reads "Conditioning is paused right now"
and stops asking. Nothing in the platform pauses conditioning, and no coach
surface tells a coach to. The hold's protective effect for two of three scopes
depends entirely on a human having read the banner.

---

### F-07 [LOW] — The `training_hold` gate can be recorded as blocked but never as passed

`recordSafetyGateEvaluation` has exactly three call sites.
`contactClearanceGate.ts` calls it twice — once with `outcome: 'passed'`
(`:152-162`) and once with `outcome: 'flagged'` (`:211-226`). The scheduler calls
it once, and only on refusal:

`apps/web/app/api/pilot/scheduler/route.ts:447-452`:

> ```
>           await recordSafetyGateEvaluation({
>             organizationId: actor.organizationId,
>             gateKey: 'training_hold',
>             athleteId,
>             outcome: 'blocked',
>             reason: 'Class registration refused: active all-training hold',
> ```

The successful branch (`result.outcome === 'registered' | 'waitlisted'`, returned
at `route.ts:470`) records nothing. Both readers of this table take the latest
evaluation per (athlete, gate) and treat non-`passed` as current:
`safetyReview.ts:94` (`and latest.outcome <> 'passed'`) and
`safetyGateMatrix.ts:191-199` (`left join lateral … limit 1`).

So once an athlete has been refused a registration even once, the
`training_hold` gate is permanently "not clear" for that athlete — on
`/admin/safety-review`'s "Failing Safety Gates" list, and on the guardian's
`/parent/safety` page, where `GATE_OUTCOME_LABEL` maps `blocked` to `'Not clear'`
(`app/parent/safety/page.tsx:43`). Lifting the hold does not change it. Nothing
can.

**Refutation attempted.** Grep for `recordSafetyGateEvaluation` across
`apps/` excluding tests returns the three sites named above and nothing else. I
also checked whether `liftTrainingHold` or the training-holds route records a
passing evaluation — neither imports `safetyGateMatrix` at all.

**Consequence for a child.** A guardian whose child was held in March and cleared
in April still reads "Active Training Hold — Not clear" in August, with no way to
tell it from a live restriction. The screen built to give guardians visibility
gives them a permanently stale one.

---

### F-08 [MEDIUM] — The readiness clamp and the delta-RPE lock have zero callers; the stored score is unvalidated

`apps/web/src/server/pilot/readinessMath.ts` exports three functions. Grep across
`apps/` and `packages/`, excluding `readinessMath.test.ts`, returns **no
importer**. The file's entire content is unreachable from the running
application, including:

`readinessMath.ts:25-31`:

> ```
> export function isDeltaRPELocked(deltaRpe: number, rationale: string | null): boolean {
>   if (deltaRpe < 2) {
>     return false;
>   }
>
>   return !rationale || rationale.trim().length === 0;
> }
> ```

and `readinessMath.ts:17`, `const clamped = clamp(rawScore, 1, 10);`.

Meanwhile the number that *is* stored in `pilot.readiness` — the number
`readinessBoard.ts` bands into GREEN/YELLOW/RED for the coach floor — arrives off
the HTTP body with no validation:

`apps/web/app/api/pilot/intake/domain-upsert/route.ts:117-124`:

> ```
>     } else if (entityType === 'readiness') {
>       entityId = await createReadiness({
>         organizationId: principal.organizationId,
>         athleteId,
>         score: Number(body.payload.score || 0),
>         category: asString(body.payload.category, 'general'),
>         measuredAt: asString(body.payload.measured_at, new Date().toISOString()),
>       });
> ```

`createReadiness` (`intake.ts:560-576`) inserts it directly. No range check, no
formula, no clamp.

**Refutation attempted, three ways.**

1. *Is there another readiness writer that does clamp?* No.
   `insert into pilot.readiness` appears exactly once outside tests, at
   `intake.ts:571`.
2. *Does the failure direction hurt?* Mostly no, and this is why the severity is
   MEDIUM rather than higher. A missing score becomes `0`, which
   `readinessStatusForScore` bands as RED (`readinessBoard.ts:39`), and `NaN`
   also falls through both comparisons to RED. Both fail toward caution. The
   unsafe direction — an out-of-range high score reading GREEN on the coach
   floor — requires an authenticated coach or org admin to post it.
3. *Is this the known `/operations` fabrication finding?* Related, and it is the
   mechanism behind it. The 2026-08-17 full-spectrum audit flagged `/operations`
   rendering a "Signed & Active" certification stamp over claims including
   "readiness clamps, RPE lockouts". This pass establishes *why* that stamp is
   false: both mechanisms it names are uncalled code. Recording the mechanism, not
   re-reporting the stamp.
4. *Is a fix already in flight?* `origin/fix/readiness-score-fabrication` (also
   `origin/fix/ct-readiness-provenance`) is unmerged and touches
   `readinessBoard.ts`, `intake.ts` and `athleteCheckIns.ts`, adding a
   `readinessProvenance` module. Whether it clamps was not verified — I did not
   read that branch's diff in full, and will not guess.

**Consequence for a child.** The delta-RPE lock is a safety mechanism the
platform advertises to its own operators and does not run. Nothing forces a
rationale when observed RPE exceeds intended RPE by 2 or more, because nothing
computes that comparison.

---

### F-09 [LOW] — `TrainingHoldScope` is defined five times; three copies back exhaustive maps

Full list at [Safety constants](#safety-constants). The failure mode if a fourth
scope is ever added to `trainingHolds.ts:45` and the SQL CHECK
(`pilot_slice_postgres_training_holds_migration.sql:56`): the server compiles, the
database accepts it, and three screens index a `Record` that has no entry.

Two of the three degrade quietly with a wrong-but-plausible fallback —
`SCOPE_HEADLINE[hold.scope] ?? SCOPE_HEADLINE.all_training`
(`TrainingHoldBanner.tsx:67`) and the identical line at
`app/parent/safety/page.tsx:134` — which would tell a child and their guardian
"Training is paused" for a scope that pauses something narrower. The third has no
fallback at all:

`apps/web/app/coach/progression-intelligence/page.tsx:510`:

> ```
>                   {HOLD_SCOPE_LABEL[activeHold.scope]} is currently paused for this athlete ({activeHold.reason_category}).
> ```

**Refutation attempted.** This is hypothetical — no fourth scope exists today, and
I checked that the five definitions are currently textually identical. It is
recorded because it is exactly the shape NETWORK_STATUS.md asks future PRs to
watch for ("before adding a member to a union, grep every exhaustive consumer"),
and because `main` broke three times on this class in one day. LOW because
nothing is wrong right now.

---

### F-10 [MEDIUM] — `assertShadowAuthority` cannot deny anything at any of its three call sites

`decideShadowAuthority` (`shadowAuthority.ts:45-71`) has six denial branches. Five
of them read caller-supplied booleans: `restrictionConflict`, `withinApprovedOptions`,
`lowRisk`, `reversible`, `confidenceTier`. The sixth keys off the action string:

`shadowAuthority.ts:46-48`:

> ```
>   if (input.automationMode === 'automatic' && isForbiddenAutomaticClearanceAction(input.action)) {
>     return { allowed: false, reason: 'Automatic clearance and medical authority actions are prohibited.' };
>   }
> ```

where `isForbiddenAutomaticClearanceAction` (`:34-43`) matches on `'clear'`,
`'concussion'`, `'sparring'`, `'weight_cut'`, `'medical_decision'`.

All three call sites pass literals. `app/api/pilot/intake/domain-upsert/route.ts:47-59`
passes `lowRisk: true, reversible: true, withinApprovedOptions: true,
restrictionConflict: false` with `confidenceTier: 'SUFFICIENT_FOR_REVIEW'`, and an
action of `` `intake.domain_upsert.${entityType}` `` where `entityType` ranges over
`emergency_contact | medical | waiver | assessment | attendance | readiness |
coach_note | guardian_link` (`route.ts:34`). None of those eight strings contains
any of the five forbidden substrings — note that `medical` does not match
`medical_decision`. The other two sites (`intake/review-action/route.ts:81-93`,
`shadow/upload/route.ts:103-119`) are the same shape with actions
`intake.review_action.*` and `intake.shadow_upload`.

Grep for `restrictionConflict` outside the module returns three lines, all
`restrictionConflict: false`.

So every `assertShadowAuthority` call on `main` reaches `return { allowed: true }`,
and its only effect is a row in `pilot.shadow_authority_checks` recording
`allowed = true`. That includes writes of a child's medical intake and waiver
records, in `automation_mode: 'automatic'` if the client asks for it —
`automationMode` comes straight off the body at `domain-upsert/route.ts:41`.

**Refutation attempted.** I looked for a caller that computes any of these flags
rather than asserting them: there is none. I also checked whether this repeats a
pattern the codebase has already condemned — it does, explicitly.
`shadowRecommendations.ts:65-71` describes fixing exactly this shape elsewhere:
"That flag arrived verbatim off the HTTP body behind a `typeof` check, with
`undefined` permitted -- so omitting one field from the JSON skipped the
clearance check entirely … A safety gate the caller decides to arm is not a
gate." The lesson was applied to recommendations and not to the authority check.

**Consequence for a child.** Indirect but real: `pilot.shadow_authority_checks`
is the platform's record that a SHADOW authority decision was made, and it will
record `allowed = true, reason = 'Authority check passed.'` for every write of
every child's medical and waiver records, forever, having checked nothing. An
auditor reading that table would conclude a gate ran.

---

## Checked and found sound

- **`pilot.training_holds` has exactly one writing module.** Three statements,
  all in `trainingHolds.ts` (117, 180, 252). No script, no migration runner, no
  admin route writes it directly. There is no second way to place, lift, or
  expire a hold.
- **The place-hold/file-escalation pairing is genuinely atomic.**
  `placeTrainingHold` runs both inside one `withTransaction`
  (`trainingHolds.ts:157`) and passes the client into `fileEscalation`
  (`trainingHolds.ts:227`). Same for `flagNearMiss`→escalation and
  `createComplianceViolation`→escalation. A hold cannot commit without its alarm.
- **The lift transition cannot be raced or misattributed.** `status = 'active'`
  and `(expires_at is null or expires_at > now())` are predicates on the UPDATE
  itself (`trainingHolds.ts:255-256`), so a lapsed hold cannot be dressed up as a
  deliberate lift, and the module's own claim to that effect holds.
- **The duplicate-hold race is closed at both layers** — sweep-then-check
  (`trainingHolds.ts:164-174`) plus a `23505` catch mapping the partial unique
  index violation to the same caller-facing conflict (`:205-207`).
- **The 42P01 pre-migration guards are correct and non-poisoning.** The
  in-transaction probe uses `SAVEPOINT training_hold_probe`
  (`trainingHolds.ts:395-405`) so a missing table degrades to "no hold" without
  aborting the enclosing registration transaction. This is unusually careful and
  worth not breaking.
- **`sparringExposure.ts` records contact with no gate — and is unreachable.**
  Grep for `recordSparringExposure`, `recordSessionLoad` and `sparringExposure`
  across `apps/` returns the module, its tests, and two comments in other modules
  telling callers *not* to route through it. No API route, no UI. It is an
  orphan like the clearance register, not a live bypass. If it is ever wired, it
  is a second contact-recording path that must call `flagContactDuringHold` and
  `flagContactWithoutClearance` — neither of which it does today.
- **Only one path writes contact observations.** `saveFormulaObservation` has one
  caller, and both contact gates run before the store, in the order the code
  documents (`observations/route.ts:122-150`).
- **Board isolation on the escalation register holds.** Board reaches only
  `getBoardEscalationSummary`, which returns counts gated at
  `BOARD_MINIMUM_COHORT_SIZE = 5` and never a row. `SafetyEscalationTargetRole`
  excludes `'board'` and `'parent'` at the type level (`escalationLadder.ts:51`)
  and `compliance.ts:29-32` maps only `coach`/`admin`, skipping rules configured
  for board or parent rather than silently widening. The reasoning is written
  down in both places and the code matches it.
- **`athlete_voice` suppression for coaches is enforced on both read and write.**
  `excludeAthleteVoice` is set for coaches in `GET` (`escalations/route.ts:75`)
  *and* re-applied in the acknowledge path (`:120`) so a coach cannot probe by
  guessed id.
- **The escalation status ladder cannot regress.** `LEGAL_PRIOR_STATES`
  (`escalationLadder.ts:384`) is applied as a predicate on the UPDATE, and the
  re-read distinguishes "no such row" from "illegal transition".
- **The incident dedup is a single atomic `INSERT … SELECT … WHERE NOT EXISTS`**
  (`escalationLadder.ts:256-265`) with the residual race honestly documented
  rather than overclaimed.
- **A covering coach can lift a medical hold — by recorded owner decision.**
  `training-holds/route.ts:33-40` states it: "a coach may place and lift holds
  for their own athletes (including athletes they hold an active coverage grant
  for -- assertCoachAssignedToAthlete admits both)". Combined with the absent
  clearance check on Coach Coverage this widens who can lift a medical hold, but
  it is a recorded decision and reversing it is on the "needs a human, not a
  commit" list. Reported as context under gate 7, not as a defect.
- **`packages/execution/safetyGate.ts` was not found in any live import path**,
  consistent with the 2026-08-17 audit's finding that it is dead legacy code.
- **No hardcoded contact limit exists anywhere**, and its absence is deliberate
  and documented (`sparringExposure.ts:10-13`). I went looking for a number and
  found a written refusal to have one, which is the better answer.

---

## Could not establish

- **Whether any of this is true at runtime.** Nothing was executed; no test was
  run; no database was touched. Every finding is a source read. `AGENT_KERNEL.md`
  invariant 5 applies to this document as much as to a PR.
- **Whether the deployed environment matches `04dd116b`.** Migrations in this
  repo are operator-dispatched (`.github/workflows/apply-migrations.yml`), and
  several modules carry explicit 42P01 guards for the pre-migration window. I
  cannot say whether `pilot.training_holds`, `pilot.safety_gates` or
  `pilot.clearance_types` exist in production. Per the kernel's source hierarchy,
  deployed-state claims need gatekeeper-observed evidence I do not have.
- **Whether `origin/fix/competition-safety-gates` is open, merged, closed or
  abandoned as a pull request.** I established only that its three commits are
  not in `origin/main` at `04dd116b`. NETWORK_STATUS.md is emphatic that PR state
  belongs in GitHub and must be queried live. Somebody should run `gh pr list`
  before acting on F-01.
- **Whether `origin/fix/readiness-score-fabrication` clamps the stored readiness
  score.** I saw its file list, not its diff. F-08's fourth refutation point is
  deliberately left open rather than guessed.
- **Whether a `not_cleared` or `restricted` medical administrative status has
  ever been set in this organization.** `/coach/sports-medicine` issues `GET`
  only (grep for `method:` returns three, all `'GET'`), so the only writer is a
  direct API call. If the status has never been set, `contactClearanceGate`'s
  `critical` branch has never fired in production and every contact flag has been
  the `high` "no record on file" variety. That is a data question, not a code
  question, and I cannot answer it from source.
- **What `pilot.readiness.score`'s column type is**, and therefore whether a
  `NaN` from `Number(body.payload.score || 0)` is stored or rejected. I reasoned
  about both cases in F-08 and both fail toward RED, but I did not read the
  column definition and am not asserting which happens.
- **Whether any test would fail if these gates were deleted.** That is Pass 10's
  question and it is the one that decides how much of this stays fixed. I noted
  that `trainingHolds.test.ts:450` pins the `conditioning_only` non-enforcement
  as intended behaviour, which means a future fix must change a test — worth
  knowing before someone treats F-06 as a one-line change.
