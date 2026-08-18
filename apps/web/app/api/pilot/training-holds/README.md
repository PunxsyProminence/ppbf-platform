# Training holds -- Stop / Hold / Regress -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

Written from what the code does on `origin/main` at `04dd116b`.

## What this capability is

The platform's sports-medicine lever: pausing or narrowing a specific child's
training, durably, with a sentence that child can read.

Three words, as decided with the owner (2026-08-06) and recorded in
`src/server/pilot/trainingHolds.ts`:

- **STOP** -- an active `all_training` hold blocks class registration at request
  time (`schedulerDb.ts:registerForClassTransactionally`).
- **HOLD** -- scope `all_training`: training paused until a person lifts it.
  Durable, attributed, expiring, linear (one active hold per athlete).
- **REGRESS** -- scope `contact_only` / `conditioning_only`: training
  **continues** at reduced scope. "What regresses is the permitted intensity,
  never the athlete's standing -- the platform has no athlete ranks, by recorded
  doctrine, and this module refuses to introduce one."

Route: `app/api/pilot/training-holds/route.ts` (`GET`, and `POST` with
`action: 'place' | 'lift'`). State: `pilot.training_holds`. Server module:
`src/server/pilot/trainingHolds.ts`.

**The adjacent medical gate, deliberately separate:** whether an athlete is
medically *cleared* lives in `pilot.shadow_medical_administrative_status`
(`shadowMedicalStatus.ts`) and is enforced by
`shadowRecommendations.ts:assertMedicalStatusAllowsRecommendation` and
`contactClearanceGate.ts:flagContactWithoutClearance`. Gates 8-10 below cover the
part of that boundary this capability touches. A hold is a *staff action*; a
clearance is a *medical record*, and neither writes the other.

## What it may do

- Let a coach place and lift holds for their own athletes -- including athletes
  they hold an active coverage grant for; let organization admins place and lift
  any.
- Refuse a class registration for a held athlete, in the registration's own
  transaction, with the athlete's own words.
- Show the athlete and their guardians their own current hold in an
  athlete-safe projection.
- Expire on its own clock, and sweep lapsed rows so the staff list never shows a
  child as protected when they are not.
- Raise a near miss when contact is logged for a held athlete -- without
  refusing the record.

## What it may NOT do

- It may not place a hold with no sentence written for the athlete (gate 3).
- It may not show `reason_text` -- staff-facing detail -- to the athlete or their
  guardian (gate 6).
- It may not stack two active holds on one child (gate 4).
- It may not stamp a deliberate lift onto a hold that merely expired (gate 5).
- It may not be placed or lifted by an athlete, a parent, a board member, the
  platform owner, or a coach with no standing with that child (gates 1-2).
- It may not refuse a contact observation, even for a held athlete (gate 10).
- It may not clear an athlete medically, and a resolved escalation does not lift
  it.

## What must be true before a child's training is paused

`POST` with `action: 'place'` writes a hold only when **all** of these hold, in
this order. The first failure refuses the whole write.

| # | Must be true | If it is not | Who can make it true |
|---|---|---|---|
| 1 | A live, non-bootstrap session | 401 `Unauthorized` / 403 `Forbidden: PIN change required...` | Sign in |
| 2 | Role is `coach`, `organization_admin` or `admin` | 403 `Forbidden: role not allowed` | Staff performs the action |
| 3 | A JSON body is present | 400 `Missing request body` | Fix the request |
| 4 | `athlete_id` is present | 400 `Missing athlete_id` | Fix the request |
| 5 | `scope` is one of the three | 400 `Unsupported scope: must be all_training, contact_only, or conditioning_only` | Pick a rung |
| 6 | `reason_category` is one of `medical`, `fatigue`, `behavioral`, `administrative`, `other` | 400 `Unsupported reason_category` | Pick a category |
| 7 | **`athlete_explanation` is non-empty** | 400 `Missing athlete_explanation: the sentence the athlete reads is required` | Write the sentence |
| 8 | Each text field is <= 2000 characters | 400 `Unsupported <field>: longer than 2000 characters` | Shorten it |
| 9 | `expires_at`, if given, parses and is >= 1 minute in the future | 400 `Unsupported expires_at: must be an ISO timestamp` / `Unsupported expires_at: must be at least a minute in the future` | Fix the timestamp |
| 10 | A `coach` actor has standing with this athlete; an admin's athlete is in their organization | 403 `Forbidden: coach not assigned to athlete` / `Forbidden: athlete does not belong to organization` | Be the coach of record, hold coverage, or have an admin do it |
| 11 | No active hold already exists for this athlete | 409 `Hold already exists: <hold_id> is active for this athlete -- lift it first` | Lift the named hold |
| 12 | No concurrent placement won the race | 409 `Hold already exists: an active hold was placed concurrently for this athlete -- lift it first` | Reload |

`lift_condition_text` and `reason_text` are **optional**. Only the athlete's
sentence is mandatory.

## Gates

### Gate 1 -- staff only, and the two non-staff readers get a different shape

- **What it checks:** on `POST`, `isStaff(role)` -- `coach` or
  `isOrganizationAdminRole`. On `GET`, a three-way branch: `athlete`, `parent`,
  or staff; anything else refused.
- **Where it runs:** `app/api/pilot/training-holds/route.ts:POST` /
  `:GET`, on a principal from `http.ts:requirePrincipal`.
- **What it refuses with:** 403 `Forbidden: role not allowed`.
- **Why `board` and `platform_owner` get nothing here:** the route's own header --
  "a hold names one child, and both roles are aggregate-only by doctrine."
- **Note:** this route uses local role logic rather than `http.ts:requireRole`,
  because the three `GET` audiences need three different projections. The refusal
  message therefore carries the `access.ts` wording (`Forbidden: role not
  allowed`) rather than `requireRole`'s bare `Forbidden`.

### Gate 2 -- a coach may only act on children they have standing with

- **What it checks:** for a `coach` actor,
  `access.ts:assertCoachAssignedToAthlete(accountId, athleteId, organizationId)`
  -- `coach_id` of record **or** an active `pilot.coach_coverage` grant. For an
  admin, `access.ts:assertAthleteBelongsToOrganization`.
- **Where it runs:**
  - `POST place`: after all payload validation, before `placeTrainingHold`.
  - `POST lift`: the hold is loaded first (to learn its athlete), then the coach
    check runs.
  - `GET` as a coach: an `athlete_id` is **required** and checked -- "no org-wide
    hold roster" for a coach.
  - `GET` as a parent: `guardianAccess.ts:guardianAthleteIds` must include the
    requested athlete.
- **What it refuses with:** 403 `Forbidden: coach not assigned to athlete`;
  403 `Forbidden: athlete does not belong to organization`;
  403 `Forbidden: parent not linked to athlete`;
  400 `Missing athlete_id` when a coach or parent omits it.
- **On lift, "not yours" and "not real" land on the same error.** The route
  catches `assertCoachAssignedToAthlete`'s throw and rethrows
  `Missing hold record`, "so a coach cannot probe hold ids across the roster."
- **Coverage counts here on purpose.** The route header says so: a coach may act
  "including athletes they hold an active coverage grant for --
  `assertCoachAssignedToAthlete` admits both". A substitute who cannot pause a
  child's training is a substitute who cannot do the job the grant exists for.

### Gate 3 -- no hold without a sentence written for the child

- **What it checks:** `athlete_explanation`, trimmed, must be non-empty.
- **Where it runs:** `app/api/pilot/training-holds/route.ts:POST`, in the
  `place` branch, before any database work.
- **What it refuses with:** 400
  `Missing athlete_explanation: the sentence the athlete reads is required`.
- **Why it exists:** the code comment is the whole argument, and it is the reason
  this capability is a safety measure rather than a disciplinary one: **"NOT
  optional: a hold a child cannot read a reason for is a punishment, not a safety
  measure."**
- **Where that sentence goes:** it is the only reason text the athlete, their
  guardian, the scheduler's refusal, and the competition gate ever surface. Every
  athlete-facing refusal in this capability is *that sentence plus the lift
  condition*, never a bare "no".

### Gate 4 -- one active hold per athlete, linear history

- **What it checks:** an existing `status = 'active'` row for this
  `(organization_id, athlete_id)`, checked inside the placement transaction; and,
  behind it, a **partial unique index** keyed on `status = 'active'`.
- **Where it runs:** `trainingHolds.ts:placeTrainingHold` -- sweep, then the
  duplicate check, then the insert with a `23505` catch.
- **What it refuses with:** 409
  `Hold already exists: <hold_id> is active for this athlete -- lift it first`
  (the check) or
  `Hold already exists: an active hold was placed concurrently for this athlete -- lift it first`
  (the index). Both reach 409 via `jsonError`'s explicit `Hold already exists`
  branch.
- **Why the sweep runs FIRST:** the module spells out the trap. "The partial
  unique index is keyed on `status='active'` alone, so a stale-but-active row
  would otherwise both fail the duplicate check with a misattributing 'lift it
  first' AND collide at the index on insert."
- **Why the `23505` catch exists:** "two simultaneous placements can both pass the
  check before either commits; the loser hits the partial unique index directly.
  Surface the same caller-facing conflict the check produces, not a raw 500."

### Gate 5 -- expiry is a predicate, and an expiry can never be dressed up as a lift

- **What it checks:** two things.
  - Every enforcement read carries `(expires_at is null or expires_at > now())`
    in the SQL predicate, so a lapsed hold stops mattering with no cron.
  - `liftTrainingHold`'s `UPDATE` carries `status = 'active'` **and**
    `(expires_at is null or expires_at > now())`.
- **Where it runs:** `trainingHolds.ts:liftTrainingHold`,
  `:getActiveTrainingHold`, `:findRegistrationBlockingHold`,
  `:flagContactDuringHold`; and `trainingHolds.ts:sweepExpiredHolds` for the
  stored `status` column.
- **What it refuses with:** 400
  `Unsupported transition: hold is '<expired|lifted>' and cannot be lifted`,
  where the status is **re-derived** rather than read from the possibly-stale
  column; and 400 `Missing hold record` for a hold that does not exist.
- **Why the expiry predicate is on the `UPDATE` itself:** "without it, a hold
  whose clock ran out is still `status='active'` in storage (nothing sweeps a
  single hold-id lookup), so this guarded `UPDATE` would happily 'lift' it --
  stamping `lifted_by_account_id`/`lifted_at` on an action nobody took."
- **Why the sweep exists at all, given the predicates:** "there is no cron in
  this codebase", and without the sweep "the staff list would show a child as
  protected when they are not, a new hold could not be placed without first
  'lifting' the lapsed one (mis-attributing an expiry as a deliberate action)"
  -- and, decisively, the partial unique index is keyed on `status='active'`
  alone, "so a merely read-time expiry predicate is not enough to free the slot
  for a new hold." `listTrainingHolds` sweeps for the same reason: "this is the
  surface a coach or admin reads to answer 'is this child protected right now'."
- **Honest note on the not-found status:** `Missing hold record` matches
  `jsonError`'s `Missing` prefix, so a hold that does not exist is reported as
  **400**, not 404. That is deliberate on the lift path (it is the same message a
  coach gets for another coach's hold, so the two are indistinguishable), and it
  is worth knowing before anyone "corrects" it to a 404 and reopens the probe.

### Gate 6 -- the athlete and their guardian see the athlete-safe projection only

- **What it checks:** the shape of the response, not a condition. `athleteFacing`
  returns exactly `scope`, `athlete_explanation`, `lift_condition_text`,
  `placed_at`, `expires_at`.
- **Where it runs:** `app/api/pilot/training-holds/route.ts:athleteFacing`,
  applied on the `athlete` and `parent` branches of `GET`.
- **What is withheld:** `reason_text` (declared in `PlaceHoldInput` as
  "Staff-facing detail. Never rendered to the athlete."), `reason_category`,
  `placed_by_account_id`, `placed_by_role`, `hold_id`, `lifted_by_account_id`,
  `lift_note`, `status`. Staff get the full row.
- **Why it exists:** the route header -- "Athletes and their guardians read their
  OWN hold in an athlete-safe projection -- explanation, lift condition, scope --
  never `reason_text`, which is staff-facing detail." The clinical or behavioural
  detail a coach records for other staff is not the sentence a twelve-year-old
  should read about themselves.
- **The athlete branch takes no parameter.** It reads
  `principal.athleteId` and nothing else, so there is no id to substitute. A
  principal with no `athleteId` gets `{ ok: true, hold: null }`.

### Gate 7 -- STOP: an active `all_training` hold refuses class registration

- **What it checks:** `findRegistrationBlockingHold` -- `status = 'active'`,
  `scope = 'all_training'`, expiry in the predicate.
- **Where it runs:** `schedulerDb.ts:registerForClassTransactionally`, on the
  **same transaction client**, and deliberately **before** the
  duplicate-registration and capacity checks -- "so a held athlete hears the
  hold's own explanation consistently rather than a mix of conflict messages."
- **What it refuses with:** the outcome `'training_hold'` carrying `holdId`,
  `athleteExplanation` and `liftConditionText`, which the scheduler surface
  renders. The refusal is the athlete's own sentence plus what earns the lift.
- **Why only `all_training`:** stated in the function -- "classes are untyped in
  the scheduler, so a scoped hold cannot know whether a class involves contact;
  the scoped rungs enforce at the contact surface (`contactClearanceGate`) and
  inform on the athlete banner instead."
- **The `SAVEPOINT` is part of the gate.** Called with a client, the probe wraps
  itself in `SAVEPOINT training_hold_probe`, because "a bare 42P01 here would
  leave that transaction ABORTED (Postgres 25P02) for every statement after it,
  so the caller's very next query (the already-registered check) would fail too,
  turning 'table not migrated yet' into 'every class registration 500s, held
  athlete or not'."

### Gate 8 -- REGRESS: contact logged during a hold covering contact raises a near miss

- **What it checks:** that the observation *is* contact
  (`contactClearanceGate.ts:isContactObservation` -- `contact_level`,
  `contact_rounds`, `punch_absorbed`, value `> 0`), then an active hold whose
  scope is in `('all_training', 'contact_only')`.
- **Where it runs:** `trainingHolds.ts:flagContactDuringHold`, called from
  `app/api/pilot/shadow/formulas/observations/route.ts:POST` **before** the
  observation is persisted.
- **What it produces:** a near miss at severity `high` (which auto-escalates),
  deduped one-per-session via
  `shadowNearMisses.ts:findNearMissByTriggerContext` on the trigger
  `contact_observation_during_training_hold` plus the `contextId`.
- **What it does NOT do: refuse the write.** See gate 10.
- **Why the scope set is `('all_training', 'contact_only')` and not
  `conditioning_only`:** the `contact_only` rung *is* the "no contact for now"
  rung. `conditioning_only` restricts conditioning, not contact.
- **Ordering is the gate.** The route calls this before `saveFormulaObservation`,
  "so a failure aborts loudly instead of persisting contact nobody was alerted
  to." The observation write is idempotency-keyed, so a retry is safe; the cost
  is a possible near miss for an observation that then failed to save -- "an
  over-alert, which is the right direction to be wrong in."

### Gate 9 -- contact without a medical clearance raises a near miss (the sibling gate)

- **What it checks:** the same contact test, then
  `shadowMedicalStatus.ts:getLatestMedicalAdministrativeStatus`. **Only an
  explicit `'cleared'` record passes** -- `pending`, `restricted`, `not_cleared`
  and *no record at all* all flag.
- **Where it runs:** `contactClearanceGate.ts:flagContactWithoutClearance`,
  called from the same observations route immediately before gate 8. Registered
  in the Safety Gate Matrix under `gate_key = 'contact_medical_clearance'` as a
  `flag` gate.
- **What it produces:** a near miss at `critical` when the status is
  `not_cleared` or `restricted` ("affirmative medical decisions that this athlete
  should not be taking contact, so contact happening anyway is the most serious
  version of this"), `high` for `pending` or no record ("a process failure rather
  than a known contraindication being overridden"). Plus a
  `pilot.safety_gate_evaluations` row for **both** outcomes -- pass and flag --
  best-effort and gated on the gate row existing, because that table has a
  foreign key that a pre-migration organization would violate.
- **The refusal carries the teaching moment.** The outcome includes `lesson` --
  the gate row's `requirement_text`, falling back to
  "Ask your coach or gym admin to set an explicit 'cleared' medical
  administrative status on file for this athlete before contact continues."
  "A stop names what's missing and where to fix it, not just that it happened."
- **Per-organization deactivation is a configuration, not an override.** Setting
  the gate row's `active_flag = false` turns this specific check off for that
  gym; "that is a per-org configuration decision, not an override of an
  individual evaluation's outcome -- no such override exists."
- **Medical status is a read-only gate to recommendation logic.**
  `shadowMedicalStatus.ts:setMedicalAdministrativeStatus` carries an explicit
  instruction never to be imported from `shadowRecommendations.ts` or
  `shadowDecisions.ts` -- "this is what makes MedicalAdministrativeStatus a
  read-only gate to recommendation logic rather than something a recommendation
  could influence." The related hard refusal,
  `shadowRecommendations.ts:assertMedicalStatusAllowsRecommendation`, throws
  `MedicalStatusBlockedError` -> **409** with a message naming the panel to fix
  it in, and it is **unconditional**: it used to run only when the caller passed
  an `isMedicallySensitive` flag off the HTTP body, and "a safety gate the caller
  decides to arm is not a gate."

### Gate 10 -- these two are FLAGS, not blocks, and that is the doctrine

- **What it checks:** nothing. It is a deliberate decision not to refuse.
- **Where it is argued:** `contactClearanceGate.ts:flagContactWithoutClearance`'s
  header, quoted here because it is the single most counter-intuitive gate
  decision in this capability:

  > This route records contact that has ALREADY happened; refusing the write does
  > not un-spar the athlete, it destroys the only record that it occurred, and it
  > teaches whoever is logging to leave the contact fields blank next time.
  > Under-reporting is the failure mode that actually hurts an athlete.

  `flagContactDuringHold` applies the same reasoning verbatim, and the near-miss
  text says it to the reader: "The record is kept -- refusing it would only hide
  the contact -- but a person must look at why a held athlete took contact."
- **The line between block and flag:** a **pre-action** gate (a class
  registration, a competition entry) refuses, because refusing loses nothing. A
  **post-action** record (an observation of contact that happened) flags, because
  refusing destroys evidence. `safetyGateSeeds.ts` encodes that distinction and
  the repo has its own test for it.

### Gate 11 -- placement and its escalation commit together

- **What it checks:** nothing conditional; a transaction boundary.
- **Where it runs:** `trainingHolds.ts:placeTrainingHold` inserts the hold and
  calls `escalationLadder.ts:fileEscalation` on the same client. Severity is
  `high` for `all_training`, `moderate` for a scoped rung; the target is
  `organization_admin`.
- **Why it exists:** "a hold that could commit without its alarm, or vice versa,
  would let a child's training be paused with no admin surface ever knowing."
  There is no email in this platform, so `pilot.safety_escalations` and
  `/admin/escalations` **are** the notification mechanism.
- **Resolving the escalation does not lift the hold.** Both the module header and
  the escalation's own `reason` text say so: "an escalation resolves when a human
  has looked; a hold lifts here, attributed, or expires on its own clock."

### Gate 12 -- the audit write is deliberately non-fatal, and here is why

- **What it checks:** nothing; it is an error-handling decision worth stating
  because getting it wrong misreports a safety action.
- **Where it runs:** `app/api/pilot/training-holds/route.ts:auditHoldEvent`
  wraps `writePilotAuditEvent` in try/catch, logs
  `training-hold-audit-write-failed` with a sanitized SQLSTATE, and swallows.
- **Why:** the hold row and its same-transaction escalation have already
  committed. "An uncaught audit-write failure here would 500 a request whose
  safety action already succeeded -- the coach believes placing/lifting the hold
  FAILED when the child is in fact held (or freed), and a retry then hits a
  misleading 409/400 instead of the truth." A lost audit row "is a gap an
  operator can close by re-dispatching, not a reason to misreport a committed
  safety action as failed." Four sibling consoles carry the identical doctrine
  (`parent/consent`, `admin/video-compliance`, `compliance/violations`,
  `auth/login`).

### Gate 13 -- one narrow, deliberate fail-open: the pre-migration window

- **What it checks:** every **read** in `trainingHolds.ts` catches Postgres
  `42P01` and returns "no hold" -- `getActiveTrainingHold`,
  `getTrainingHoldById`, `listTrainingHolds`, `findRegistrationBlockingHold`,
  `flagContactDuringHold`. `sweepExpiredHolds` deliberately does **not** swallow
  it, so a placement against a missing table fails outright.
- **Why:** migrations are operator-applied, and "every reader of this
  function -- including the athlete workspace banner, fired on every page
  load -- must degrade gracefully, not 500." The registration path "must degrade
  to its pre-#82 behavior".
- **This is a genuine fail-OPEN, and it is named as one.** On a database where
  `pilot.training_holds` does not exist, no hold blocks anything -- because no
  hold exists to honour. The competition gate added by open PR #452 states the
  same limit in its own README rather than inventing a stricter contract for
  itself.

## Deliberately not gated

- **`conditioning_only` enforces nothing anywhere.** It is a valid, storable,
  escalating scope, it shows on the athlete's banner and the staff list -- and no
  code path reads it. `findRegistrationBlockingHold` narrows to `all_training`;
  gate 8's scope set is `('all_training', 'contact_only')`. A coach who places a
  `conditioning_only` hold has recorded an intention and notified an admin;
  nothing in the platform will stop the conditioning. This is the largest live
  gap in this capability.
- **No hold blocks anything except class registration and (via PR #452)
  competition entry.** Attendance, sparring exposure logging, video upload,
  progression assignment, wall display -- none consults a hold.
- **`lift_condition_text` is optional.** Gate 3 makes the athlete's *explanation*
  mandatory; "what earns the lift -- the teaching moment" is not. A hold can
  therefore be placed with no stated route out of it.
- **`lift_note` is optional too**, unlike the compliance centre's closing note
  (`app/api/pilot/compliance/README.md`, gate 7) and unlike a video retraction's
  required reason. `liftTrainingHold` uses
  `coalesce(nullif($4, ''), lift_note)`, so an empty note leaves whatever was
  there. Lifting a medical hold on a child needs no written reason.
- **`reason_category = 'medical'` is not tied to the medical record.** Nothing
  cross-checks a medical hold against
  `pilot.shadow_medical_administrative_status`, and lifting a medical hold does
  not set a clearance. Gate 9 and gates 3-7 are two independent systems that both
  answer "may this child take contact", and they can disagree.
- **No maximum duration, and `expires_at` may be omitted entirely.** `null` means
  "until explicitly lifted", which is correct for a medical pause and means a
  hold can outlive everyone who remembers why it was placed. Compare
  coach coverage, which caps its TTL at 336 hours precisely because "a bound
  nobody enforces is not a bound".
- **A coach can lift a hold an admin placed,** provided they have standing with
  the athlete. There is no notion of a hold only its placer, or only a higher
  role, may lift.
- **A guardian cannot place, lift, or dispute a hold**, and cannot see who placed
  it (gate 6 withholds `placed_by_role`). They can read the sentence and the lift
  condition. `POST /api/pilot/parent/barrier-report` is the nearest thing to a
  reply channel and it is a separate capability.
- **The athlete-facing refusal is rendered by the caller.** Design-system Law 7
  ("refusal is a stamp, not an error toast") applies to the scheduler and athlete
  surfaces; these routes return JSON and nothing here decides that.
- **`findContactEventBlockingHold` -- the competition-entry enforcement read --
  is added by open PR #452** (`competitionSafetyGates.ts`, wrestling league and
  external competition). It does **not** exist in this branch, and no gate in
  this file depends on it.

## Verified by

- `src/server/pilot/trainingHolds.test.ts` --
  `placeTrainingHold` (the sweep-then-check ordering of gate 4, the duplicate
  409, the `23505` concurrent-placement 409, the same-transaction escalation and
  its severity mapping), `liftTrainingHold` (gate 5: the `status='active'` and
  expiry predicates on the `UPDATE`, the re-derived effective status in the
  refusal, null for a missing hold), `getActiveTrainingHold`,
  `getTrainingHoldById`, `listTrainingHolds` (the sweep on the staff read),
  `findRegistrationBlockingHold` (gate 7: `all_training` only, the expiry
  predicate, the `SAVEPOINT` behaviour on 42P01 with a client and the plain catch
  without one), `flagContactDuringHold (the REGRESS rung)` (gate 8: the scope
  set, the contact test, the one-per-session dedup, and that it flags rather than
  throws), and `module boundary`.
- `app/api/pilot/training-holds/route.test.ts` -- `GET` (the three audiences, the
  athlete-safe projection of gate 6, the parent link check, the coach's required
  `athlete_id`), `POST place` (gate 3's mandatory `athlete_explanation`, the
  scope/category/length/`expires_at` validation, the coach-vs-admin athlete
  gate), `POST lift` (the pre-lift authority check and the identical
  `Missing hold record` for "not yours" and "not real"), and `POST envelope`
  (the unsupported-action refusal).
- `src/server/pilot/contactClearanceGate.test.ts` -- gate 9: `isContactObservation`
  including the zero-is-not-contact case, fail-closed on every non-`cleared`
  status, the severity split, the `lesson` fallback, the per-org
  `active_flag = false` deactivation, and the best-effort evaluation record on
  both pass and flag.
- `src/server/pilot/shadowMedicalStatus.test.ts` and
  `shadowRecommendations.test.ts` -- the read-only-gate property and
  `assertMedicalStatusAllowsRecommendation`'s unconditional fail-closed refusal.
- `src/server/pilot/schedulerDb.test.ts` -- the registration outcome of gate 7 as
  the scheduler sees it: the `'training_hold'` outcome, and that the probe runs
  before the duplicate and capacity checks.
- `src/server/pilot/safetyGateMatrix.test.ts` and `safetyGateSeedsOwnership.test.ts`
  -- the gate-row substrate gate 9 records evaluations against, and the
  block-versus-flag classification gate 10 relies on.
- `src/server/pilot/trainingHolds.pg.test.ts` -- the partial unique index and the
  `expires_at > placed_at` CHECK against a real database. **Not run by this lane**
  (`*.pg.test.ts` is excluded here); named so the next reader knows it exists.
