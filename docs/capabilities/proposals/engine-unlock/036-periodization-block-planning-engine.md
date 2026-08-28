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
thin organization-scoped data layer
(`apps/web/src/server/pilot/athleteDevelopmentBlockObjectives.ts`) adds,
reads and re-states an objective under the same active-membership floor.

**The domain vocabulary ships nine of ten, and the tenth is an owner
decision — see Open Question 6 below.** `nutrition_body_composition` is
withheld, for the reason
`pilot_slice_postgres_goal_category_progress_migration.sql` already gave when
it withheld `Weight Loss` / `Weight Gain` from the athlete goal categories.

**The illustrative name in this document is not the shipped name.** Section
(b) below writes `pilot.periodization_blocks`; the table is
`pilot.athlete_development_blocks`, which is the owner's own vocabulary for
the capability and avoids implying the platform models periodization science.
Read every `periodization_blocks` reference below as naming this table.

**NOT built, and not decided:**

- Every comparison / plan-vs-actual surface in sections (a)–(d). Nothing
  reads a block yet. No block carries an adherence state, because the
  execution/comparison row that would hold one does not exist.
- Any surface that reads an objective. The rows exist; nothing displays,
  summarizes or rolls them up, and no count of completed objectives is
  presented as a judgment about an athlete.
- Any API route or UI. Which staff roles may author a block is an **open
  owner decision** — see Open Question 5, added below.
- The optional competition/event target (Open Question 2), still open and
  still unbuilt.

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

**2. [STILL OPEN — nothing built.]** The foundation slice ships NO
competition or event foreign key, deliberately: both competition surfaces are
skeletal by prior owner decision, and choosing among (a)/(b)/(c) is the
owner's. Nothing is foreclosed — under (a) this is a later additive nullable
column with a composite FK, one migration wide. The question as put:

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

**5. [NEW, raised by the foundation slice.] Which staff roles may create and
modify an athlete development block?**

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
safeguarding question this slice does not open.

**6. [NEW, raised by slice 2.] May a coach file a nutrition / body-composition
objective for a named minor?**

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

Reversing it is one line in the migration's `DO` block and one entry in
`FULL_SPECTRUM_DOMAINS`. The migration's domain constraint deliberately
reconciles rather than guards, so the change lands correctly on
already-migrated environments; the deploy gate deliberately does **not**
encode the withheld value, so reversing it cannot block a release.
