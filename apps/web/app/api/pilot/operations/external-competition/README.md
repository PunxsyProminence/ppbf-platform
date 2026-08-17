# External competition -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

## What this capability is

The external-competition skeleton (owner decision 2026-08-15: deliberately
skeletal until real competitions define requirements) -- a competition somebody
else runs, and the athletes this gym enters into it. Two routes:

- `competitions/route.ts` -- the competition record (name, date, location,
  sanctioning body, status).
- `entries/route.ts` -- an entry, which is a LINK from a competition to one
  athlete, plus that entry's result. Server module:
  `src/server/pilot/externalCompetition.ts`.

Staff read (`COMPETITION_READ_ROLES` = coach, organization_admin, admin); admin
write (`COMPETITION_WRITE_ROLES` = organization_admin, admin). `platform_owner`
is deliberately absent from both.

## What it may do

- Create, list and re-status competitions.
- Enter an athlete into a competition, and list a competition's entries with each
  athlete's name joined live from `pilot.athletes` in the same organization.
- Record a per-entry result (`won` / `lost` / `draw` / `no_contest`), where a
  loss requires a lesson note (owner decision 2026-08-16) -- refused both in the
  module and by the database constraint beneath it.
- Answer with a hidden not-found for a competition id from another organization.

## What it may NOT do

- It may not copy anything about a child. Entry rows hold the athlete link only;
  names are read through `pilot.athletes`, never duplicated.
- It may not enter an athlete the acting account has no standing with (gate 1).
- It may not enter an athlete under a hold covering contact (gate 2), or one
  without a signed travel waiver (gate 3).
- It may not record a loss without its lesson.
- It has no federation integration, result sync, brackets, travel logistics or
  compliance checklists, and must not grow them until real competitions define
  them.
- It has no override path around any gate below. See "Deliberately not gated"
  for what that costs and why it is still the right answer.

## Gates

### Gate 1 -- the actor must have standing with this child

- **What it checks:** that the acting account may act on this specific athlete at
  all: an organization admin over any athlete in their own organization, a coach
  only over athletes they are `coach_id` of record for or hold an active
  `pilot.coach_coverage` grant on. `platform_owner` and `board` are refused
  outright.
- **Where it runs:**
  `src/server/pilot/competitionSafetyGates.ts:assertAthleteMayBeEnteredInCompetition`
  (first of the three), called from
  `app/api/pilot/operations/external-competition/entries/route.ts:POST` before
  `addCompetitionEntry`. The check itself is
  `src/server/pilot/access.ts:assertActorCanAccessAthlete` -- called, not
  reimplemented, and not modified (PR #431 owns that file).
- **What it refuses with:** the access module's own messages, unchanged, at
  **403** via `jsonError`'s `Forbidden` branch --
  `Forbidden: coach not assigned to athlete`,
  `Forbidden: athlete does not belong to organization`,
  `Forbidden: platform owner cannot access organization-private athlete records by default`,
  `Forbidden: board role is restricted to organization-level aggregates`.
- **Why it exists:** every other athlete-scoped capability in the app routes
  through this one function; these two competition capabilities were the only
  exceptions, gating on a role string alone. **Honest scope note:** on this route
  the gap was latent rather than live, because `COMPETITION_WRITE_ROLES` is
  already admin-only, so no coach could reach the write to begin with. What the
  gate closes is the shape of the hole: the per-athlete question is now asked
  structurally, so adding `coach` to the write set (an obvious next step for a
  skeleton) cannot silently grant every coach every child. It also refuses
  `platform_owner`/`board` here rather than relying on the role set to keep them
  out.

### Gate 2 -- no entry for an athlete held out of contact

- **What it checks:** whether the athlete has an **active** training hold whose
  scope is `all_training` (STOP) or `contact_only` (REGRESS), expiry evaluated in
  the SQL predicate so a lapsed hold stops blocking without a sweep.
  `conditioning_only` does not block -- that rung restricts conditioning, not
  contact.
- **Where it runs:**
  `src/server/pilot/competitionSafetyGates.ts:assertAthleteMayBeEnteredInCompetition`
  (second), reading
  `src/server/pilot/trainingHolds.ts:findContactEventBlockingHold`.
- **What it refuses with:** **403**, `ForbiddenError`, code
  `TRAINING_HOLD_BLOCKS_COMPETITION`, message
  `Training hold: this athlete cannot be added to an external competition while a hold covering contact is active (scope: <scope>).`
  followed by the hold's `athlete_explanation` and
  `What earns the lift: <lift_condition_text>` when those are present. The
  blocked attempt is also recorded as a `blocked` evaluation against the existing
  `training_hold` gate row (`safetyGateMatrix.ts:recordSafetyGateEvaluation`) --
  best-effort, skipped when the gate row or `pilot.safety_gates` is absent,
  exactly as the scheduler's own `training_hold` branch does it.
- **Why it exists:** a competition is contact and maximal exertion by
  definition, in front of strangers, with a result on the line. Before this, a
  child on a medical hold could be entered into one while the gym floor was
  refusing them a class. `findRegistrationBlockingHold` stops at `all_training`
  because scheduler classes are untyped; a competition is not ambiguous, so
  `contact_only` has to bar it too.
- **Refusal, not a warning:** `safetyGateSeeds.ts` records the repo's own test
  and this passes it -- `'block'` because the gate guards a **pre-action**,
  "where refusing loses nothing; post-action records stay flag-only". No record
  of anything that happened is destroyed by refusing an entry, so
  `contactClearanceGate.ts`'s under-reporting doctrine (never refuse a write that
  records something already done) does not apply. The scheduler refuses the same
  condition with the same status.

### Gate 3 -- no entry without a signed travel waiver

- **What it checks:** the athlete's current `travel` waiver status, read
  per-athlete from `pilot.waivers` (newest row wins; `pilot.waivers` is
  append-only). Only `signed` passes; `missing`, `declined` and `withdrawn` all
  refuse.
- **Where it runs:**
  `src/server/pilot/competitionSafetyGates.ts:assertAthleteMayBeEnteredInCompetition`
  (third), reading
  `src/server/pilot/waiverCompliance.ts:getAthleteWaiverStatus` -- a new
  per-athlete narrowing added next to the existing org-wide
  `getOrganizationWaiverStatus`, so a gate does not have to pull the whole
  roster's consent state to ask about one child.
- **What it refuses with:** **409**, `ConflictError`, code
  `TRAVEL_WAIVER_NOT_SIGNED`, one of:
  - `missing` -> `Travel waiver missing: no signed travel waiver is on file for this athlete, and an external competition means taking a minor off-site. Record the guardian's travel consent on the athlete's consent page first; /admin/waiver-status lists who else is missing one.`
  - `declined` -> `Travel waiver declined: this athlete's guardian declined the travel waiver, so the athlete cannot be added to an external competition. That is a decision on file, not missing paperwork -- only a newly signed travel waiver changes it.`
  - `withdrawn` -> `Travel waiver withdrawn: this athlete's travel consent has been withdrawn, so the athlete cannot be added to an external competition. Only a newly signed travel waiver restores it.`
- **Why 409 and not 403:** `errors.ts` defines `ConflictError` as "a precondition
  on a *different* resource than the one addressed" and cites missing guardian
  consent as the case it was written for. A 403 would say the admin may not do
  this (they may); a 400 would blame their input. What is missing is a document
  on the athlete's consent record.
- **Why it exists:** an external competition is by definition somewhere else.
  `waiverCompliance.ts` has tracked a `travel` waiver type all along and
  `/admin/waiver-status` surfaces it, but neither competition module referenced
  waivers at all -- so a child with no travel consent on file, or whose guardian
  had actively declined, could be entered and transported.
- **Refusal, not a warning:** a travel waiver is a legal consent document, not a
  judgement a coach can weigh. A hold is lifted by a person; consent is either
  given or it is not, and no "recorded warning" makes a gym lawfully able to
  transport a minor without it. It is also a pre-action, so it passes the same
  `safetyGateSeeds.ts` block-versus-flag test as gate 2.
- **Known over-breadth, chosen deliberately:** every competition is treated as
  travel. The skeleton stores `location` as free text with no home/away flag, so
  there is no honest way to tell an away competition from one held at this gym.
  Guessing in the permissive direction means a child in a vehicle without
  consent, so this fails closed until a real home/away distinction exists to
  read. The cost is real: a home competition still needs travel consent on file
  before an entry can be filed.

## Deliberately not gated

- **The entries READ.** A coach can list any competition's entries and see every
  athlete's name, entry status and result, with no per-athlete scoping. This is
  not an oversight and was not changed:
  `app/api/pilot/athletes/list/route.ts` records the doctrine in full -- "a coach
  plans a floor and picks up cover across the whole gym" -- and already lets any
  coach read every athlete's name and gym status org-wide, restricting only `dob`
  and `emergency_contact`. Narrowing it here and nowhere else would be an
  inconsistency dressed as a gate.
- **`PATCH` (recording a result).** Not gated on the athlete, deliberately. It is
  admin-only, addresses an `entry_id` rather than an athlete, and records
  something that has already happened -- which is precisely the case
  `contactClearanceGate.ts` says must never be refused, because refusing destroys
  the only record of the event and teaches people to leave fields blank. Its own
  rule (a loss requires a lesson) is enforced in
  `externalCompetition.ts:recordEntryResult` and by the database constraint
  beneath it. A per-athlete standing check *could* be added here once the entry
  is resolved to its athlete; it was left out to keep this change to the
  athlete-linking point, and it is a smaller hole than the ones closed above
  because no new child becomes reachable through it.
- **The competitions route.** `competitions/route.ts` never names an athlete, so
  there is no per-athlete gate to run. It stays on role checks. `location` and
  `sanctioning_body` are free text and are not validated against anything -- see
  the home/away note above.
- **Age, weight and medical clearance for competition eligibility.** Real
  competition needs all three. None is gated here, because the skeleton has no
  weight class, no age bracket and no sanctioning rules to hang them on, and
  inventing them would be exactly the guessed requirement the owner decision
  forbids. Medical clearance is currently enforced at the contact-observation
  surface (`contactClearanceGate.ts`, a flag gate) and by the training-hold
  rungs, not at competition entry. **This is a real remaining gap:** an athlete
  with medical status `not_cleared` and no training hold placed can still be
  entered.
- **Withdrawing an entry.** There is no route for it yet. When one is added it
  needs no athlete-safety gate (withdrawal is always the safe direction) but does
  need the same gate 1 standing check.
- **No safety-gate evaluation row for gate 3.** Gate 2's block is recorded
  against the existing `training_hold` gate key. Gate 3 records nothing: there is
  no `travel_waiver` row in `pilot.safety_gates`, and adding one means a new seed
  in `safetyGateSeeds.ts` *and* a matching migration (enforced by
  `safetyGateSeedsOwnership.test.ts`), which is outside this change's scope. The
  refusal is not weakened by this; only the "how often is this refused" audit
  trail is absent.
- **The refusal is rendered as an error alert, not a stamp.** Design-system Law 7
  says "refusal is a stamp, not an error toast", and
  `app/operations/external-competition/page.tsx` puts every non-OK response body
  into its existing `alert-msg` box. The message reaches the admin intact and
  says what to fix; making it a `.stamp` is a UI change that was left out of this
  change on purpose to keep it to the server gates.

## Verified by

- `src/server/pilot/competitionSafetyGates.test.ts` -- all three gates: the
  still-works case, gate-1 ordering (no hold or consent state is read for an
  actor who may not act on the child), `contact_only` and `all_training` refusals
  with the athlete's words, the recorded `blocked` evaluation, the pre-migration
  `safety_gates` case still refusing, and each travel-waiver status.
- `src/server/pilot/trainingHolds.test.ts` (`findContactEventBlockingHold`) --
  that the scope set is `('all_training', 'contact_only')` and excludes
  `conditioning_only`, that expiry is in the predicate, and the 42P01 vs. other
  database error behaviour.
- `src/server/pilot/waiverCompliance.test.ts` (`getAthleteWaiverStatus`) --
  absence reads as `missing`, newest row wins, `declined`/`withdrawn` are
  reported as themselves, and a missing `pilot.waivers` relation is NOT degraded
  into a pass.
- `app/api/pilot/operations/external-competition/entries/route.test.ts` -- the
  wiring: the gate is called with this athlete and this competition, it is called
  before the write (`invocationCallOrder`), each refusal reaches the caller at
  403/403/409 with its code intact, no entry is written on any refusal, a clear
  athlete still gets filed, and the pre-existing loss-requires-a-lesson and
  duplicate-entry behaviours are unchanged.
