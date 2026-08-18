# Verification — Pass 4

Adversarial re-check of `docs/audit-2026-08-18/PASS-04-safety-gates.md`, run
against the working tree on `docs/full-spectrum-audit-2026-08-18` with
`origin/main` at `04dd116b`. No application code was read-modified; this file is
this pass's only write. Every quote below is my own, taken directly from the file
at the line given, independent of the quote in the finding.

Method: for each finding I re-derived the line numbers with `grep -n` on the
cited file, compared the finding's quoted text byte-for-byte against the source,
then tried to kill the reasoning — callers, DB constraints, triggers, migrations,
scheduled workflows, sibling UI surfaces, and tests.

Nothing was executed. Per `AGENT_KERNEL.md` invariant 5 that limit applies to
this document too: this is a source verification, not runtime proof.

---

## Summary

| Finding | Original severity | Verdict | Corrected severity |
|---|---|---|---|
| F-01 | CRITICAL | CONFIRMED | — |
| F-02 | HIGH | OVERSTATED | MEDIUM |
| F-03 | MEDIUM | OVERSTATED | LOW |
| F-04 | MEDIUM | CONFIRMED | — |
| F-05 | LOW | CONFIRMED | — |
| F-06 | MEDIUM | CONFIRMED WITH CORRECTION | MEDIUM (unchanged) |
| F-07 | LOW | CONFIRMED | — |
| F-08 | MEDIUM | CONFIRMED | — |
| F-09 | LOW | CONFIRMED | — |
| F-10 | MEDIUM | OVERSTATED | MEDIUM (unchanged; scope narrowed) |

Retracted: 0. Downgraded in severity: 2 (F-02, F-03). Narrowed without severity
change: 1 (F-10). Corrected on a specific sub-claim: 1 (F-06). Four findings
carry a factual error somewhere in their supporting text (F-02, F-03, F-06,
F-10); in three of those the headline still stands.

---

## Per-finding

### F-01 — CONFIRMED

**What I read.** `apps/web/src/server/pilot/externalCompetition.ts` (whole
entry/result half), `apps/web/src/server/pilot/wrestlingLeague.ts:195-235`, both
route files in full, `apps/web/app/operations/external-competition/page.tsx`
(athlete-load and picker), both migrations
(`infra/azure/pilot_slice_postgres_external_competition_migration.sql`,
`..._wrestling_league_migration.sql`), every trigger in `infra/`, and every
non-test reader of `pilot.external_competition_entries`.

**My quote.** `apps/web/src/server/pilot/externalCompetition.ts:160-165`:

> ```
>   const athlete = await queryOne<{ athlete_id: string }>(
>     `select athlete_id from pilot.athletes
>      where organization_id = $1 and athlete_id = $2`,
>     [input.organizationId, input.athleteId],
>   );
>   if (!athlete) return null;
> ```

Byte-identical to the finding's quote, at exactly the cited lines. The INSERT is
at `externalCompetition.ts:169` as claimed. The sibling is real —
`apps/web/src/server/pilot/wrestlingLeague.ts:214-219` is the same six lines with
`seasonId` substituted, inserting at `:223`. The route quote at
`apps/web/app/api/pilot/operations/external-competition/entries/route.ts:49-57`
is exact.

**Strongest refutation I could construct.** Four attacks, all failed:

1. *A route-level guard or framework middleware.* There is no
   `apps/web/middleware.ts` — `find apps/web -maxdepth 3 -name "middleware.ts"`
   returns nothing. The only pre-handler code is `requirePrincipal` +
   `requireRole`.
2. *A database trigger.* `grep -rn "create trigger" infra/` returns exactly three
   triggers repo-wide — `pilot_cascade_parent_deletion_trigger`,
   `pilot_feedback_submissions_freeze_disclosure`, and
   `pilot_drills_default_lineage_id`. None touches competition or roster tables.
3. *A CHECK constraint doing the work.* The entries table's constraints are the
   two composite FKs and
   `infra/azure/pilot_slice_postgres_external_competition_migration.sql:58-59`:
   > ```
   >   constraint pilot_external_competition_entries_unique
   >     unique (organization_id, competition_id, athlete_id)
   > ```
   Nothing else. Wrestling's roster table is the same shape (`:76-77`).
4. *A downstream consumer that would catch it.* The only non-test reader outside
   the module is `progressionSuggestions.ts:295`, and it filters
   `e.result = 'lost'` — a post-hoc loss review, which cannot warn before entry.

**Precision check on the URGENT line.** "One authenticated request" is true with
one unstated prerequisite: the competition or season row must already exist, and
the caller must hold `organization_admin` or `admin`
(`externalCompetition.ts:20`, `wrestlingLeague.ts:20`). The finding states the
role restriction explicitly in its own refutation 2, so this is a reading
qualification, not a defect.

**Branch claims verified.** `git rev-list --count origin/main..origin/fix/competition-safety-gates`
returns `3`; the reverse direction returns `0`; `git rev-parse --short origin/main`
is `04dd116b`; `git branch -r | wc -l` is 143. All four numeric claims hold.

**Why refutation failed.** There is no layer between the HTTP body and the INSERT
that reads any safety record. CRITICAL stands.

---

### F-02 — OVERSTATED (correct severity: MEDIUM)

**What I read.** `apps/web/app/api/pilot/scheduler/route.ts` in full for `hold`,
`apps/web/src/server/pilot/trainingHolds.ts:156-232`, every write statement
against `pilot.scheduler_registrations`, both scheduled GitHub workflows,
`scripts/`, `apps/web/app/schedule/page.tsx`, `apps/web/components/CoachWorkspace.tsx`,
and `apps/web/app/api/pilot/escalations/route.ts`.

**My quote.** `apps/web/app/api/pilot/scheduler/route.ts:665-668`:

> ```
>       const registeredIds = await listRegisteredAthleteIdsForClass(actor.organizationId, classId);
>       if (!registeredIds.includes(athleteId)) {
>         throw new Error('Missing registration: athlete is not registered for this class');
>       }
> ```

Exact, at the cited lines. `grep -ni "hold"` across the whole route returns
matches only at `:52` (a comment) and `:418-462` (the registration block) —
nothing in either attendance branch.

**The sweep hunt (the thing I was told to search hardest for).** There is no
sweep, cron, job, or trigger that cancels registrations on hold creation.
Evidence: `placeTrainingHold` runs one `withTransaction` containing exactly two
statements — the INSERT at `trainingHolds.ts:180` and `fileEscalation` at
`trainingHolds.ts:211` — and returns at `:230`; it never names
`scheduler_registrations`. Repo-wide,
`grep -rn "delete from pilot.scheduler_registrations"` returns **nothing**, and
the table's only UPDATE is `apps/web/src/server/pilot/schedulerDb.ts:292-297`:

> ```
>     `update pilot.scheduler_registrations
>      set parent_reviewed = true,
>          parent_reviewed_at = $3,
>          parent_reviewer_account_id = $4,
>          updated_at = $3
> ```

Only two workflows carry a `schedule:` block — `backup.yml` and
`retention-cleanup.yml` — and neither mentions registrations or holds. The
finding's mechanism is sound.

**Where it breaks.** Refutation attempt 2 asserts "`CoachWorkspace.tsx` likewise
carries no hold surface." That is false. `apps/web/components/CoachWorkspace.tsx:895`:

> ```
>       const response = await fetch(`${apiBase()}/api/pilot/escalations?status=open`, {
> ```

and `apps/web/components/CoachWorkspace.tsx:186`:

> ```
>   training_hold: 'Training hold',
> ```

rendered at `:1367-1373` as the athlete's name over
`ESCALATION_SOURCE_LABEL[escalation.source_type]`, with the escalation's own
reason text at `:1378`. `placeTrainingHold` files that escalation in the same
transaction as the hold, and
`apps/web/app/api/pilot/escalations/route.ts:69` scopes a coach to their own
athletes (`coachAthleteIds`) regardless of `escalated_to_role`. So the coach
responsible for the child *does* get an open inbox card naming them the moment
the hold lands.

The pass also missed a second coach-facing hold surface entirely —
`apps/web/app/coach/progression-intelligence/page.tsx:275` fetches
`/api/pilot/training-holds?...&status=active` and renders it at `:510`.

**Two smaller inaccuracies.** (a) `grep -ni "hold" apps/web/app/schedule/page.tsx`
returns six lines, but they are *not* "all the word `placeholder`" — line 609
reads `Coach to assign (their coach of record, or a coach holding active coverage)`.
Five are `placeholder`; one is `holding`. Neither is a training-hold surface, so
the conclusion survives the miscount. (b) The finding calls `app/schedule/page.tsx`
"the only screen issuing `attendance_checkin` / `bulk_attendance_checkin`";
`bulk_attendance_checkin` has **no** UI caller — grep returns only
`scheduler/route.ts:47`, `:688` and the route's own test.

**Why the downgrade.** The core defect is real and unmitigated at the point of
action: nothing re-checks the hold at check-in, nothing is flagged, no escalation
is filed, and the door screen shows nothing. But HIGH was argued partly on "no
surface a coach reads at the door shows the hold" generalising to "no surface at
all", and two coach-facing surfaces exist — one of which (the open-escalation
inbox) fires automatically on every hold placement. Combined with the finding's
own correct reasoning that attendance is a presence record rather than an
authorisation to train, MEDIUM is the defensible level. It is not lower than
MEDIUM because the escalation card can be acknowledged away while the hold stays
active, and neither surface is on the check-in path.

---

### F-03 — OVERSTATED (correct severity: LOW)

**What I read.** `apps/web/src/server/pilot/safetyReview.ts:100-135`, the whole
render tree of `apps/web/app/admin/safety-review/page.tsx`, `trainingHolds.ts:211-228`.

**My quote.** `apps/web/app/admin/safety-review/page.tsx:96-98`:

> ```
>   const isLoading = review === null && !errorMessage;
>   const totalOpen = review
>     ? review.openHolds.length + review.failingGates.length + review.openEscalations.length + review.openViolations.length
> ```

The summation is exactly as claimed (the finding's quote starts one line later,
at `:96` proper; both resolve to the same statement). The un-deduplicated read is
real — `apps/web/src/server/pilot/safetyReview.ts:106`:

> ```
>     listEscalations(organizationId, {}),
> ```

and the only post-filter is `.filter((escalation) => escalation.status !== 'resolved')`
at `:129`. Refutation 2 is also correct: `EscalationItem` at
`apps/web/app/admin/safety-review/page.tsx:28-36` declares no `metadata` field
(the finding cites `:27-35`, off by one).

**Strongest refutation, and it largely succeeded.** Two things undercut the
framing:

1. *A hold and its escalation are deliberately two open work items, not one.*
   `apps/web/src/server/pilot/trainingHolds.ts:220`:
   > ```
   >           + 'The hold record carries the explanation and the lift condition; resolving this escalation does not lift the hold.',
   > ```
   The escalation has its own acknowledge/resolve lifecycle that is explicitly
   independent of the hold's lift. A screen titled "everything open" counting
   both is arguably counting correctly.
2. *There is no single list in which an admin "sees two rows for one event."* The
   page renders four separately headed, separately counted sections —
   `apps/web/app/admin/safety-review/page.tsx:141`:
   > ```
   >                   <h2 className="t-command text-[length:var(--t-lg)]">Active Training Holds ({review!.openHolds.length})</h2>
   > ```
   with the same shape at `:155`, `:169` and `:186`. The finding's stated
   consequence — "sees two rows for one event and a headline count roughly double
   the real one, twice over" — does not describe what the page shows. Only
   `totalOpen` conflates, and "roughly double" overstates: escalations sourced
   from near misses, video scans, athlete voice, incidents and repeated patterns
   have no counterpart row in the other three lists.

**Why it is not retracted.** The mechanism is genuine — one real-world event does
increment `totalOpen` twice, and there is no way for the page to join them
because the linking metadata is not in its interface. That is a real
cosmetic-integrity defect in a headline number. It is LOW, not MEDIUM.

---

### F-04 — CONFIRMED

**What I read.** `escalationLadder.ts:150-280` (`fileEscalation` and
`fileIncidentReport` in full), `behaviorStandards.ts:145-178`, the whole of
`apps/web/app/api/pilot/coach/behavior-standards/route.ts`,
`infra/azure/pilot_slice_postgres_safety_escalations_migration.sql`.

**My quotes.** `apps/web/src/server/pilot/escalationLadder.ts:241-243`:

> ```
>   if (input.severity !== 'high' && input.severity !== 'critical') {
>     throw new Error(`fileIncidentReport: severity must be 'high' or 'critical', got '${String(input.severity)}'`);
>   }
> ```

`apps/web/src/server/pilot/behaviorStandards.ts:165-167`:

> ```
>   const escalation = await fileEscalation({
>     organizationId: input.organizationId,
>     sourceType: 'incident',
> ```

`apps/web/app/api/pilot/coach/behavior-standards/route.ts:37`:

> ```
> const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
> ```

All three exact, all at the cited lines.

**Refutation attempts, all failed.**

1. *A database CHECK scoped to `source_type='incident'`.* No.
   `infra/azure/pilot_slice_postgres_safety_escalations_migration.sql:124`:
   > ```
   >   severity                     text not null check (severity in ('low', 'moderate', 'high', 'critical')),
   > ```
   All four values are legal for every source type. The module comment at
   `escalationLadder.ts:237` says exactly this and it checks out.
2. *A floor inside `fileEscalation`.* `escalationLadder.ts:158-166` is six lines
   that pick a client and delegate to `insertEscalation`. No validation.
3. *An athlete-scope check under a different name.* `grep -n` for
   `assertActorCanAccessAthlete|assertCoachAssignedToAthlete|assertCanActOnAthlete`
   across the whole behavior-standards route returns nothing; the only guards are
   five `requireRole` calls at `:48`, `:64`, `:94`, `:107`, `:130`. The
   `raise_concern` branch's is `route.ts:130`:
   > ```
   >       requireRole(principal, [...FLOOR_ROLES]);
   > ```
   with `FLOOR_ROLES = ['coach', 'organization_admin', 'admin']` at `:34`.

**Severity.** MEDIUM sits at the top of its defensible range. On its own the
mechanical half is queue hygiene: an `incident` at `low` still lands in
`pilot.safety_escalations` and still surfaces to coach and admin readers, and the
dedup bypass only produces duplicates. What holds it at MEDIUM rather than LOW is
the missing athlete scope, which the finding correctly hands to Pass 2 while
still recording it here.

---

### F-05 — CONFIRMED

**What I read.** `apps/web/app/admin/escalations/page.tsx:8-40` and `:290-300`,
`escalationLadder.ts:28-30`.

**My quote.** `apps/web/app/admin/escalations/page.tsx:11`:

> ```
> type EscalationSourceType = 'near_miss' | 'pain_report' | 'safety_gate_evaluation' | 'repeated_pattern' | 'athlete_voice' | 'training_hold';
> ```

Exact, and six members. Against `apps/web/src/server/pilot/escalationLadder.ts:29`,
which carries nine and includes `'incident' | 'video_scan' | 'compliance_violation'`.
`SOURCE_LABEL` is declared `Record<EscalationSourceType, string>` at
`page.tsx:31` and indexed unguarded at `page.tsx:295`:

> ```
>                         <td className="t-body px-[var(--s4)] py-[var(--s3)]">{SOURCE_LABEL[item.source_type]}</td>
> ```

**Refutation attempted.** I checked whether the page filters `source_type` before
rendering (it filters only by `status`), and whether a fallback exists (it does
not — unlike `TrainingHoldBanner.tsx:67` and `CoachWorkspace.tsx:1370`, both of
which use `??`). Nothing rescues it: three of the eight live source types render
an empty cell. LOW and already-known is the right disposition.

---

### F-06 — CONFIRMED WITH CORRECTION

**What I read.** `trainingHolds.ts:361-420` and `:427-505`,
`apps/web/app/parent/safety/page.tsx:1-50` and `:130-140`,
`components/TrainingHoldBanner.tsx:23-35` and `:60-75`,
`app/coach/progression-intelligence/page.tsx:89-98` and `:270-290` and `:503-516`,
every occurrence of `conditioning_only` in `apps/`, `packages/`, `infra/`, `scripts/`.

**My quote.** `apps/web/app/parent/safety/page.tsx:35-39`:

> ```
> const SCOPE_HEADLINE: Record<TrainingHoldScope, string> = {
>   all_training: 'Training is paused right now',
>   contact_only: 'Contact work is paused right now',
>   conditioning_only: 'Conditioning is paused right now',
> };
> ```

Exact.

**Each scope checked separately, as instructed.**

- `all_training` — enforces one thing. `apps/web/src/server/pilot/trainingHolds.ts:380`:
  > ```
  >       and status = 'active' and scope = 'all_training'
  > ```
  inside `findRegistrationBlockingHold`. New class registrations only.
- `contact_only` — flags, never blocks. `trainingHolds.ts:459`:
  > ```
  >         and scope in ('all_training', 'contact_only')
  > ```
  inside `flagContactDuringHold`, which raises a `high` near miss at `:483-490`
  and returns; there is no refusal anywhere in the function.
- `conditioning_only` — appears in neither predicate. It is excluded from
  `findRegistrationBlockingHold` (scope `=` `'all_training'`) and from
  `flagContactDuringHold` (scope `in` the other two). No enforcement, no flag.
  `apps/web/src/server/pilot/trainingHolds.test.ts:450` pins this as intended:
  > ```
  >   test('conditioning_only holds do not cover contact and do not flag it', async () => {
  > ```

So the earlier record (only `conditioning_only` unenforced) is the narrower
truth; the pass is right that all three headlines promise more than the software
delivers, in decreasing order of severity. **This half is confirmed.**

**The corrections.**

1. *The consequence paragraph is wrong.* It says "no coach surface tells a coach
   to." Two do. `apps/web/app/coach/progression-intelligence/page.tsx:510`:
   > ```
   >                   {HOLD_SCOPE_LABEL[activeHold.scope]} is currently paused for this athlete ({activeHold.reason_category}).
   > ```
   with `HOLD_SCOPE_LABEL.conditioning_only = 'CONDITIONING'` at `:97`, fed by a
   live fetch of `/api/pilot/training-holds?...&status=active` at `:275`, and
   followed at `:514-515` by "Confirm the hold's scope before assigning or
   verifying anything that conflicts with it." Second: every hold placement files
   an escalation (`trainingHolds.ts:211-228`) that a coach sees in their own open
   inbox, per the F-02 evidence above. The pass's own refutation paragraph
   enumerates the consumers of `getActiveTrainingHold` and `listTrainingHolds`
   but never grepped the `/api/pilot/training-holds` **route** for UI callers,
   which is how it missed this page.
2. *The grep count is wrong.* The finding says the `conditioning_only` literal
   returns "eleven hits." It returns 22 across `apps/ packages/ infra/ scripts/`,
   or 15 once `.next/` build artifacts and test files are excluded — including
   `apps/web/scripts/pilot-apply-training-holds-migration.mjs:61`, which the
   finding's enumeration omits. None of the extra hits is an enforcement path, so
   the conclusion is unaffected.

**Severity.** MEDIUM stands. The corrections describe coach-facing visibility; the
finding is about guardian-facing copy, which no coach page fixes. A guardian
reading "Conditioning is paused right now" is reading a true report of a coaching
decision but a false implication of platform enforcement, and `conditioning_only`
has neither a block nor a flag anywhere.

---

### F-07 — CONFIRMED

**What I read.** Every non-test caller of `recordSafetyGateEvaluation`,
`apps/web/app/api/pilot/scheduler/route.ts:415-475`, `safetyGateMatrix.ts:175-205`,
`safetyReview.ts:80-98`, `safetyGateSeeds.ts:41-66`,
`apps/web/app/parent/safety/page.tsx:41-46`.

**My quote.** `apps/web/app/api/pilot/scheduler/route.ts:447-452`:

> ```
>           await recordSafetyGateEvaluation({
>             organizationId: actor.organizationId,
>             gateKey: 'training_hold',
>             athleteId,
>             outcome: 'blocked',
>             reason: 'Class registration refused: active all-training hold',
> ```

Exact. The successful branch is `route.ts:470-475` and writes no evaluation.

**Refutation attempted, three ways, all failed.**

1. *A fourth call site.* `grep -rn "recordSafetyGateEvaluation"` across `apps/`,
   `packages/`, `scripts/` returns exactly three non-test callers:
   `contactClearanceGate.ts:152`, `contactClearanceGate.ts:211`, and
   `scheduler/route.ts:447`. Count confirmed independently.
2. *`contactClearanceGate` writing a `passed` that would clear it.* No — it
   writes under a different gate key. `apps/web/src/server/pilot/contactClearanceGate.ts:154`:
   > ```
   >         gateKey: GATE_KEY,
   > ```
   and `GATE_KEY` is `contact_medical_clearance` (`safetyGateSeeds.ts:43`). The
   readers key on `(athlete, gate_key)` — `safetyGateMatrix.ts:195`:
   > ```
   >         and e.gate_key = g.gate_key
   > ```
   with `order by e.evaluated_at desc limit 1`. A `passed` on one gate cannot
   clear another.
3. *A lift writing a passing evaluation.* `liftTrainingHold` and
   `apps/web/app/api/pilot/training-holds/route.ts` import nothing from
   `safetyGateMatrix`.

The guardian-facing consequence is verified end to end: the gate's seeded name is
`'Active Training Hold'` (`safetyGateSeeds.ts:59`) and
`apps/web/app/parent/safety/page.tsx:43` maps `blocked: 'Not clear'`. LOW is
right — it fails toward showing a restriction that no longer exists, not toward
hiding one.

---

### F-08 — CONFIRMED

**What I read.** `apps/web/src/server/pilot/readinessMath.ts` in full, every
importer of it, `apps/web/app/api/pilot/intake/domain-upsert/route.ts:112-130`,
`intake.ts:561-578`, `readinessBoard.ts:15-45`, and the `pilot.readiness` DDL.

**My quote.** `apps/web/src/server/pilot/readinessMath.ts:25-31`:

> ```
> export function isDeltaRPELocked(deltaRpe: number, rationale: string | null): boolean {
>   if (deltaRpe < 2) {
>     return false;
>   }
>
>   return !rationale || rationale.trim().length === 0;
> }
> ```

Exact, and `readinessMath.ts:17` is `  const clamped = clamp(rawScore, 1, 10);` as
quoted. `grep -rn "readinessMath|isDeltaRPELocked|computeReadiness"` across
`apps/`, `packages/`, `scripts/` returns **only** the module and
`readinessMath.test.ts`. Zero importers confirmed independently.

**Refutation attempted, three ways, all failed.**

1. *A second, clamping readiness writer.* `grep -rn "insert into pilot.readiness"`
   returns `intake.ts:571` and one line inside `interventionEvidence.pg.test.ts`.
   `createReadiness` (`intake.ts:561-578` — the finding cites `:560-576`, off by
   one to two) has no range logic.
2. *A database CHECK doing the clamp instead.* No.
   `infra/azure/pilot_slice_postgres.sql:305`:
   > ```
   >   score numeric not null,
   > ```
   `not null` and nothing else. This also settles one of the pass's own
   "Could not establish" items: the column is `numeric`, which accepts `NaN`, so
   the NaN branch of the finding's reasoning is the live one — and it bands to
   RED at `readinessBoard.ts:39` (`return 'RED';`), which is the safe direction
   the finding claimed.
3. *A validating type at the route boundary.* `route.ts:121` is
   `        score: Number(body.payload.score || 0),` — a coercion, not a check.

MEDIUM stands: the unsafe direction (an out-of-range high score reading GREEN on
the coach floor) requires an authenticated coach or org admin, which is what
keeps it below HIGH, but the number driving a coach-facing triage colour has no
validation anywhere in its path.

---

### F-09 — CONFIRMED

**What I read.** Every occurrence of the scope union across `apps/`,
`components/TrainingHoldBanner.tsx:60-75`, `app/parent/safety/page.tsx:130-140`,
`app/coach/progression-intelligence/page.tsx:89-98` and `:503-516`.

**My count, taken independently.** Five definitions, all textually identical:
`apps/web/src/server/pilot/trainingHolds.ts:45` (canonical, `export type`),
`apps/web/components/TrainingHoldBanner.tsx:24`,
`apps/web/app/parent/safety/page.tsx:8`,
`apps/web/app/admin/safety-review/page.tsx:14`,
`apps/web/app/coach/progression-intelligence/page.tsx:89`. Matches the finding
exactly.

**My quote.** `apps/web/app/coach/progression-intelligence/page.tsx:510`:

> ```
>                   {HOLD_SCOPE_LABEL[activeHold.scope]} is currently paused for this athlete ({activeHold.reason_category}).
> ```

Exact, at the cited line, and there is genuinely no `??` fallback — unlike
`TrainingHoldBanner.tsx:67` and `apps/web/app/parent/safety/page.tsx:134`, both of
which read `SCOPE_HEADLINE[...] ?? SCOPE_HEADLINE.all_training` as claimed. Three
of the four non-canonical copies back an exhaustive `Record`; the fourth
(`admin/safety-review/page.tsx:14`) declares the union without a map. All
verified.

**Refutation attempted.** The finding calls itself hypothetical, so the only
available attack is that it is not worth recording. I do not think that survives:
the failure mode is silent at compile time and at the database, and the third
consumer renders `undefined` into a sentence a coach reads. LOW is correct.

---

### F-10 — OVERSTATED (severity unchanged at MEDIUM; scope narrowed)

**What I read.** `apps/web/src/server/pilot/shadowAuthority.ts` in full (98
lines), all three non-test call sites in full, every occurrence of
`restrictionConflict`, and the `pilot.shadow_authority_checks` DDL.

**My enumeration, done independently and not trusting the count.**
`grep -rn "assertShadowAuthority"` across `apps/`, `packages/`, `scripts/` gives
three non-test call sites, and no more:
`apps/web/app/api/pilot/intake/domain-upsert/route.ts:47`,
`apps/web/app/api/pilot/intake/review-action/route.ts:81`,
`apps/web/app/api/pilot/shadow/upload/route.ts:103`. The count of three is right.

**My quote.** `apps/web/src/server/pilot/shadowAuthority.ts:46-48`:

> ```
>   if (input.automationMode === 'automatic' && isForbiddenAutomaticClearanceAction(input.action)) {
>     return { allowed: false, reason: 'Automatic clearance and medical authority actions are prohibited.' };
>   }
> ```

Exact. Six denial branches at `:46`, `:50`, `:54`, `:58`, `:62`, `:66` — count
confirmed. `restrictionConflict` appears outside the module on exactly three
lines, all `      restrictionConflict: false,` (`shadow/upload/route.ts:114`,
`domain-upsert/route.ts:56`, `review-action/route.ts:90`), so the
`restrictionConflict` branch is unreachable everywhere. That sub-claim holds.

**The refutation that succeeded.** The headline — "cannot deny anything at any of
its three call sites" — is false at one of the three. The finding states that
"the other two sites (`intake/review-action/route.ts:81-93`,
`shadow/upload/route.ts:103-119`) are the same shape". They are not.
`apps/web/app/api/pilot/intake/review-action/route.ts:86-88`:

> ```
>       confidenceTier: action === 'promote' ? 'SUFFICIENT_FOR_REVIEW' : 'SUFFICIENT_FOR_LOW_RISK_ACTION',
>       lowRisk: action !== 'promote',
>       reversible: action !== 'promote',
> ```

These are computed, not asserted. A request with `action: 'promote'` and
`automation_mode: 'automatic'` sets `lowRisk: false`, reaches
`shadowAuthority.ts:58-60`, and is denied with `'Automatic action must be low risk.'` —
`assertShadowAuthority` then throws at `:96`. `automationMode` on that route is
`body.automation_mode ?? 'assisted'` at `review-action/route.ts:76` with no
allow-list, so `'automatic'` is client-reachable. The denial branch is live.

**What survives.** The two sites that matter most for a child's records —
`domain-upsert` (medical, waiver, guardian_link, readiness) and `shadow/upload` —
do pass only literals, and I verified the forbidden-substring list can never
match their actions. `apps/web/app/api/pilot/intake/domain-upsert/route.ts:50-56`:

> ```
>       action: `intake.domain_upsert.${entityType}`,
>       automationMode,
>       confidenceTier: 'SUFFICIENT_FOR_REVIEW',
>       lowRisk: true,
>       reversible: true,
>       withinApprovedOptions: true,
>       restrictionConflict: false,
> ```

Against `isForbiddenAutomaticClearanceAction`'s five substrings (`shadowAuthority.ts:37-41`:
`clear`, `concussion`, `sparring`, `weight_cut`, `medical_decision`) and the eight
`entity_type` values at `route.ts:34`, I checked each pairing by hand: none of
`emergency_contact`, `medical`, `waiver`, `assessment`, `attendance`, `readiness`,
`coach_note`, `guardian_link` contains any of the five. The finding's note that
`medical` does not match `medical_decision` is correct. `shadow/upload`'s single
action `'intake.shadow_upload'` likewise matches nothing.

**Corrected scope.** The gate is inert at 2 of 3 call sites, not 3 — and at the
third it can deny exactly one combination (`action='promote'` with
`automationMode==='automatic'`). MEDIUM is unchanged, because the substance
(every medical/waiver intake write records `allowed = true` having checked
nothing) is untouched by the correction.

---

## What the pass missed

1. **`/coach/progression-intelligence` is a training-hold reader and was not in
   the inventory.** `apps/web/app/coach/progression-intelligence/page.tsx:275`
   fetches `/api/pilot/training-holds?athlete_id=...&status=active` and renders
   the scope at `:510`. The pass's F-06 refutation enumerated consumers of
   `listTrainingHolds` and `getActiveTrainingHold` but never grepped the route's
   UI callers, so this page is absent from the reader list, from F-02's "no coach
   surface" claim, and from F-06's consequence — while being present in F-09's
   union-drift list, which is internally inconsistent.

2. **`automation_mode` is unvalidated at two of the three SHADOW authority call
   sites, and the column has no CHECK.** `domain-upsert/route.ts:42` and
   `review-action/route.ts:76` both read `body.automation_mode ?? 'assisted'` with
   only a TypeScript cast; `shadow/upload/route.ts:64-67` is the one site that
   validates against an allow-list. `infra/azure/pilot_slice_postgres.sql:156` is
   `  automation_mode text not null,` with no CHECK. Two consequences the pass did
   not draw: an arbitrary client string is persisted into the SHADOW authority
   audit record as if it were a mode, and the one reachable denial branch I found
   in F-10 is evadable by casing — `automation_mode: "Automatic"` fails
   `=== 'automatic'`, skips every automatic-mode branch, and writes `"Automatic"`
   into the audit row. That makes the F-10 gate weaker in practice than the
   corrected scope suggests, in a way neither document records.

3. **`bulk_attendance_checkin` has no UI caller at all.** The pass states
   `app/schedule/page.tsx` is "the only screen issuing `attendance_checkin` /
   `bulk_attendance_checkin`". `grep -rn "bulk_attendance_checkin"` across
   `apps/web/app` and `apps/web/components` returns only `scheduler/route.ts:47`,
   `:688`, and the route's own test. It is a route action with no front end —
   worth knowing before anyone treats "fix it at the door" as a one-screen change.

4. **Four supporting counts and quotes in the pass are wrong** even where the
   headline survives: the `conditioning_only` grep count (11 vs. 15 source hits),
   the schedule-page `hold` grep characterisation ("all the word `placeholder`" —
   one is `holding`), `EscalationItem`'s line range (`:27-35` vs. `:28-36`), and
   `createReadiness`'s line range (`:560-576` vs. `:561-578`). None changes a
   verdict; together they suggest the line references were captured before a
   later edit pass and not re-resolved.

5. **One "Could not establish" item was settleable from source.** The pass says
   it did not read `pilot.readiness.score`'s column definition. It is
   `infra/azure/pilot_slice_postgres.sql:305`, `  score numeric not null,` — no
   range CHECK, and `numeric` accepts `NaN`. That resolves the finding's open
   branch in favour of the reading it already preferred.
