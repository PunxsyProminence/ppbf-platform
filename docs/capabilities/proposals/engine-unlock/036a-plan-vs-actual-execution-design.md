# Module 036a — Plan-vs-actual: the execution row, designed

**Status: DESIGN ONLY. Nothing here is built.** This document exists so the
slice that builds it can be built correctly, and so the decisions it needs can
be made before code rather than discovered during it — the order this module
has kept through #759, #762, #789 and #794.

Design baseline is `036-periodization-block-planning-engine.md`, whose sections
(a)–(d) already specify this surface well. This document does three things that
proposal cannot:

1. **checks its named sources against the schema `main` actually carries
   today**, rather than the one that existed when it was written — and finds
   two drifts;
2. **separates what must be stored from what must be computed at read time**,
   which is the decision that determines whether this surface can go stale;
3. **enumerates the owner decisions**, with options and consequences, including
   one that follows directly from the read decision of 2026-08-28 and is
   sharper than anything decided so far.

---

## 1. What already exists, verified against `main`

Every source module 036 names was checked against the current schema rather
than assumed. All five exist.

| Table | Columns this surface needs | Written by live surfaces? |
|---|---|---|
| `pilot.training_attempts` | `attempted_at`, `metric_kind`, `made`, `target_value`, `achieved_value`, `context_type` | yes — 4 insert sites |
| `pilot.activity_log` | `occurred_on`, `duration_minutes`, `activity_domain`, `attendance_status`, `capture_method` | yes — 8 insert sites |
| `pilot.assessments` | `administered_on`, `assessment_type`, `protocol_id` | yes |
| `pilot.intervention_executions` | `actual_start`, `actual_end`, `adherence`, `deviations`, `deviation_reason` | yes |
| `pilot.intervention_evidence_links` | `evidence_role`, `source_kind`, `source_id`, `status` | yes |

**The adherence vocabulary is real and is not to be re-invented.**
`intervention_executions.adherence` is `text not null default 'unknown'` with

```
check (adherence in ('delivered_as_planned', 'delivered_with_deviations',
                     'under_delivered', 'not_delivered', 'unknown'))
```

and it ships with `deviations text not null default ''` and
`deviation_reason text not null default ''` beside it. Module 036 says to reuse
this rather than invent a parallel vocabulary; that instruction is correct and
the constraint above is what to copy.

**The evidence-link pattern is real too.**
`intervention_evidence_links.source_kind` is already
`('training_attempt', 'readiness', 'assessment', 'film_study', 'activity_log')`
— exactly the source set this surface needs — with `evidence_role` in
`('baseline', 'during_intervention', 'immediate_post', 'retention', 'transfer',
'counterevidence', 'adverse_response', 'context')`.

### Drift 1 — `assessments.administered_on` is NULLABLE

Module 036 says to count "assessments administered (`administered_on` within
window)". The column exists, but it is added by
`pilot_slice_postgres_assessment_protocols_migration.sql` as
`date null`, and the same migration indexes rows **where it is null** as the
not-yet-administered case:

```sql
alter table pilot.assessments add column if not exists administered_on date null;
create index ... on pilot.assessments(organization_id, due_on) where administered_on is null;
```

So an assessment can exist, belong to the athlete, and have no date to place it
in a window with. That is a third state the proposal does not name, and it
must not be collapsed into either "none in this window" or "counted". See
§4 UNKNOWN states.

### Drift 2 — the proposal predates objectives

Module 036 was written when a block held one free-text emphasis. Since #762 a
block also has **objectives, one row per Full Spectrum domain**, each with its
own lifecycle status. The proposal's "an explicit adherence state for the block
as a whole" was specified without those existing. Whether the judgment stays at
block level or moves to the objective is now a real question — **Decision D1**.

---

## 2. The shape: what is stored, and what is never stored

This is the decision that determines whether the surface can lie.

**Stored: the human judgment only.** A coach's adherence state, their
deviations and reason in their own words, who recorded it and when. That is a
fact about what a person concluded, and facts about the past are stored.

**Computed at read time, never stored: every count.** How many
`training_attempts` fell in the window, how many `activity_log` minutes by
domain, which assessments were administered. These are derived from rows that
keep changing — a late-logged session, a corrected attempt, a retracted
assessment — and a stored count silently stops matching its own sources the
moment one of them moves. A count that disagrees with the rows beneath it on a
record about a child is worse than no count.

This mirrors what the platform already does: `intervention_executions` stores
the human's `adherence` and links evidence, and never stores a tally.

**Consequence to accept deliberately:** the counts cost a query per view. That
is the right trade. The alternative is a materialised number that goes stale
and nobody notices until a coach acts on it.

---

## 3. The proposed table

```sql
create table if not exists pilot.athlete_development_block_executions (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  execution_id          text not null,
  block_id              text not null,
  adherence             text not null default 'unknown',
  deviations            text not null default '',
  deviation_reason      text not null default '',
  recorded_by_account_id text not null references pilot.accounts(account_id),
  recorded_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, execution_id),
  constraint pilot_adb_executions_block_fk
    foreign key (organization_id, block_id)
    references pilot.athlete_development_blocks(organization_id, block_id) on delete cascade,
  constraint pilot_adb_executions_adherence_check
    check (adherence in ('delivered_as_planned', 'delivered_with_deviations',
                         'under_delivered', 'not_delivered', 'unknown'))
);
```

Notes on the shape, each deliberate:

- **No `athlete_id`.** It reaches the athlete through the block by composite
  FK, exactly as objectives do. One place the answer lives.
- **No count columns of any kind.** Per §2. If a later change adds
  `attempt_count` or `minutes_total` here, that is the defect this document
  exists to prevent.
- **`adherence` defaults to `unknown`**, matching `intervention_executions`.
  A block with no judgment recorded is honestly unknown, never inferred from
  the counts sitting next to it.
- **`deviations` and `deviation_reason` default to empty**, not null — same as
  the table this copies, so "the coach wrote nothing" and "the coach wrote an
  empty string" are not two states.
- **One row per block**, not per revision — unless D1 moves it to objectives.
  A `unique (organization_id, block_id)` index belongs here if the judgment is
  one-per-block; it is omitted above because D1 decides that.

**Evidence links** should reuse `intervention_evidence_links`' shape rather
than get a parallel table, if D4 says a coach may point at specific rows. That
is a follow-on slice, not this one.

---

## 4. UNKNOWN states — the ones that must stay distinguishable

Module 036 names four. Two more come from the schema check above. All six must
be separate on screen; collapsing any pair is how this surface would start
lying.

| State | Shown as | Why it is not the neighbouring state |
|---|---|---|
| No block for the period | "No development block recorded for this period" | `training_attempts` may still have rows; a blank chart would imply no training happened |
| Block exists, no judgment yet | `unknown` | Never inferred from counts — that inference is the whole thing this refuses |
| Window has zero source rows | "No recorded training activity in this window" | Distinct from `not_delivered`. **The schema cannot tell "the athlete did not attend" from "attendance was not logged"** — neither writes a row |
| Target event cancelled | visible flag | A cancelled competition must never read as still live |
| **Assessment with `administered_on` null** | counted as "administered date not recorded", separately | It is neither "none in this window" nor evidence the window contains — Drift 1 |
| **Block window still open** | "window has not closed" | An adherence judgment on a block that is still running is a prediction, not a record |

That last row is worth stating plainly: module 036's own prerequisite 3 says a
block's plan-vs-actual view "has nothing honest to show until its own window
has closed." The surface should say so rather than showing partial counts that
read as a verdict-in-progress.

---

## 5. Decisions needed before this can be built

> ## ANSWERED — owner, 2026-08-28. The forks below are left standing as the
> reasoning that produced the answers; where they disagree with this block,
> this block is current.
>
> **THE TABLE THAT SHIPS IS `pilot.athlete_development_block_reviews` (#804),
> not the `..._executions` proposed in §3 of this document.** #829 built §3 as
> written; comparing the two showed `executions` to be a strict column subset
> of `reviews`, so the only real difference was cardinality — and the owner
> chose many-appended over one-upserted. #829's table does not ship.
>
> - **D1 → the block, but MANY ENTRIES, not one.** This SUPERSEDES the earlier
>   D1(a) answer of the same day. That answer was chosen from the three options
>   below, and "append-only, many per block" was not among them — the option
>   set was incomplete, not the decision wrong. Nothing a coach wrote is ever
>   overwritten; a correction is a new entry, and the earlier judgment about a
>   child survives it.
> - **D2 → (a) `DEVELOPMENT_BLOCK_WRITE_ROLES`** — coach, organization_admin,
>   admin. The same list that authors the block.
> - **D3 → (a) the family reads the verdict verbatim, deviation text
>   included.** The reasoning that gave them the plan verbatim applies
>   unchanged: a judgment about a child that the child cannot see is one they
>   cannot question.
> - **D4 → (a) no evidence links in the first slice.**
> - **D5 → stands as written**, and is now a test rather than a promise.
>
> ### Two answers this document did not ask for, and one correction to §4
>
> **MID-BLOCK ENTRIES ARE ALLOWED.** §4's last row says an adherence judgment
> on an open window is "a prediction, not a record" and #829 turned that into a
> write refusal. **The refusal is reversed.** A coach who sees a problem in
> week 3 must have somewhere to put it, because a review delivered only at the
> end arrives too late to change anything for that athlete. §4's DISPLAY rule
> survives intact: a surface must still say the window has not closed, so a
> mid-block entry can never be mistaken for the final word.
>
> **COUNTS SHOW BOTH TRAINING DAYS AND MINUTES BY DOMAIN, side by side, each
> labelled for what it is.** Neither existing read does both:
> `pilot.attendance_reconciled` is the athlete-day system of record and cannot
> be inflated by an athlete training twice in a day, but exposes no duration
> and no domain; the raw `activity_log` boxing rows carry duration and domain
> but must not be counted as days. Both are wanted, and the day count is the
> participation figure — the minutes are detail beside it, never a second
> participation number.

Each is a real fork. None can be settled from the code.

### D1 — Does the adherence judgment sit on the block, or on each objective?

Module 036 says block. It was written before objectives existed.

- **(a) Block only.** One judgment per block. *Good:* one row, one decision, matches the proposal and the `intervention_executions` shape it copies. *Bad:* a block that went well technically and badly on conditioning gets one word for both, and the objectives — which are the specific thing the coach said they were moving — carry no outcome at all.
- **(b) Objective only.** One judgment per objective. *Good:* the verdict lands where the intent was stated, per domain. *Bad:* five objectives means five judgments per block, which is the kind of friction that gets skipped, and skipped judgments default to `unknown` — so the honest-default design turns into an empty screen.
- **(c) Both.** Block-level judgment, optionally refined per objective. *Good:* a coach can say one thing quickly and more when it matters. *Bad:* two places a judgment can live, which invites the roll-up this module refuses — "three objectives delivered, block says under-delivered" is a discrepancy someone will want resolved by arithmetic.

### D2 — Who may record it?

- **(a) `DEVELOPMENT_BLOCK_WRITE_ROLES`** — coach, organization_admin, admin. The same list that authors the block. *Good:* one decision already made, enforced in one place, nothing new to reason about. *Bad:* none identified; this is the default unless there is a reason.
- **(b) The block's author only.** *Good:* the person who stated the intent judges the outcome. *Bad:* a coach who leaves the gym freezes every block they wrote, and coverage exists precisely because coaches are sometimes not available.

### D3 — Does the family see the coach's verdict? **(the sharp one)**

The read decision of 2026-08-28 gives an athlete and their guardian the plan
**verbatim**. This asks whether that extends to the coach's judgment of how it
went — including `under_delivered` and a free-text deviation reason.

- **(a) Yes, verbatim, like everything else.** *Good:* consistent with the decision already made, and its reasoning applies unchanged — a judgment about a child that the child cannot see is one they cannot question. *Bad:* "under_delivered" is a harder word to read about yourself than a training emphasis is, and `deviation_reason` is where a coach would honestly write "athlete stopped showing up", which is a different kind of sentence from "work the jab".
- **(b) The judgment yes, the deviation text no.** *Good:* the family learns the outcome without the coach's private phrasing about the cause. *Bad:* the enumerated word without the reason is the least useful and most alarming half — "under_delivered" with no explanation invites the worst reading.
- **(c) Staff only, for now.** *Good:* defers a decision that can be made once there is real text to look at. *Bad:* it is a quiet narrowing of a decision already made in the other direction, and the asymmetry — you may read the plan but not whether it happened — is hard to defend to a parent who notices.

### D4 — May a coach link specific rows as evidence for their judgment?

- **(a) Not in the first slice.** *Good:* smallest correct thing; the counts are already shown beside the judgment. *Bad:* "which sessions were you thinking of" has no answer.
- **(b) Yes, reusing `intervention_evidence_links`' shape.** *Good:* the pattern exists and its `source_kind` vocabulary already covers exactly these sources. *Bad:* meaningfully more surface for a first slice, and it needs its own UI.

### D5 — Confirm the refusal, on the record

Not a fork so much as a thing to say once, explicitly, so a later slice cannot
drift into it: **no count shown on this surface may be combined into a single
figure, percentage, grade or index, and no cross-athlete comparison, cohort
average or "on plan" leaderboard may exist at any tier.** Module 036 already
says this; restating it here is cheap, and the tests for the built slice should
assert it the way #789's and #794's already do.

---

## 6. The smallest correct first slice, once decided

Assuming D1(a), D2(a), D3 to be answered, D4(a):

1. Migration for the table in §3, with the reconciling `DO` block pattern for
   the adherence CHECK so vocabulary can grow on migrated environments.
2. Runner + registration (4 coupled points), and a readiness assertion that
   can both pass and fail, naming no policy value in either direction.
3. Data module: record/read the judgment, gated by the same
   `hasBlockWriteMembership` the other three mutators use.
4. Read-time comparison query: counts by source, window-scoped, never stored.
5. pg suite proving the six UNKNOWN states stay distinguishable, and that no
   count is persisted.
6. Coach surface. Family surface only if D3 says so, and in the same
   `DevelopmentBlockPlanView` if it does.

**Not in the first slice under any answer:** evidence links, per-objective
judgments if D1(a) wins, any aggregate across blocks, any notification.

---

## 7. What this document does not do

It does not build anything, does not create a migration, and does not decide
D1–D4. It also does not revisit **Open Question 8** (`036`), which is still
open and still `access.ts`'s question rather than this module's: a withdrawn
athlete keeps reading their own record, because the athlete arm of
`assertActorCanAccessAthlete` compares ids in memory and never asks the
database. That is unrelated to this surface and is not resolved by it.
