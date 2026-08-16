# Module 025 — Limiter Hierarchy Engine — Engine-Unlock Proposal

| Field | Value |
|---|---|
| Status | PROPOSAL — owner approval requested, no code changes made |
| Module stub | `docs/capabilities/modules/025-limiter-hierarchy-engine.md` (DRAFT, Active: false) |
| Governing decision | Owner decision 2026-08-16, item 7 (`docs/current/ACTIVE_WORK.md`): "engines unlock as data gathers... an unlock is an honesty gate, not a gamification score... design to be proposed per-engine as slices come up." |
| Related module | Module 026, Intervention Tracking Engine — schema already exists as `pilot.intervention_protocols` / `pilot.intervention_executions` / `pilot.intervention_evidence_links` / `pilot.intervention_outcome_reviews` ("InterventionExecutionLedger_TheWork"). This proposal treats 026's ledger as the downstream consumer of a limiter, not as something this module writes to. |
| Schema cited | `infra/azure/pilot_slice_postgres_training_attempts_migration.sql`, `..._sparring_attempt_contexts_migration.sql`, `..._intervention_protocols_migration.sql`, `..._intervention_executions_migration.sql`, `..._intervention_evidence_migration.sql`, `..._assessment_protocols_migration.sql`, `..._activity_log_migration.sql`, `pilot_slice_postgres.sql` (`pilot.readiness`, `pilot.assessments`, `pilot.athletes`) |

---

## (a) What it computes / shows

**What a "limiter" is here, precisely:** a physical/technical quality where an athlete's own `pilot.training_attempts` rows show a *repeated, recent, target-bearing failure pattern* on one `metric_kind` — nothing more. It is a description of a recorded pattern of misses, not a diagnosis, not a trait, and not a prediction.

Concretely, for a given athlete and a given `metric_kind` (`reps`, `time_seconds`, `distance_m`, `load_kg`, `rounds`, `hold_seconds`):

- Count of attempts in a trailing window where `target_value is not null` (i.e. `made` is populated, per the table's own constraint that a verdict requires a target).
- Of those, the count and proportion where `made = false`.
- The `context_type` values those failures occurred in (`session`, `drill_assignment`, `assessment`, `film_study`, `open_floor`, `technical_sparring`, `sparring_games`, `sparring_drills`, `open_sparring`) — a limiter that only shows up in `open_sparring` and never in `drill_assignment` is a *transfer* fact, and the engine must say so rather than collapsing contexts into one number.
- Recency: `attempted_at` of the most recent failure and most recent make, so the display can distinguish "still failing as of last week" from "used to fail, hasn't failed recently."

**What it explicitly does NOT compute:**
- No invented composite "limiter score." `metric_kind` units are not commensurable (reps vs. seconds vs. kg vs. meters) — the same principle already enforced in `pilot.intervention_protocols.intended_exposure` ("STRUCTURED EXPOSURE, NEVER A DOSE SCALAR... forcing these onto one number would be an invented metric, which this platform refuses") applies identically here. This engine will not collapse six incompatible units into one number to make them rankable.
- No percentile, no comparison to any other athlete, no cohort/peer average. `pilot.training_attempts`' own design note is explicit that access is "staff plus the athlete's own records," and "NO leaderboard, ranking, or cross-athlete comparison surface may be built on this table." That constraint is structural, not a display choice this engine can override.
- No score derived from `pilot.assessments.result` (a free-form `jsonb` blob keyed by `assessment_type`, no fixed vocabulary) or from `pilot.assessment_protocols` measures whose own columns default to `reliability_status = 'UNVALIDATED - PPBF MUST ESTABLISH'` and `validity_status = 'UNKNOWN'`. Building a limiter claim on an unvalidated, unstructured measure would be exactly the kind of invented-number problem the honesty doctrine forbids. Assessments may appear later as supporting *evidence* (see (d)), never as the primary computation.
- No use of `pilot.readiness.score`/`category` as limiter evidence. Readiness is a wellness/fatigue signal, not a record of physical-capability failure; conflating the two would misrepresent what was actually measured.

**Explicit UNKNOWN states, always shown rather than omitted:**
- A `metric_kind` with zero target-bearing attempts recorded: `UNKNOWN — not yet measured`.
- A `metric_kind` below the data-prerequisite threshold (see (b)): `UNKNOWN — not enough attempts recorded yet`, shown with the actual count so far.
- A `metric_kind` where failures exist but are all old / superseded by a run of recent makes: shown as `RESOLVED — no recent failures`, not silently dropped (an athlete's history of having worked on something is itself information, and hiding a resolved limiter would erase the evidence of progress that caused it to resolve).

**Ordering ("hierarchy") — stated honestly:** the schema supports an honest *ordering within one `metric_kind`* (by failure recency and failure frequency — both are stored facts, not inferred weights). The schema does **not** support an honest *cross-quality* ordering (e.g., "your #1 limiter is grip strength, #2 is footwork endurance") without inventing a weighting formula across incompatible units, which is exactly the fabricated-metric problem the platform's own design notes refuse elsewhere. Absent an owner-approved weighting method, this proposal's default is: **an unordered set of observed limiters, one fact-card per `metric_kind`**, sortable only by recency/frequency within a card, never merged into one ranked list across cards. See Open Question 3.

---

## (b) Data prerequisites

Checkable per **athlete**, computed from `pilot.training_attempts` filtered to `organization_id = <org>` and `athlete_id = <athlete>` (the existing index `idx_training_attempts_athlete_metric(organization_id, athlete_id, metric_kind, attempted_at desc)` already serves this access pattern — no new index required):

| Prerequisite | Proposed default (owner to confirm — see Open Question 1) |
|---|---|
| Minimum target-bearing attempts per `metric_kind` (`target_value is not null`, so `made` is non-null) | 5 attempts |
| Minimum distinct calendar days those attempts span | 14 days (guards against 5 attempts recorded in one session reading as a "pattern") |
| Minimum distinct `context_type` values represented | 2 (guards against a single-context artifact, e.g. one bad assessment day, reading as a durable limiter) |
| Recency requirement for the failure pattern to be "current" (not just historical) | at least 1 failure (`made = false`) within the trailing 30 days |

An athlete's limiter view unlocks **per `metric_kind` independently** — an athlete may have `load_kg` unlocked while `hold_seconds` still shows `UNKNOWN`. This mirrors the reality that gyms and coaches record different metrics at different rates for different athletes; a single all-or-nothing gate across six unrelated metrics would either lock out an athlete who has rich `reps` data because their `distance_m` data is thin, or silently paper over the thin metric. Neither is honest.

Checkable per **organization**, computed by counting distinct athletes who individually meet the per-athlete prerequisite above, restricted to `active_flag = true` athletes (`pilot.athletes.active_flag`):

| Prerequisite | Proposed default (owner to confirm — see Open Question 4) |
|---|---|
| Minimum active athletes with at least one unlocked `metric_kind` | 8 athletes |
| Minimum total target-bearing `training_attempts` rows recorded org-wide, trailing 90 days | 150 attempts |
| Minimum distinct `recorded_by_account_id` values in that window | 2 (guards against the org's entire attempt history coming from one coach's idiosyncratic recording habits, which would make an org-level pattern a single-observer artifact) |

All four numbers above are proposed defaults for owner sign-off, not values this proposal treats as already decided — they are exactly the kind of threshold the owner-decision text says must be "stated explicitly" per engine, and are deliberately conservative rather than tuned against any real data, since no production `training_attempts` volume has been reviewed for this proposal.

---

## (c) Locked state

Before an athlete's `metric_kind` card unlocks, the athlete-facing (and coach-facing) view shows honest progress toward the prerequisite, never a placeholder score and never a teaser number implying an unrevealed result:

> **Load capacity (kg) — building a picture**
> 3 of 5 recorded attempts with a target · 9 of 14 days · 1 of 2 training contexts
> *Keep recording attempts with a target — this fills in as data comes in, not as a countdown to unlock something.*

Deliberately absent from this locked state, per the hard walls in this proposal's brief: no progress bar framed as a game meter, no "X away from unlocking," no streak counter, no comparison to how quickly other athletes' cards have filled in. The copy states facts about *this athlete's own recorded history* only.

At the **org level**, before the org prerequisite is met, the admin/coach dashboard shows:

> Limiter Hierarchy Engine — org data: 5 of 8 athletes with an unlocked metric · 96 of 150 recent attempts recorded
> *Locked org-wide. Individual athlete cards above may already be visible to their own coach where that athlete alone has met the per-athlete bar — org-level aggregation needs its own, larger bar.*

This means an individual athlete's own card can be unlocked (to that athlete and their coach) while the org-level aggregate view stays locked — the two gates are independent, matching the athlete-level/org-level split the owner decision specifies ("Athlete-facing 'rank up' means unlocking richer views of their OWN record... org-level unlocks mean an organization earns engine activation by accumulating real data").

---

## (d) What unlocks

**Athlete level — their own record only:**
- Per-`metric_kind` fact cards as described in (a): failure count, make count, contexts, recency — restricted to that athlete's own `training_attempts` rows.
- Each card is evidence-backed and drillable: the athlete (and their coach) can see the actual underlying attempts (`attempt_id`, `attempted_at`, `context_type`, `target_value`, `achieved_value`, `direction`) that produced the "still showing recent failures" read — never a bare label with no citation.
- **No leaderboard, no percentile, no "your rank among teammates."** This is a structural prohibition carried over from the `training_attempts` table's own design intent, not a UI style choice — there is no query this module should ever run that joins across `athlete_id` values for display purposes.
- Framing follows the training-attempts migration's own stated philosophy ("the edge where an athlete fails IS their current capacity... one hard-fought loss is worth a thousand easy victories"): the card is titled around the *quality being built* ("Load capacity," "Round endurance") rather than a deficit label ("Weakness: grip"), and pairs the fact with what is actually true about it (frequency, recency, context) rather than a verdict about the athlete.

**Org level:**
- Aggregate counts only: how many active athletes have at least one unlocked metric, how many total unlocked metric-cards exist roster-wide, and which `metric_kind`s are *most commonly* the ones showing recent failures across the roster (a distribution over metric types, not over named athletes) — useful for a coach deciding what to program more of in group sessions, without exposing a ranked roster of individuals.
- A per-athlete roster list (which named athlete has which limiter) is **not** proposed as part of this org-level unlock by default, because staff who need a specific athlete's detail already have it via that athlete's own unlocked card (see (a) — `training_attempts` access is "staff plus the athlete's own records"). Whether org/coach roles should additionally get a roster-scoped list view is Open Question 4.

**Coach confirmation before an athlete sees a limiter — not yet decided here, flagged explicitly:** this platform already has a shipped precedent for gating athlete-facing inferences behind a human: deterministic gap suggestions ship as "coach confirms or dismisses; nothing reaches an athlete unconfirmed" (`docs/current/ACTIVE_WORK.md`, 2026-08-15 wave). A limiter card is arguably lower-stakes than a gap *suggestion* — it states recorded facts (counts, dates) with no recommendation attached — but it is still a statement about a minor's current weak point, and the owner may want the same confirm-before-visible gate applied here. This proposal does not assume either answer; see Open Question 2.

**Relationship to Module 026 (Intervention Tracking Engine):** a limiter card is a plausible *reason* to start a new `pilot.intervention_protocols` row (its `target_problem` field), but this proposal does **not** treat that hookup as automatic. Also flagged as a real schema constraint: `pilot.intervention_evidence_links.source_kind` is a fixed vocabulary — `training_attempt`, `readiness`, `assessment`, `film_study`, `activity_log` — with no `limiter_hierarchy_output` (or equivalent) member. This module's *derived* output (the fact card itself) cannot be registered as evidence in the 026 ledger as it stands; only the underlying `training_attempts` rows it summarizes can be linked in, individually, by whoever creates the evidence link. If the owner wants a limiter card to be directly citable as its own evidence kind, that is a schema change to `pilot.intervention_evidence_links`' check constraint, out of scope for this proposal.

---

## (e) Open questions for the owner

1. **Prerequisite thresholds.** Section (b) proposes defaults (5 target-bearing attempts, 14-day spread, 2 contexts, 30-day recency for athlete-level; 8 athletes / 150 attempts / 2 recorders for org-level) with no production data reviewed to tune them. Options:
   a. Approve the proposed defaults as-is for launch, revisit after real data volume is observed.
   b. Set different numbers now (please specify).
   c. Make the threshold configurable per-organization by an admin, with the proposed numbers as the shipped default.
   d. Require a coach-facing "why is this still locked" detail view (exact counts, as in (c)) before approving any numeric threshold, so the first review is of the UI rather than the numbers in the abstract.

2. **Confirmation gate before an athlete sees their own limiter card.** Options:
   a. Coach must confirm/dismiss before it becomes visible to the athlete (mirrors the existing gap-suggestion precedent).
   b. Visible to the athlete immediately once the data threshold is met — it states only recorded facts, no recommendation, so no human gate is needed.
   c. Visible to the athlete immediately, but the athlete's coach gets a passive notification (not a required action) the first time a metric unlocks.
   d. No athlete-facing surface at all in this first slice — coach/staff-only view until the owner separately decides athletes should see it.

3. **Cross-metric ordering ("hierarchy").** The schema cannot honestly support ranking across different `metric_kind`s without an invented weighting formula. Options:
   a. Never rank across metric kinds — ship as a permanently unordered set of per-metric cards (this proposal's default).
   b. The owner defines an explicit, documented weighting/normalization method later, as its own separate decision, and the engine adds true cross-metric ordering only once that method is approved.
   c. Allow ordering only *within* a single `metric_kind` by recency/frequency (both are stored facts) — ship this now as a middle ground, never merge across kinds.
   d. Something else the owner has in mind for what "hierarchy" in the module's name should mean, if not a numeric ranking.

4. **Org-level view scope.** Options:
   a. Aggregate statistics only (counts, percentages, metric-kind distribution) — no named-athlete list at the org level; anyone needing a specific athlete's detail goes to that athlete's own record.
   b. A roster-scoped list (which named athlete currently has which unlocked limiter) visible to coach/org-admin roles, since those roles already have standing access to individual `training_attempts` rows anyway.
   c. Both views, gated separately by role (e.g., board sees aggregate only, coaches see the roster list).
   d. Defer org-level entirely for this slice; ship athlete-level only until the owner reviews real athlete-level output first.

5. **Relationship to Module 026's evidence ledger.** `pilot.intervention_evidence_links.source_kind` has no member for this engine's own output. Options:
   a. Leave it as view-only: a coach who wants to cite a limiter when creating an intervention protocol manually re-enters the relevant `training_attempts` as individual evidence links, the normal way.
   b. Add a "suggest a draft protocol" action that pre-fills `target_problem`/`hypothesis` text from the limiter card for a coach to edit and submit (still fully human-authored/approved, per the platform's no-autonomous-approval rule) — no schema change needed for this option.
   c. Propose a schema change adding a new `source_kind` (e.g. `limiter_summary`) so a limiter card can be linked as its own evidence row, in a future migration — explicitly out of this proposal's scope, listed here only so the owner can decide whether to greenlight it separately.
   d. No relationship at all for this slice; treat 025 and 026 as fully independent until the owner asks for a hookup.
