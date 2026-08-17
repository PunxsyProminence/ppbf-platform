# Wrestling league -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

## What this capability is

The wrestling-league skeleton (owner decision 2026-08-15: deliberately skeletal
until a real league defines requirements). Three records, three routes:

- `seasons/route.ts` -- a named season with a start date and a status.
- `events/route.ts` -- an event inside a season (name, date, location).
- `roster/route.ts` -- a season roster entry, which is a LINK from a season to
  one athlete. Server module: `src/server/pilot/wrestlingLeague.ts`.

Staff read (`LEAGUE_READ_ROLES` = coach, organization_admin, admin); admin write
(`LEAGUE_WRITE_ROLES` = organization_admin, admin). `platform_owner` is
deliberately absent from both.

## What it may do

- Create, list and re-status seasons, and create/list events within a season.
- Link an athlete to a season roster, and list a season's roster with each
  athlete's name joined live from `pilot.athletes` in the same organization.
- Answer with a hidden not-found for a season id from another organization.

## What it may NOT do

- It may not copy anything about a child. Roster rows hold the athlete link
  only; names are read through `pilot.athletes`, never duplicated.
- It may not link an athlete the acting account has no standing with (gate 1).
- It may not put an athlete under a hold covering contact onto a roster
  (gate 2), or one without a signed travel waiver (gate 3).
- It has no match cards, brackets, weigh-ins, scoring or scheduling, and must
  not grow them until a real league defines them.
- It has no override path around any gate below. See "Deliberately not gated"
  for what that costs and why it is still the right answer.

## Gates

### Gate 1 -- the actor must have standing with this child

- **What it checks:** that the acting account may act on this specific athlete
  at all: an organization admin over any athlete in their own organization, a
  coach only over athletes they are `coach_id` of record for or hold an active
  `pilot.coach_coverage` grant on. `platform_owner` and `board` are refused
  outright.
- **Where it runs:**
  `src/server/pilot/competitionSafetyGates.ts:assertAthleteMayBeEnteredInCompetition`
  (first of the three), called from
  `app/api/pilot/operations/wrestling-league/roster/route.ts:POST` before
  `addLeagueRosterEntry`. The check itself is
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
  exceptions, gating on a role string alone. **Honest scope note:** on this
  route the gap was latent rather than live, because `LEAGUE_WRITE_ROLES` is
  already admin-only, so no coach could reach the write to begin with. What the
  gate closes is the shape of the hole: the per-athlete question is now asked
  structurally, so adding `coach` to the write set (an obvious next step for a
  skeleton) cannot silently grant every coach every child. It also refuses
  `platform_owner`/`board` here rather than relying on the role set to keep
  them out.

### Gate 2 -- no roster entry for an athlete held out of contact

- **What it checks:** whether the athlete has an **active** training hold whose
  scope is `all_training` (STOP) or `contact_only` (REGRESS), expiry evaluated
  in the SQL predicate so a lapsed hold stops blocking without a sweep.
  `conditioning_only` does not block -- that rung restricts conditioning, not
  contact.
- **Where it runs:**
  `src/server/pilot/competitionSafetyGates.ts:assertAthleteMayBeEnteredInCompetition`
  (second), reading
  `src/server/pilot/trainingHolds.ts:findContactEventBlockingHold`.
- **What it refuses with:** **403**, `ForbiddenError`, code
  `TRAINING_HOLD_BLOCKS_COMPETITION`, message
  `Training hold: this athlete cannot be added to a wrestling league season roster while a hold covering contact is active (scope: <scope>).`
  followed by the hold's `athlete_explanation` and
  `What earns the lift: <lift_condition_text>` when those are present. The
  blocked attempt is also recorded as a `blocked` evaluation against the
  existing `training_hold` gate row
  (`safetyGateMatrix.ts:recordSafetyGateEvaluation`) -- best-effort, skipped
  when the gate row or `pilot.safety_gates` is absent, exactly as the
  scheduler's own `training_hold` branch does it.
- **Why it exists:** a wrestling match is contact and maximal exertion by
  definition. Before this, a child on a medical hold -- concussion protocol,
  ribs, anything -- could be committed to a competitive season while the gym
  floor was refusing them a class. `findRegistrationBlockingHold` stops at
  `all_training` because scheduler classes are untyped; a match is not
  ambiguous, so `contact_only` has to bar it too, or "no contact for now" means
  no sparring on Tuesday and a match on Saturday.
- **Refusal, not a warning:** `safetyGateSeeds.ts` records the repo's own test
  and this passes it -- `'block'` because the gate guards a **pre-action**,
  "where refusing loses nothing; post-action records stay flag-only". No record
  of anything that happened is destroyed by refusing a roster add, so
  `contactClearanceGate.ts`'s under-reporting doctrine (never refuse a write
  that records something already done) does not apply. The scheduler refuses
  the same condition with the same status.

### Gate 3 -- no roster entry without a signed travel waiver

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
  - `missing` -> `Travel waiver missing: no signed travel waiver is on file for this athlete, and a wrestling league season roster means taking a minor off-site. Record the guardian's travel consent on the athlete's consent page first; /admin/waiver-status lists who else is missing one.`
  - `declined` -> `Travel waiver declined: this athlete's guardian declined the travel waiver, so the athlete cannot be added to a wrestling league season roster. That is a decision on file, not missing paperwork -- only a newly signed travel waiver changes it.`
  - `withdrawn` -> `Travel waiver withdrawn: this athlete's travel consent has been withdrawn, so the athlete cannot be added to a wrestling league season roster. Only a newly signed travel waiver restores it.`
- **Why 409 and not 403:** `errors.ts` defines `ConflictError` as "a
  precondition on a *different* resource than the one addressed" and cites
  missing guardian consent as the case it was written for. A 403 would say the
  admin may not do this (they may); a 400 would blame their input. What is
  missing is a document on the athlete's consent record.
- **Why it exists:** a league season means away meets. Nothing in either
  competition capability referenced waivers at all, so a child with no travel
  consent on file -- or whose guardian had actively declined -- could be
  committed to a season and, at the next event, put in a vehicle.
- **Refusal, not a warning:** a travel waiver is a legal consent document, not
  a judgement a coach can weigh. A hold is lifted by a person; consent is
  either given or it is not, and no "recorded warning" makes a gym lawfully
  able to transport a minor without it. It is also a pre-action, so it passes
  the same `safetyGateSeeds.ts` block-versus-flag test as gate 2.
- **Known over-breadth, chosen deliberately:** every season is treated as
  travel. The skeleton stores `location` as free text with no home/away flag,
  so there is no honest way to tell a home meet from an away one. Guessing in
  the permissive direction means a child in a vehicle without consent, so this
  fails closed until a real home/away distinction exists to read. The cost is
  real: a gym cannot draft a season roster before collecting travel waivers.

## Deliberately not gated

- **The roster READ.** A coach can list any season's roster and see every
  athlete's name, with no per-athlete scoping. This is not an oversight and was
  not changed: `app/api/pilot/athletes/list/route.ts` records the doctrine in
  full -- "a coach plans a floor and picks up cover across the whole gym" -- and
  already lets any coach read every athlete's name and gym status org-wide,
  restricting only `dob` and `emergency_contact`. A roster row exposes a name
  and a season membership, nothing that read does not already give. Narrowing
  it here and nowhere else would be an inconsistency dressed as a gate.
- **Seasons and events.** `seasons/route.ts` and `events/route.ts` never name an
  athlete, so there is no per-athlete gate to run. They stay on role checks plus
  the org-scoped season lookup. An event's `location` is not validated and not
  checked against anything -- see the home/away note above.
- **Age, weight and medical clearance for match eligibility.** Real wrestling
  needs all three. None is gated here, because the skeleton has no weight class,
  no age bracket and no match record to hang them on, and inventing them would
  be exactly the guessed requirement the owner decision forbids. Medical
  clearance is currently enforced at the contact-observation surface
  (`contactClearanceGate.ts`, a flag gate) and by the training-hold rungs, not at
  competition entry. **This is a real remaining gap:** an athlete with medical
  status `not_cleared` and no training hold placed can still be rostered.
- **Withdrawing or removing a roster entry.** There is no such route yet. When
  one is added it needs no athlete-safety gate (removal is always the safe
  direction) but does need the same gate 1 standing check.
- **No safety-gate evaluation row for gate 3.** Gate 2's block is recorded
  against the existing `training_hold` gate key. Gate 3 records nothing: there
  is no `travel_waiver` row in `pilot.safety_gates`, and adding one means a new
  seed in `safetyGateSeeds.ts` *and* a matching migration (enforced by
  `safetyGateSeedsOwnership.test.ts`), which is outside this change's scope. The
  refusal is not weakened by this; only the "how often is this refused" audit
  trail is absent.
- **The refusal is rendered as an error alert, not a stamp.** Design-system Law
  7 says "refusal is a stamp, not an error toast", and
  `app/operations/wrestling-league/page.tsx` puts every non-OK response body
  into its existing `alert-msg` box. The message reaches the admin intact and
  says what to fix; making it a `.stamp` is a UI change that was left out of
  this change on purpose to keep it to the server gates.

## Verified by

- `src/server/pilot/competitionSafetyGates.test.ts` -- all three gates: the
  still-works case, gate-1 ordering (no hold or consent state is read for an
  actor who may not act on the child), `contact_only` and `all_training`
  refusals with the athlete's words, the recorded `blocked` evaluation, the
  pre-migration `safety_gates` case still refusing, and each travel-waiver
  status.
- `src/server/pilot/trainingHolds.test.ts` (`findContactEventBlockingHold`) --
  that the scope set is `('all_training', 'contact_only')` and excludes
  `conditioning_only`, that expiry is in the predicate, and the 42P01 vs. other
  database error behaviour.
- `src/server/pilot/waiverCompliance.test.ts` (`getAthleteWaiverStatus`) --
  absence reads as `missing`, newest row wins, `declined`/`withdrawn` are
  reported as themselves, and a missing `pilot.waivers` relation is NOT degraded
  into a pass.
- `app/api/pilot/operations/wrestling-league/roster/route.test.ts` -- the wiring:
  the gate is called with this athlete and this season, it is called before the
  write (`invocationCallOrder`), each refusal reaches the caller at 403/403/409
  with its code intact, no roster row is written on any refusal, and a clear
  athlete still gets filed.
