# Engine Unlock Proposal — Module 036: Periodization / Block Planning Engine

| Field | Value |
|-------|-------|
| Status | PROPOSAL (owner approval requested) — **partially superseded by the foundation slice below** |
| Module stub | `docs/capabilities/modules/036-periodization-block-planning-engine.md` |
| Category | Physical Training System (`physicalTrainingSystem`) |
| Prepared against | current `infra/azure/*.sql` schema, read-only |

This document proposes the honesty gate that must be satisfied before Module 036
is allowed to compute or display anything to a user. It does not propose an
implementation, a UI, a new table, or an API. Nothing here is authorization to
build; it is the basis for an owner decision on what the module may and may
not do.

---

## Implementation status (added after the foundation slice shipped; updated for slice 2)

This section records what is now true in the repository. Everything below it
was written before any of it existed and is left standing as the reasoning
that produced it, **which means the present tense elsewhere in this document
is the present tense of the day it was written.** Where the two disagree,
this section is current.

**Built (foundation slice, this branch):** `pilot.athlete_development_blocks`
— the coach-authored plan record the "Schema reality check" below says does
not exist. One row per block: `organization_id`, `block_id`, `athlete_id`,
`title`, `training_emphasis`, `starts_on`, `ends_on`, `status`
(`draft`/`active`/`completed`/`cancelled`), `created_by_account_id`,
`created_at`, `updated_at`. Composite FK into
`pilot.athletes(organization_id, athlete_id)`, `ends_on >= starts_on`, a
closed lifecycle vocabulary, non-blank title and emphasis. A thin
organization-scoped data layer (`apps/web/src/server/pilot/athleteDevelopmentBlocks.ts`)
creates, reads and re-states a block, and refuses a creator holding no active
`pilot.organization_memberships` row in the block's organization.

**Built (slice 2, Full Spectrum block objectives):**
`pilot.athlete_development_block_objectives` — the child rows a block's
domains live in, one row per objective: `organization_id`, `objective_id`,
`block_id`, `domain`, `objective`, `status`, `created_by_account_id`,
`created_at`, `updated_at`. Composite FK into
`pilot.athlete_development_blocks(organization_id, block_id)` with
`on delete cascade`, so tenancy and the athlete link both arrive through the
parent and an objective cannot outlive it. No `athlete_id` is copied down. A
thin data layer
(`apps/web/src/server/pilot/athleteDevelopmentBlockObjectives.ts`) adds,
reads and re-states an objective. Access is not decided there: every read
resolves its parent through `getDevelopmentBlock`, so an objective is
reachable by exactly the people who can reach the block's athlete (Open
Question 7), and every write stands on the same
`DEVELOPMENT_BLOCK_WRITE_ROLES` gate the parent uses (Open Question 5).

**The domain vocabulary is all ten.** `nutrition_body_composition` shipped
withheld — for the reason
`pilot_slice_postgres_goal_category_progress_migration.sql` gave when it
withheld `Weight Loss` / `Weight Gain` from the athlete goal categories — and
was **admitted by owner decision 2026-08-28** on the ground that module 200
is built. See Open Question 6 below for the full record, including what that
decision does not cover. The field is registered in `FIELD_TIERS` as
`athlete_development_block_objectives.objective`.

**The illustrative name in this document is not the shipped name.** Section
(b) below writes `pilot.periodization_blocks`; the table is
`pilot.athlete_development_blocks`, which is the owner's own vocabulary for
the capability and avoids implying the platform models periodization science.
Read every `periodization_blocks` reference below as naming this table.

**NOT built, and not decided:**

- Every comparison / plan-vs-actual surface in sections (a)–(d). Nothing
  reads a block yet. No block carries an adherence state, because the
  execution/comparison row that would hold one does not exist.
- ~~Any surface that reads an objective.~~ **Built.**
  `/api/pilot/coach/development-block-objectives` and an objectives panel on
  `/coach/development-blocks`: a coach attaches an objective per Full Spectrum
  domain, reads them back in the coach's own words, and moves one through the
  lifecycle. What is still NOT built is any roll-up — nothing counts how many
  reached `completed`, expresses that count as a proportion, or presents
  either as a judgment about a block or the athlete it names, and both the
  route test and the page test assert the absence rather than trusting it.
  The domain vocabulary is served by the route rather than copied into the
  screen, so a screen can never offer a value the database would refuse; the
  human labels are local and pinned to `FULL_SPECTRUM_DOMAINS` in both
  directions.
- ~~Any API route or UI.~~ **#767 shipped both** while this slice was in
  flight: `/api/pilot/coach/development-blocks` and
  `/coach/development-blocks`, plus `updateDevelopmentBlock`. That route had
  already reached the same answer this slice's Open Question 7 reaches — it
  gates every entry point on `assertActorCanAccessAthlete` and serves
  `['coach','organization_admin','admin']`, the same set as
  `DEVELOPMENT_BLOCK_WRITE_ROLES` — so the two agree rather than collide. What
  changed on merge is where the rule lives: the route used to re-derive a
  coach's reach with `athleteIdsForCoach` and filter the module's gym-wide
  output; it now hands the principal down and returns what the data layer
  answered. `updateDevelopmentBlock` gained the write gate the other two
  mutators carry.
- Any read surface for an **athlete or a guardian**. The data layer serves
  them; every route that exists serves staff, objectives included. That is the
  right order — the boundary is enforced before anything is built on it — and
  the slice that changes it owes its own safeguarding decisions first: what a
  minor sees of a coach's raw words, and whether a body-composition objective
  about them is part of it.
- ~~The optional competition/event target (Open Question 2), still open and
  still unbuilt.~~ **Answered (a) and built by #771**, as a name and a date
  only: naming a target derives no taper, no peak, no volume curve and no
  weight plan, and nothing reads it back as a training input.

Nothing about the unlock gates in this document is satisfied by the table
existing. Layer 0 is now structurally possible, not met.

---

## Schema reality check (read first)

**The single largest finding of this review: no table in `infra/azure/*.sql`
currently stores a coach-authored training plan — a block, mesocycle,
macrocycle, or taper with a name, a date range, and a stated training intent.
This did not exist anywhere in the schema when this review was written, and
this proposal did not create it — the foundation slice recorded above
subsequently did, as `pilot.athlete_development_blocks`.** What exists instead, and what is adjacent enough to be
mistaken for it:

- `pilot.session_scripts.phase` — a **nullable free-text** field on a
  single delivered session ("accumulation, sharpening, taper, etc." per the
  column comment) with **no enumerated vocabulary, no date range, and no
  linkage between sessions that share a phase**. It labels one session, not
  a multi-week block. Two sessions three weeks apart with `phase =
  'accumulation'` are not structurally connected by anything in this table —
  the connection would have to be inferred by matching a text string, which
  is not a defensible basis for a "block."
- `pilot.session_script_runs` — planned-vs-actual, but at the scale of one
  session's delivery (`blocks_completed`, `deviation_note`,
  `what_worked`/`what_did_not`), not a training block spanning weeks.
- `pilot.intervention_protocols` / `intervention_executions` /
  `intervention_evidence_links` / `intervention_outcome_reviews` — **the
  vocabulary this module must reuse, not the table it can write into.**
  This ledger's planned-snapshot/actual/adherence/evidence/review pattern
  (protocol states intent → execution snapshots `planned_exposure` and
  never rewrites it → `adherence` is an explicit enumerated state, never a
  percentage → evidence links are typed and role-tagged → outcome review is
  human-authored, three separate columns, never one score) is exactly the
  shape a defensible periodization record needs. But `intervention_*` rows
  are scoped to one hypothesis about one problem, sized in
  `intended_exposure` dimension units (rounds, cue exposures...) — not to a
  multi-week block of an athlete's whole training plan. Reusing these
  *tables* for periodization would misuse a hypothesis-testing ledger as a
  training-calendar; reusing their *vocabulary* in a new, purpose-built
  table is the defensible path (see Open Question 1).
- `pilot.training_attempts`, `pilot.activity_log`, `pilot.assessments`,
  `pilot.athlete_check_ins`, `pilot.readiness` — the real recorded events
  a plan could eventually be compared against, once a plan exists to
  compare against them. None of these carries a `block_id`, a phase, or any
  forward-looking target.
- `pilot.external_competitions` / `pilot.external_competition_entries` and
  `pilot.wrestling_league_seasons` / `_events` / `_roster_entries` — the two
  competition surfaces, and both are **deliberately minimal by owner
  decision** ("build both skeletons knowing requirements are guessed until
  a real league exists"). `external_competitions` carries only
  `competition_date`, `location`, `sanctioning_body`, `status`; wrestling
  league events carry only `event_date`, `location`, `status`. Neither
  table has brackets, weight classes, results, or anything a taper
  calculation could read. A block plan could *optionally* point at a
  `competition_id` or `event_id` as a target date, but that is a new
  foreign key this proposal does not create, and the target itself would
  still only ever be a date and a name — never a source of loading
  guidance.

**Conclusion: Module 036 cannot compute a periodization model, a loading
progression, or a taper today, because there is nothing to compute from.**
The stub's acceptance criterion "Data model / tables named" cannot be
checked off by pointing at an existing table — one does not exist. The
defensible version of this module, per the assignment brief, is: (1) a new,
narrowly-scoped table where a coach records their own plan in their own
words — block name, stated training emphasis, start/end dates, optional
target-date link — modeled on `intervention_protocols`' "stated intent,
never computed" shape; and (2) a comparison surface, modeled on
`intervention_executions`' planned-vs-actual/adherence pattern, that shows
what the plan said against what `training_attempts`/`activity_log`/
`assessments`/`intervention_executions` rows actually happened inside the
plan's date window — using the *same* adherence vocabulary
(`delivered_as_planned` / `delivered_with_deviations` / `under_delivered` /
`not_delivered` / `unknown`) rather than inventing a parallel one. This
proposal describes the unlock gate for that future surface; it does not
build it.

---

## (a) What it computes / shows

Nothing in this module may be a derived training-science number. No load
score, no acute:chronic workload ratio, no readiness-adjusted volume
recommendation, no auto-generated taper curve, no fatigue index — none of
these are stored anywhere and none should be invented to feed this module.
Everything here is either (i) a coach's own words, recorded verbatim and
never algorithmically altered, or (ii) a plain count/date comparison
against real recorded rows.

**Shown, unlocked (assuming the plan-recording table in the schema-reality
section above is approved and built in a separate ticket):**
- The coach-authored plan exactly as written: block name, stated training
  emphasis (free text, the coach's own vocabulary — never coerced into a
  fixed taxonomy like "linear" or "block" or "conjugate"), start date, end
  date, and — only if the coach explicitly linked one — the target
  `external_competitions.competition_date` or
  `wrestling_league_events.event_date` it was built toward, shown with the
  competition/event's own `status` (`planned`/`completed`/`cancelled`) so a
  cancelled target is never silently treated as still live.
- For the plan's date window: real counts from real tables —
  `training_attempts` rows by `metric_kind` with their real `made`/failed
  split, `activity_log` hours by `activity_domain` with real
  `duration_minutes` sums, `assessments` administered
  (`administered_on` within window), and any `intervention_executions`
  that ran with `actual_start`/`actual_end` overlapping the window — each
  labeled with its own real column values, never combined into one
  "compliance" or "adherence percentage."
- An explicit adherence *state* for the block as a whole, chosen by a
  human (a coach), from the same enumerated vocabulary
  `intervention_executions.adherence` already uses
  (`delivered_as_planned`/`delivered_with_deviations`/`under_delivered`/
  `not_delivered`/`unknown`) — never computed by the platform from the
  counts above. The counts are shown *beside* the human's stated adherence
  as its supporting evidence, exactly as `intervention_evidence_links`
  exists to let a human-authored judgment point at typed source rows
  without the platform pretending to derive the judgment itself.
- Deviations and why, in the coach's own words — mirroring
  `intervention_executions.deviations` / `.deviation_reason`, never
  auto-classified.

**Never shown, at any unlock state:**
- Any invented periodization doctrine: no auto-generated block structure,
  no "you are in your accumulation phase, reduce load by X%," no
  volume/intensity progression curve, no taper percentage. Block
  structures and loading progressions are coaching doctrine this platform
  does not possess and must not fabricate.
- A single "plan adherence score," percentage, grade, or index.
- Any cross-athlete comparison, cohort average, or leaderboard of who is
  "on plan" — forbidden at every unlock tier, not a later phase.
- Any claim that a phase label (e.g. "taper") describes a physiological
  state — it is shown strictly as the coach's own chosen word, with no
  platform-asserted meaning attached.

**Explicit UNKNOWN states:**
- No plan recorded for an athlete/date range: shown as "No training block
  recorded for this period" — never a blank chart implying zero training
  happened, since `training_attempts`/`activity_log` may still have rows
  with no plan to compare them against.
- A plan with no adherence judgment yet recorded by a coach: shown as
  `unknown` (the same honest default `intervention_executions.adherence`
  already uses), never inferred from the raw counts.
- A plan linked to a competition/event whose `status` is `cancelled`:
  shown with a visible "target event cancelled" flag, never silently
  treated as still active.
- A block window with zero `training_attempts`/`activity_log` rows at
  all: shown as "no recorded training activity in this window" — distinct
  from "delivered as planned" and distinct from "not delivered," because
  the schema cannot distinguish "athlete did not attend" from "attendance
  was not logged" without an `activity_log` row either way.

---

## (b) Data prerequisites

Layer 0 is structural and precedes every per-athlete/per-org count below:
**a coach-authored plan-recording table, built per Open Question 1, must
exist and contain rows before any prerequisite in this section can be
evaluated at all.** Until the owner approves that table, Module 036's
correct state for every athlete and every org is fully locked with zero
progress to show — not "0 of N," because N cannot be counted against a
table that does not exist.

The counts below assume that table exists, is named (illustratively)
`pilot.periodization_blocks` with at least `organization_id`, `block_id`,
`athlete_id`, `title`, `training_emphasis`, `starts_on`, `ends_on`,
`target_competition_id` (nullable), `target_event_id` (nullable),
`created_by_account_id`, following the FK/tenancy pattern every other
table in this schema uses — and that its comparison surface reads
existing tables' real columns only, per (a). None of this is a proposal to
finalize that shape; it is the minimum needed to make the thresholds below
concrete and checkable.

### Per athlete (unlocks that athlete's own plan-vs-actual view)

| # | Requirement | Real source |
|---|---|---|
| 1 | ≥ 1 `periodization_blocks` row for the athlete with both `starts_on` and `ends_on` set and `ends_on >= starts_on` | `periodization_blocks.starts_on`, `.ends_on` |
| 2 | The block's date window has fully elapsed (`ends_on < current_date`) — a plan cannot be compared to actuals it has not yet had the chance to accumulate | `periodization_blocks.ends_on` |
| 3 | ≥ 1 `pilot.training_attempts` row OR ≥ 1 `pilot.activity_log` row for the athlete with a date falling inside `[starts_on, ends_on]` — some real recorded event to compare against, or there is nothing to show but the plan itself | `training_attempts.attempted_at`, `activity_log.occurred_on` |
| 4 | A human-recorded adherence judgment exists for the block (the coach equivalent of `intervention_executions.adherence`, not the platform's inference) — until this is recorded, the block shows real counts only, no adherence state beyond `unknown` | new column on `periodization_blocks`'s execution/comparison row, human-authored only |

Requirement 2 is the one most orgs will underestimate: a block's
plan-vs-actual view has nothing honest to show until its own window has
closed. A coach who plans a 6-week block on day one has planned a block,
not yet lived one — showing "adherence" mid-block against a still-unfolding
window would encourage exactly the metric-gaming this platform's honesty
doctrine forbids (a coach adjusting behavior to make a live number look
good, rather than the plan simply running and being judged afterward).

### Per organization (unlocks org-level aggregate view)

| # | Requirement | Real source |
|---|---|---|
| 1 | The plan-recording table from Layer 0 is approved and deployed for the org at all — an org with zero plans has nothing to aggregate | `periodization_blocks` existence |
| 2 | ≥ 5 distinct `athlete_id` values in the org each independently satisfy the full per-athlete gate above (deliberately a minimum-N of athletes, not of blocks, so one heavily-planned athlete cannot unlock an org view built on N=1 — see Module 017's proposal for the same reasoning, applied here identically) | `periodization_blocks.athlete_id` grouped by `organization_id`, joined against each athlete's own gate |
| 3 | Of the qualifying blocks in (2), more than one distinct `training_emphasis` string is represented — otherwise an "org periodization view" would just be restating one coach's single template as if it were organizational practice | `periodization_blocks.training_emphasis` |

---

## (c) Locked state

Before Layer 0 exists at all, the module shows nothing but its own
inactive status — there is no partial progress to report against a
prerequisite the schema does not yet have a table for:

> Periodization / Block Planning — not yet available.
> This module requires a coach-authored training-plan record that does not
> exist in the platform yet. No progress to show.

Once Layer 0 exists and a coach has started recording blocks, locked state
for a given athlete shows the same honest, real-count style as every other
module's locked state — no gamified "almost there" framing aimed at a
minor:

> Periodization / Block Planning — locked for this athlete.
> Blocks recorded: 1 ("Fall strength block," Sep 2 – Oct 14, ends in 12
> days). Comparison view unlocks once this block's window has closed and
> at least one training attempt or activity-log entry has been recorded
> inside it. There is nothing to do differently to "unlock" it faster, and
> no reward for reaching it sooner.

At org level, locked state shows the same kind of factual counts as
Module 017's proposal establishes: how many athletes have at least one
completed, comparable block on record, never which athletes and never a
ranked list of "most compliant" coaches or athletes.

---

## (d) What unlocks

**At athlete level** (visible only to the athlete, their guardian, and
staff with existing access to that athlete's record — never to any other
athlete or guardian, and never aggregated into a cohort comparison):
- The coach's own plan text and dates, exactly as authored.
- The real counts from `training_attempts`/`activity_log`/`assessments`/
  `intervention_executions` falling inside the block's window, per (a).
- The human-recorded adherence state for the block, once a coach has
  entered one — never a platform-computed percentage standing in for it.
- **Anything shown to the athlete or guardian must pass the same
  human-review gate `intervention_outcome_reviews` already enforces
  structurally** (`reviewed_by_account_id` required; the schema computes
  no verdict on its own) — a block's adherence judgment and any narrative
  summary of "how the block went" must be authored or explicitly confirmed
  by a coach before an athlete/guardian sees it, not generated and shown
  automatically the moment the window closes.
- No comparison to any other athlete's block, no cohort average adherence
  rate, no leaderboard of "most on-plan athlete." Permanently out of
  scope, not a later tier.

**At org level** (visible only to roles already permitted org-wide views —
`organization_admin`/`admin`/`coach`, per the `role` vocabulary in
`pilot.organization_memberships`):
- Aggregate counts only, suppressed below the owner-decided minimum-N
  (Open Question 3): e.g., "X of Y active athletes have at least one
  completed, comparable training block on record," "Z distinct block
  emphases in use across the org" — never a per-athlete breakdown inside
  the aggregate and never a per-coach "compliance" ranking.
- Which competition/event dates (from `external_competitions` /
  `wrestling_league_events`) currently have at least one linked block
  targeting them, as a fact about scheduling, not a readiness claim.
- An org's aggregate unlocking is never itself a basis for pushing
  individual athletes or coaches to "catch up." This module has no
  target-setting, nudge, or notification surface, and this proposal does
  not create one.

---

## (e) Open questions for the owner

**1. [ANSWERED — (a), built.]** The foundation slice built option (a) as
`pilot.athlete_development_blocks`, on the owner's direct instruction. The
question as originally put:

**Should the plan-recording table this module needs be built as its
own new table (e.g. `periodization_blocks`), or does periodization belong
inside an extension of the existing `intervention_protocols` /
`intervention_executions` ledger instead of a parallel table?**
- (a) New, purpose-built table reusing the ledger's vocabulary
  (planned snapshot / actual / adherence / human-only review) but scoped
  to a training block rather than a single hypothesis — keeps the
  hypothesis-testing ledger's meaning intact and gives a block its own
  natural shape (date range, target event link).
- (b) Extend `intervention_protocols`/`intervention_executions` directly
  with an optional "this is a periodization block" flag and a date range —
  avoids a new table but risks conflating "we tested a coaching hypothesis"
  with "we planned a training calendar," which are different claims with
  different audiences.
- (c) Do not build a dedicated periodization table at all; treat
  `session_scripts.phase` (already free text) as sufficient and build only
  a reporting view across sessions sharing a phase string — cheapest, but
  inherits that field's lack of date range or cross-session linkage and
  would likely undercount or misgroup blocks.

**2. [ANSWERED — (a), built.]** The owner directed the competition
connection, and it shipped as
`pilot_slice_postgres_athlete_development_block_competition_target_migration.sql`:
two nullable columns, `target_competition_id` and `target_wrestling_event_id`,
each with a composite foreign key into its own surface, plus a check that a
block names at most one. Two columns rather than the "one migration wide"
single column the foundation anticipated, because the option names targets in
two different tables and one polymorphic id column could not carry a real
foreign key — and the composite-FK tenancy proof is worth more than the
column count.

Every bound the option set is held: a target is a name and a date, both
competition tables are untouched and remain exactly as skeletal as the prior
owner decision left them, and nothing derives a taper, a peak, a volume curve,
a countdown or a weight plan from the link. `sanctioning_body` is shown only
where it is stored, which means never for a wrestling league event, whose
table has no such column.

Two things the option did not specify and this build decided, recorded here so
they are visible rather than inferred: `ON DELETE` is the default (no action)
rather than cascade or set null — cascade would delete a coach's whole plan
because somebody removed a fixture, set null would silently erase what it was
aiming at — and a block stays pointed at an event whose status becomes
`cancelled`, because the coach WAS preparing for it and a dropped link is
indistinguishable from a target never chosen.

The question as put:

**Should a block be allowed to target a competition/event at all,
given both competition surfaces are deliberately skeletal by prior owner
decision?**
- (a) Yes — allow an optional FK to `external_competitions.competition_id`
  or `wrestling_league_events.event_id` as a target date only (name and
  date, nothing else), leaving both competition tables exactly as
  skeletal as they are today.
- (b) Yes, but only once a real league/competition program exists with
  more than a placeholder date — defer the FK until the competition
  modules themselves are promoted past skeleton status.
- (c) No — keep blocks entirely date-range-based with no competition
  linkage, so periodization never implicitly depends on the competition
  modules' future shape.

**3. What minimum-N suppression floor applies to org-level aggregate
views, to avoid re-identifying individual minors or individual coaches in
a small gym (the same question Module 017's proposal raises, asked again
here because this module additionally risks identifying a specific
*coach's* plans by comparing few blocks with distinct `training_emphasis`
text)?**
- (a) Fixed floor (e.g., 5 athletes and/or 3 distinct coaches
  represented) below which no org-level aggregate is shown at all.
- (b) No fixed floor, but aggregates are always counts/ratios and
  `training_emphasis` text is never shown verbatim at org level, only
  counted as "N distinct emphases in use."
- (c) Defer org-level aggregation entirely until legal/safeguarding
  review of minor-data and staff-performance aggregation is complete;
  ship athlete-level-only for now.

**4. Should a coach be allowed to mark a block's phase using free-text
vocabulary (mirroring `session_scripts.phase`'s "accumulation, sharpening,
taper, etc." pattern), or should the platform offer a fixed picklist of
phase names?**
- (a) Free text only, consistent with `session_scripts.phase` and with
  the honesty doctrine that periodization vocabulary is coaching doctrine
  the platform does not own — never auto-complete or suggest phase names
  the platform has not been told to.
- (b) A coach-editable, org-scoped picklist (each org defines its own
  phase names once, then reuses them) — reduces free-text drift across a
  coaching staff while still not baking in a platform-wide doctrine.
- (c) A fixed platform-wide picklist of standard periodization phase
  names — explicitly rejected by the assignment brief's framing
  ("block structures... are NOT derivable from this platform's data and
  must not be invented"), included here only so the owner can see it named
  and declined, not silently omitted.

**5. [ANSWERED — (a), 2026-08-28.] Which staff roles may create and modify an
athlete development block?**

**Jason: _"Admin and coaches."_** Enforced as
`DEVELOPMENT_BLOCK_WRITE_ROLES = ['coach', 'organization_admin', 'admin']` in
`athleteDevelopmentBlocks.ts`, imported by the objectives module so one
decision lives in one place. `platform_owner` is deliberately absent, matching
`COMPETITION_WRITE_ROLES` and `LEAGUE_WRITE_ROLES`. `athlete`, `parent` and
`volunteer` are not write roles here — a development block is a coach's plan
*for* an athlete, and `pilot.goals` is where an athlete's own goals live.

This closed a real gap rather than only unblocking the future API. The floor
these modules shipped with accepted an ACTIVE membership of **any** role, and
`pilot.organization_memberships.role` admits `athlete`, `parent` and
`volunteer`. Nothing could reach it — there are still no routes — but a data
layer that would let an athlete file their own development block is not a
floor worth shipping. The question as it was put:

The foundation slice does not answer this and does not need to: it ships no
API route and no UI, so no role gate had to be invented to land the schema.
What it does enforce is the floor every write path in this codebase already
stands on — the creator must hold an ACTIVE `pilot.organization_memberships`
row in the block's organization, checked against the membership table rather
than `pilot.accounts.organization_id`, so a coach whose home gym is elsewhere
but who holds an active membership here is correctly allowed and a
deactivated one is correctly refused.

That floor is not a permission model. `pilot.organization_memberships.role`
admits `platform_owner`, `organization_admin`, `admin`, `coach`, `athlete`,
`parent`, `volunteer`, `staff`, and this document should not decide which of
them may author a coach's training plan.
- (a) `coach`, `organization_admin` and `admin`, matching the write posture
  of the nearest analogous coach-authored records.
- (b) `coach` only — a development block is a coaching artifact, and an
  administrator who needs one asks a coach.
- (c) Something narrower still, e.g. only the athlete's assigned coach
  (`pilot.athletes.coach_id`) plus organization admins.

Whichever is chosen, `athlete`, `parent` and `volunteer` are not write roles
here, and read access for an athlete or their guardian is a separate
safeguarding question this slice does not open. **That read question is still
open** — the decision above governs writing only.

**6. [ANSWERED — (a), 2026-08-28.] May a coach file a nutrition /
body-composition objective for a named minor?**

**Jason, verbatim: _"admit nutrition_body_composition — module 200 is done."_**
The domain is admitted; the vocabulary is now all ten. What that decision
covers, and what it does not, is recorded at the end of this question. The
question as it was put:

Slice 2 ships nine of the ten Full Spectrum domains.
`nutrition_body_composition` is withheld, and the reasoning is not this
slice's — it is quoted from
`pilot_slice_postgres_goal_category_progress_migration.sql`, which withheld
`Weight Loss` and `Weight Gain` from `pilot.goals.category` because admitting
them *"would create a stored, queryable record of a minor's weight-loss
intent … ahead of the tier system whose entire job is to decide who may see
exactly that,"* and because *"it would be strange for the doctrine layer to
refuse the conversation while the goals table quietly filed the goal."*
`shadowAuthority.ts` still refuses `weight_cut` in conversation today.

The same sentence holds with *coach* in place of *athlete*: a block objective
reading "cut to 132 by the October show" is a stored, queryable
body-composition target for a named minor.

**What has changed, and why this is now a live decision rather than a
block:** the gate that migration was waiting on exists. Module 200, the
Privacy-Tier System, reads Status **DONE**, `privacyTiers.ts` ships
`FIELD_TIERS`, and that module's own header names *"a body-composition
tracker"* as an anticipated consumer. But module 200 also reads Active
**false** / ManualVerification **PENDING_SIGN_OFF**, and `FIELD_TIERS`' entry
for `goals.category` says the reversal *"waits on an explicit owner decision,
which this registry makes possible and deliberately does not make."*

- (a) Admit `nutrition_body_composition` now, on the grounds that objectives
  are coach-authored, staff-only, and have no athlete or guardian read path.
- (b) Admit it once module 200 is signed off (Active true), and decide the
  goals-category reversal at the same time so the two surfaces do not
  disagree about the same subject.
- (c) Keep it withheld until a body-composition surface is designed with its
  own tier assignment, on the grounds that a free-text objective field is the
  wrong shape for this subject regardless of who can read it.

Reversing it was one line in the migration's `DO` block and one entry in
`FULL_SPECTRUM_DOMAINS` — which is what it cost when the owner reversed it
hours later. The migration's domain constraint reconciles rather than guards,
so the change lands correctly on already-migrated environments; the deploy
gate deliberately did **not** encode the withheld value, so the reversal
needed no runner edit and blocked no release. Both choices were made against
exactly this event and both paid.

**What the decision covers, and what it does not.** Three boundaries, written
down because "we decided body composition is fine" is the kind of summary
that travels further than the decision did, and each is asserted by a test:

1. **`pilot.goals.category` is unchanged.** `Weight Loss` and `Weight Gain`
   remain withheld there. That is a different surface — athlete-filed and
   athlete-readable — and it was not what was decided.
   `athleteDevelopmentBlockObjectives.pg.test.ts` asserts the goals
   constraint still refuses both. **Worth deciding on its own** so the two
   surfaces do not disagree about the same subject; it is not decided here.
2. **`shadowAuthority.ts` still refuses `weight_cut` in conversation.** A
   coach may record their own plan; the model still gives no weight-cutting
   guidance.
3. **A domain label is all that was admitted.** No weight field, no target,
   no target date, no computation — and the free-form weight vocabulary
   (`weight_cut`, `weight_loss`, `weight_gain`, `body_composition`,
   `nutrition`) was never a domain and still is not, refused by the database
   and by the module.

**One thing was owed, and has since been paid.** The decision cited module
200, so the field was registered in `FIELD_TIERS` at the tier actually
enforced that morning — `organization` — with the narrowing to
`athlete_record` recorded as the work item, to be done *in the slice that
builds the first read surface, before that surface ships*.

Open Question 7, answered the same day, did it: every read in both modules
now resolves through `assertActorCanAccessAthlete`, and the `FIELD_TIERS`
entries for `athlete_development_block_objectives.objective` and
`athlete_development_blocks.training_emphasis` both read `athlete_record`
with a real `enforcedBy`. The order held — the narrowing landed before any
route existed, not after. The gap is closed; the registry entry now records
what the code holds.

**7. [ANSWERED — 2026-08-28.] Who may READ an athlete development block and
its objectives?**

Open Question 5 governed writing only, and said so: *"read access for an
athlete or their guardian is a separate safeguarding question this slice does
not open."* Admitting `nutrition_body_composition` (Question 6) is what made
it urgent — an objective can now hold a body-composition sentence naming a
minor, and org-wide staff reads were broader than that minor's own date of
birth already is.

**Jason: _"it should be Admin, Coach, Athlete, Guardian."_**

Implemented by **reusing `assertActorCanAccessAthlete`**, not by writing a
role list. That function is the platform's chokepoint — 92 non-test files
call it — and it already implements exactly those four, each with the
per-subject relationship that makes the role meaningful:

| Role | Reaches | Through |
| --- | --- | --- |
| `organization_admin` / `admin` | every live athlete in their gym | `assertAthleteBelongsToOrganization` |
| `coach` | their own athletes, plus anyone under a live coverage grant | `pilot.athletes.coach_id`, then `pilot.coach_coverage` |
| `athlete` | themselves only | `ActorIdentity.athleteId` |
| `parent` | their linked children | `pilot.guardian_links` → `pilot.parents`, org-scoped on both |
| `platform_owner`, `board` | nothing here | refused unconditionally |

Every read function in both modules — and, since the #767 merge,
`updateDevelopmentBlock` too — now takes an `ActorIdentity` instead of an
`organizationId` string. Organization scoping did not go away — it is
still in the `where` clause of every statement, and the composite FK still
makes a cross-gym row unrepresentable — the athlete check sits on top of it.
The list reads use `accessibleAthleteIds`, the batched counterpart, so a
listing is the union of what the caller could have asked for one at a time
rather than a gym-wide read wearing a filter.

**Three consequences, none of them separately decided, all reversible:**

1. **Authoring now requires reaching the athlete.** A coach with an active
   membership can no longer file a block for an athlete they are neither
   assigned to nor covering. This is not an extra rule bolted onto the
   write — it is what keeps the write coherent, because
   `createDevelopmentBlock` returns `getDevelopmentBlock`'s result, and an
   author who could not read would have written a row and been handed `null`
   for it. Reversing it is one line (`canActorReachAthlete` back to
   `assertAthleteBelongsToOrganization`) if the owner wants any gym coach to
   be able to author for any athlete.
2. **Moving or correcting a block or an objective is authoring it.** The
   status setters were organization-scoped and ungated, which was survivable
   only because nothing could call them; `updateDevelopmentBlock`, which
   arrived from #767 in the same state, was survivable only because its one
   caller was a staff-only route. Now that an athlete and a guardian can read their
   own blocks, an ungated status mutator would let an athlete mark their own
   block `completed` — precisely the coach judgment this table refuses to
   compute. Both setters carry the Question 5 gate.
3. **Reading is not writing.** An athlete and a guardian read; neither may
   author, re-state, or move anything. Asserted in both suites with the read
   proven on the line above the refusal, so a failure cannot be misread as
   "they never had access".

**8. [OPEN — raised 2026-08-28, not decided.] Does a withdrawn athlete keep
reading their own record?**

Found while proving Question 7, and it belongs to `access.ts` rather than to
this module. Three of `assertActorCanAccessAthlete`'s four arms ask the
database and therefore inherit the `deleted_at is null` filter added by #706:
delete an athlete and the org admin, the assigned coach and the linked
guardian all stop reaching them. **The athlete arm never asks the database**
— it compares `ActorIdentity.athleteId` to the requested id in memory and
returns — so a withdrawn athlete keeps reading their own record, everywhere
in the platform. `softDeletedAthleteAccess.pg.test.ts` covers the admin,
coach and guardian arms and not this one, which is why nothing had noticed.

Not fixed in this slice, deliberately. It is a one-predicate change to the
chokepoint every athlete-facing surface calls, which does not belong inside a
PR about development blocks, and the answer is a policy question with a real
argument on each side: retention says a withdrawn record should go dark;
data portability says a person does not lose sight of their own record
because a gym marked them withdrawn. Both block suites assert the behavior as
it actually is — the three arms refuse, the self arm still reaches — so the
gap is stated rather than implied, and whichever way it is decided, the test
that changes will name the decision.

- (a) Add `deleted_at is null` to the athlete arm: a withdrawn athlete reads
  nothing, consistent with every other arm.
- (b) Leave it: a withdrawn athlete keeps reading their own record, and the
  exemption is documented at the chokepoint rather than left as an accident.
- (c) Something in between — e.g. read-only self access for a bounded
  retention window — which is more machinery than either of the above and
  should be justified before it is built.
