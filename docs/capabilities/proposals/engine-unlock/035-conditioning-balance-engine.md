# Engine Unlock Proposal — Module 035: Conditioning Balance Engine

| Field | Value |
|-------|-------|
| Status | PROPOSAL (owner approval requested) — no code changes made |
| Module stub | `docs/capabilities/modules/035-conditioning-balance-engine.md` |
| Category | Physical Training System (`physicalTrainingSystem`) |
| Prepared against | current `infra/azure/*.sql` schema, read-only |
| Prepared | 2026-08-16 |

This document proposes the honesty gate that must be satisfied before Module 035
is allowed to compute or display anything to a user. It does not propose an
implementation, a UI, or an API. Nothing here is authorization to build; it is
the basis for an owner decision on what the module may and may not do.

---

## Schema reality check (read first)

"Conditioning **balance**" implies two things that do not yet exist anywhere in
`infra/azure/*.sql`:

1. **A taxonomy of conditioning types.** "Balance" only means something between
   two or more named categories (e.g. aerobic base vs. anaerobic capacity, or
   strength vs. work-capacity). A repo-wide search for energy-system or
   conditioning-type vocabulary found `'conditioning'` used only as **one flat
   label**, never subdivided, in five places: `pilot.drill_library.discipline`
   (`'boxing','wrestling','combatives','conditioning','general'`),
   `pilot.athlete_competence.domain` (one of ten domains, alongside
   `stance_base`, `footwork`, `ring_craft`, etc.), `pilot.training_holds.scope`
   (`'conditioning_only'` as a restriction scope, not a usage measure),
   session-script segment typing (`'conditioning'` as one phase of a planned
   lesson), and a matching check in the competence-cohorts migration. **None
   of these distinguish one kind of conditioning work from another.** There is
   no `energy_system`, no `conditioning_type`, no aerobic/anaerobic/alactic
   column, anywhere.
2. **A reliable link from recorded athlete work back to "conditioning" at
   all.** Even the one flat label above cannot be safely joined to what an
   athlete actually did: `pilot.training_attempts.context_id` (the column that
   would point at a specific drill or session) carries **no foreign key** to
   anything — it is bare `text null`. `pilot.drill_assignments` — the table
   that would connect an assignment to a cataloged drill — stores `drill_name`
   and `drill_description` as **free text**, not a foreign key to
   `pilot.drill_library.drill_id`, so an assignment can never be joined to
   that drill's `discipline = 'conditioning'` tag. `pilot.activity_log`'s
   `activity_domain` vocabulary (`boxing_training`, `schoolwork`,
   `gym_service`, `community_service`, `work_study`, `other`) has no
   conditioning value at all, and its `activity_type` is free text the writing
   coach can spell any way they like.

**Conclusion:** as the schema stands today, there is no path — not a hard one,
not an easy one — to compute a distribution of an athlete's recorded work
across conditioning types, because no type vocabulary exists and no recorded
row can be reliably identified as conditioning work in the first place. The
one thing that does exist is a single, flat, coach-judged **competence
level** for the whole `conditioning` domain (`pilot.athlete_competence`,
`basis` = `coach_observation` / `assessment_result` / `both` /
`carried_forward`) — an ordinal judgment, not a ratio, not a volume, and not
sub-typed. **This is the single hardest fact in this proposal: Module 035
cannot show a "balance" of anything, and building around that gap (e.g. by
parsing free text, or by guessing category from drill name) would itself be
inventing data the schema was deliberately built to refuse.** Sections (a)–(d)
below therefore split into what is honestly showable **today** and what
becomes possible **only if** the owner authorizes the schema and doctrine work
in Open Questions 1–3.

Per the task's own instruction: a target ratio between conditioning types is
**coaching doctrine**, not something to derive from data. That instruction is
compounded here by a prior gap — there isn't yet even a *type vocabulary* to
hold a target ratio against, let alone recorded work reliably tagged into it.

---

## (a) What it computes / shows

**Showable today, with zero schema change, honestly:**
- The athlete's own `pilot.athlete_competence` history where `domain =
  'conditioning'`: `level_key`, `basis`, `assessed_by_account_id`,
  `assessed_on`, `evidence_note`, and the `superseded_by` chain so a level
  history is never overwritten. Shown as a qualitative coach judgment over
  time, not a score. Its `basis` is always shown alongside it — a
  `coach_observation`-only level is flagged as such, never presented with the
  same confidence as `assessment_result` or `both`.
- Nothing else. There is no distribution, no ratio, no "types of conditioning
  work logged" view possible today, because (per the reality check above) no
  row can be reliably classified as conditioning work by type, or in most
  cases even as conditioning work at all.

**Showable only if the owner authorizes new schema work (Open Questions 1–2):**
- IF a controlled conditioning-type vocabulary is authored, AND IF a real,
  non-free-text tagging path is added connecting recorded work
  (`training_attempts`, `activity_log`, or a corrected `drill_assignments` ->
  `drill_library` link) to that vocabulary — THEN, and only then, the engine
  could show the athlete's own **recorded distribution** of tagged
  attempts/sessions across those types: counts, `duration_minutes` sums, or
  attempt counts, per type, over a stated date range. This is a description of
  what happened, never a verdict on whether it is "enough" or "right."
- IF, separately, the owner authors a **target ratio** as an explicit,
  attributed, editable input (see Open Question 3) — THEN the engine may show
  the athlete's own distribution *next to* that stated target, both labeled
  as what they are: "recorded distribution (real)" vs. "target set by
  `<coach/owner>` on `<date>` (doctrine, not derived)." The two are never
  merged into one number, percentage-of-target, or pass/fail state.

**Never shown, at any unlock state:**
- A single "conditioning score," "balance index," or "imbalance" percentage.
- A target ratio invented, defaulted, or inferred by the platform. If the
  owner has not authored one, the engine says `UNKNOWN — no target ratio has
  been set` rather than defaulting to any assumption (e.g. "equal parts of
  each type") that would itself be an invented ideal.
- Any comparison, ranking, or "more/less balanced than" framing across
  athletes, at any role level.
- Any classification of "conditioning" derived from free text (`drill_name`,
  `activity_type`, `hypothesis`, `target_problem`) — those fields are a
  coach's own words, not a controlled tag, and must never be silently parsed
  into a category the platform then treats as fact.

**Explicit UNKNOWN states:**
- No conditioning-type vocabulary defined: `UNKNOWN — conditioning types are
  not yet defined for this platform` (this is the current, permanent state
  absent owner action).
- No target ratio authored for this athlete/org: `UNKNOWN — no target ratio
  set`, shown distinctly from "distribution recorded but balanced/unbalanced
  not evaluated."
- An `athlete_competence` row with `basis = 'coach_observation'`: shown, but
  flagged `observation only, not backed by an assessment`.
- Zero `athlete_competence` rows for `domain = 'conditioning'`: `No
  conditioning level recorded yet` — never a default/starting level.

---

## (b) Data prerequisites

Two tiers, because a data-volume gate is meaningless before the categorization
it depends on exists.

### Tier 0 — prerequisite that is not a data volume at all (must exist first)

| # | Requirement | Real source / current state |
|---|---|---|
| 0.1 | A named, owner-approved conditioning-type vocabulary exists (e.g. as rows in a new lookup table, or a `check` constraint enumerating types) | **Does not exist anywhere in `infra/azure/*.sql` today** — see Open Question 1 |
| 0.2 | A non-free-text path connects at least one of `pilot.training_attempts`, `pilot.activity_log`, or `pilot.drill_assignments` to that vocabulary (e.g. a new `conditioning_type` column, or fixing `drill_assignments.drill_name`/`drill_description` to be a real foreign key to `pilot.drill_library.drill_id` so `discipline`/`category` can be read through it) | **Does not exist anywhere in `infra/azure/*.sql` today** — see Open Question 2 |

Until both 0.1 and 0.2 exist, no per-athlete or per-org data-volume gate below
can be evaluated, because there is nothing for a "conditioning-type row" query
to count.

### Tier 1 — per athlete (once Tier 0 ships; illustrative, mirrors this repo's existing count/span gates in sibling proposals)

| # | Requirement | Real source (once it exists) |
|---|---|---|
| 1 | ≥ 12 tagged rows (attempts or activity-log entries carrying the new conditioning-type tag from 0.2) for the athlete, spanning ≥ 2 distinct conditioning types from the Tier-0 vocabulary | new tag column, `athlete_id` |
| 2 | Those rows span ≥ 42 calendar days between the earliest and latest tagged `attempted_at` / `occurred_on` | `attempted_at` or `occurred_on` |
| 3 | At least 1 row exists in each conditioning type the distribution view will display — a type with zero rows is not silently omitted, it is shown as `0 recorded, no data` | same tag column, grouped |

### Tier 1 — per organization

| # | Requirement | Real source |
|---|---|---|
| 1 | ≥ 1 conditioning-type vocabulary entry is active org-wide (or platform-wide, per Open Question 1's scope decision) | Tier 0 lookup |
| 2 | ≥ 5 distinct `athlete_id` values in the org independently satisfy the full per-athlete Tier-1 gate above (minimum-N floor against small-group re-identification, consistent with sibling engine-unlock proposals in this repo, e.g. Module 017/015) | grouped by `organization_id` |

**The hardest prerequisite in this whole document is Tier 0, not Tier 1.**
Every sibling engine-unlock proposal in this repo gates on counting rows that
already exist; this module cannot even begin counting until the owner
authors a taxonomy and a real (non-free-text) tagging mechanism connects it
to recorded work. That is a schema and doctrine decision, not a data-volume
threshold, and no default number of "42 days" or "12 rows" fixes it.

---

## (c) Locked state

**Today, and until Tier 0 ships, the locked state is the same for every
athlete and every org, because there is nothing yet to make progress toward:**

> Conditioning Balance Engine — locked.
> This platform has not yet defined conditioning types or a way to tag
> recorded training as one. There is no partial progress to show, because
> there is nothing yet to count. This is not something an athlete or coach
> can do differently to unlock sooner — it requires an owner decision (see
> Open Questions 1–2) before any data can even be gathered toward it.

Once Tier 0 ships, locked state becomes an honest count exactly like this
repo's sibling proposals — real numbers, no percentage dressed up as
achievement, no countdown, no "almost there" copy aimed at a minor:

> Conditioning Balance Engine — locked for this athlete.
> Tagged conditioning-type rows recorded: 6 of 12 (2 of `<N>` defined types
> represented). Span so far: 21 of 42 required days.
> This view unlocks automatically once enough tagged rows are on record.
> There is nothing to do differently to "unlock" it faster, and no reward
> for reaching it sooner.

Org-level locked state (post-Tier-0) shows only a count: "how many active
conditioning types are defined" and "how many athletes have cleared their own
gate so far" — never which athletes, never a list.

---

## (d) What unlocks

**At athlete level** (visible only to that athlete, their guardian, and staff
with existing access to that athlete's record — never to any other athlete or
guardian, and never a comparison surface):
- Today: the athlete's own `athlete_competence` conditioning-domain level
  history, as described in (a).
- Post-Tier-0, once the athlete's own Tier-1 gate is met: their own recorded
  distribution of tagged conditioning work by type, over the stated period,
  shown only against **that athlete's own target ratio if and only if the
  owner has authored one for them** (Open Question 3) — and even then, as two
  side-by-side factual statements ("recorded" vs. "target set by
  `<name>` on `<date>`"), never as a computed deviation, gap score, or
  pass/fail verdict, unless the owner explicitly authorizes a specific,
  non-shaming presentation for that comparison (Open Question 4).
- No comparison to any other athlete, cohort average, percentile, or
  benchmark, at any unlock tier, permanently — this is a hard wall, not a
  future phase of this engine.

**At org level** (visible only to roles already permitted org-wide views —
`organization_admin`/`admin`/`coach`, per `pilot.organization_memberships`):
- Today: nothing — there is no org-level conditioning-type signal to
  aggregate.
- Post-Tier-0, once the org's Tier-1 gate is met: coverage counts only, e.g.
  "X of Y active athletes have a qualifying tagged conditioning-work
  history," and which conditioning types are defined org-wide — never a
  per-athlete breakdown, never an org-wide "average balance," since an
  average across athletes would itself be a fabricated composite this
  platform's honesty doctrine forbids.
- An org-level target ratio, if the owner authors one as a program-wide
  policy (Open Question 3, option relevant to org scope), is shown as
  program doctrine metadata — never blended with any individual athlete's
  own data into a single "compliance rate."

---

## (e) Open questions for the owner

**1. Should a conditioning-type taxonomy be authored at all, and if so, what
are the types?** This is the prerequisite nothing in this module can proceed
without.
- (a) Author a small, fixed set now (e.g. `aerobic_base`,
  `anaerobic_capacity`, `max_strength`, `power_explosive`,
  `mobility_recovery`), as a new lookup table the owner/coaching staff
  controls and can extend later.
- (b) Defer entirely: retire Module 035's premise and fold any conditioning
  content into Module 015 (Energy System Development Engine) or Module 013
  (Physical Capacity Engine), which already own adjacent proxy signals from
  `training_attempts`/`activity_log` without requiring a type-balance claim.
- (c) Author a taxonomy but scope it to one org at a time (each gym defines
  its own conditioning types) rather than one platform-wide vocabulary.
- (d) Keep the stub open (`Status: DRAFT`, `Active: false`) with no taxonomy
  work until Module 015's own open questions about energy-system proxies are
  resolved first, since the two modules would otherwise author overlapping,
  possibly inconsistent vocabularies independently.

**2. How should recorded work actually get tagged with a conditioning type,
given today's free-text gaps?**
- (a) Add a new `conditioning_type` column directly to
  `pilot.training_attempts` and/or `pilot.activity_log`, set at the point of
  recording by the coach (an explicit choice from the Tier-0 vocabulary, not
  inferred).
- (b) Fix the existing gap first: give `pilot.drill_assignments` a real
  foreign key to `pilot.drill_library.drill_id` (it currently stores
  `drill_name`/`drill_description` as free text with no link), so
  `drill_library.discipline = 'conditioning'` and its (currently free-text,
  also needing a controlled vocabulary — see `category`) sub-tag can be read
  through an assignment to an actual recorded attempt.
- (c) Both (a) and (b), phased: fix the drill-assignment link first as
  general schema hygiene, then add the explicit tag column for cases (like
  `activity_log` open-gym entries) that never go through a drill assignment
  at all.
- (d) Do not add new tagging; accept that this module can never show a
  distribution and restrict it permanently to the single qualitative
  `athlete_competence.domain = 'conditioning'` level described in (a).

**3. Who authors the target ratio, and at what scope?** The task is explicit
that a target ratio is coaching doctrine, never derived — this question is
about who owns that doctrine and how widely it applies.
- (a) Per-athlete, authored by that athlete's coach, editable at any time,
  always shown with who set it and when.
- (b) Per-program/org, one policy target applied to every athlete in that
  org unless a coach overrides it for a specific athlete.
- (c) Never authored inside this platform at all — the engine shows only the
  recorded distribution, permanently, with no target-ratio feature at any
  unlock tier (removes the "balance" claim from the module entirely).
- (d) Authored, but versioned like `intervention_protocols` (new version on
  change, old version preserved) so a later dispute about "what was the
  target on this date" has a real record instead of an overwritten value.

**4. If a target ratio exists, how may the engine present the athlete's
recorded distribution next to it?** Given the users are minors and the hard
wall against shame/FOMO framing.
- (a) Two side-by-side factual statements only ("recorded: 60% type A / 40%
  type B" and "target: 50%/50%, set by Coach X on 2026-06-01"), with no
  computed gap, delta, or verdict language anywhere.
- (b) Same as (a), plus a plain factual direction note with no magnitude
  framing ("more type-A work recorded than the target specifies this
  period") — still no numeric "imbalance score" or color-coded status.
- (c) No comparison rendering at all, even side-by-side — target and
  recorded distribution are shown on entirely separate screens/sections so
  they are never visually implied to be graded against each other.
- (d) Comparison shown to staff/coach roles only; the athlete's own view
  shows just their recorded distribution, never the target, to avoid a
  minor experiencing any comparison framing directly.

**5. Should this module exist as a distinct engine at all, or does its one
currently-real signal (`athlete_competence.domain = 'conditioning'`) belong
inside a broader physical-training engine instead?** Given Module 015
(Energy System Development Engine) already covers duration/effort/repetition
proxies from the same underlying tables, and both modules would otherwise
independently invent adjacent — and potentially conflicting — conditioning
vocabularies.
- (a) Keep Module 035 narrowly scoped to whatever the owner decides in
  Questions 1–4, coordinated explicitly with Module 015's own open questions
  so the two do not ship incompatible taxonomies.
- (b) Retire Module 035 and fold the single qualitative competence-level view
  into Module 013 or 015, which already have natural homes for adjacent
  signals.
- (c) Keep the stub in `DRAFT`/`Active: false` until Module 015 ships and its
  taxonomy questions resolve, then revisit whether 035 still has independent
  scope.
