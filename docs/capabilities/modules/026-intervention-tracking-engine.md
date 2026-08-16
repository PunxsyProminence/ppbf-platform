# Module 026 — Intervention Tracking Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (keystone build, 2026-08-16; owner-directed spec `InterventionExecutionLedger_TheWork`) |
| Vertical slice | Three-table ledger + three coach surfaces: protocols (versioned intent), executions (planned-vs-actual, adherence, corrections), evidence links + outcome reviews (typed evidence, three-answer human verdicts). Migrations registered but **not yet applied to staging/production** — ships with the next release wave. |
| Active | false |
| Promotion required | true |
| Category | Physical Training System (`physicalTrainingSystem`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

## Intent

The durable record connecting recommendation → human decision → intervention protocol → actual execution → typed evidence → human-reviewed outcome → athlete-specific learning. It answers: *"What did we actually try, why, what was actually delivered, under what conditions, what evidence followed, and what did we learn — including when it failed?"* Its most valuable output is not a score; it is a trustworthy longitudinal record with provenance. This module must never choose an intervention, compute a verdict, claim causality, or collapse performance/hypothesis/learning into one number.

## Boundaries

- Does **not** choose interventions, approve medical or progression decisions, or replace human coaching judgment.
- Does **not** infer causal certainty: preceding an outcome is not causing it. The ledger preserves data for later inference; it does not infer.
- Does **not** produce effectiveness scores, confidence numbers, universal dose scalars, difficulty ratings, or information-gain metrics.
- Does **not** auto-generalize one athlete's result into organization-wide methodology — athlete-specific learning stays athlete-specific; generalization is a separate human-reviewed path that does not exist in this module.
- Does **not** treat a miss as validation ("it works") — and does not treat a miss as useless: misses carry reviewed learning signals.
- Does **not** expose anything to athletes or parents; every surface is staff-only.

## Dependencies

- Upstream: `pilot.shadow_decisions` (decision links, read-only), `pilot.athletes`/`pilot.accounts`/`pilot.organizations` (identity), `pilot.session_script_runs` (session references), evidence source tables (`pilot.training_attempts`, `pilot.readiness`, `pilot.assessments`, `pilot.shadow_film_study_proposals`, `pilot.activity_log`).
- Downstream: future statistical/single-case-analysis modules read this ledger (baseline evidence, repeated observations, exposure, adherence, timing, confounders); none write to it.
- Related: modules 021/033 (Banister RESEARCH_FIRST — any quantitative modeling remains gated on real PPBF data), 194 (training attempts), drill versioning (lineage pattern reused).

## Schema

Three migrations, all idempotent, registered in the workflow's three lists and the `test:migrations` chain:

1. **`pilot.intervention_protocols`** (`pilot_slice_postgres_intervention_protocols_migration.sql`) — versioned intent. Lineage supersession (one ACTIVE head per lineage via partial unique index; `(version = 1) = (supersedes is null)` both directions); structured `intended_exposure` jsonb over the fixed 8-dimension vocabulary (sessions, rounds, minutes, repetitions, live/constrained opportunities, cue/task exposures); hypothesis-before-hindsight fields (`contradicting_evidence`, `alternative_explanations`) recorded at filing time; nullable athlete applicability with composite FK.
2. **`pilot.intervention_executions`** (`..._intervention_executions_migration.sql`) — what actually happened. `planned_exposure`/`planned_task_context` snapshotted at start, never rewritten; explicit `adherence` five-state vocabulary (no percentages); named-deviations and stop-reason CHECK constraints; correction supersession with required `correction_reason`; composite FKs bind athlete, protocol, session run, and (via added unique index on `shadow_decisions(organization_id, decision_id)`) the decision link to the same organization; `trained_context` is facts (`unknown/controlled/constrained_live/live`), no difficulty scores.
3. **`pilot.intervention_evidence_links` + `pilot.intervention_outcome_reviews`** (`..._intervention_evidence_migration.sql`) — the loop close. Typed links: semantic role (`baseline/during_intervention/immediate_post/retention/transfer/counterevidence/adverse_response/context`) × typed source kind × source id; duplicate-active-link refusal; removal stamps with a required reason, never deletes. Reviews: three separate vocabularies (performance result / hypothesis result incl. `confounded` and `insufficient_evidence` / learning signal incl. miss taxonomy); **failure-learning rules as CHECK constraints** — declined/unchanged performance cannot carry a supported hypothesis; confounded/insufficient evidence cannot strengthen a prior belief; one active review per execution (re-review supersedes).

## API surface

Cohesive action routes, staff roles (`coach`, `organization_admin`, `admin`) only:

- `GET/POST/PATCH /api/pilot/coach/intervention-protocols` — list; create; `retire`/`revise` (full re-statement, supersession).
- `GET/POST/PATCH /api/pilot/coach/intervention-executions` — list (optional athlete filter); start (snapshots the plan from the ACTIVE protocol head; athlete-specific protocols never apply to another athlete; decision must match org+athlete); `record`/`close`/`correct`.
- `GET/POST/PATCH /api/pilot/coach/intervention-review` — chain view (execution + decision text + evidence + active review); `link_evidence`/`review_outcome`; `remove_evidence` (stamped with reason).

Vocabulary violations are 400s with the reason; cross-org/cross-athlete/nonexistent references are hidden 404s indistinguishable from nonexistence.

## Roles / access

Create protocol, record execution, correct, attach evidence, review outcome, view history: coach, organization_admin, admin. Athletes and parents have **no path** to any of the three routes. All reads and writes are organization-scoped through the session principal; athlete scoping is enforced by composite FKs and per-source validation queries.

## Audit events

Generic vocabulary (`event_type` create/update) with `entity_type` `intervention_protocol` / `intervention_execution` / `intervention_evidence_link` / `intervention_outcome_review`. Protocol create/revise/retire (revise carries lineage + supersedes), execution start/record/close/correct (correct carries the stated reason), evidence link/remove (remove carries the reason), outcome review (carries all three answers + superseded review id). Nothing erases previous state anywhere in the module.

## UI surface

Three doors in the coach workspace (`buildingMap`): `/coach/intervention-protocols` (file/list/retire intent), `/coach/intervention-executions` ("The Work": start from a protocol, close out with actual facts, planned-vs-actual side by side), `/coach/intervention-review` ("What We Learned": DECISION → PLANNED → ACTUALLY DID → WHAT HAPPENED (evidence) → LEARNED, with link-evidence and three-answer review forms). No page offers a dose, difficulty, percentage, or score field.

## Refusal cases

Invented exposure dimensions; non-positive amounts; adherence percentages; difficulty/challenge contexts; unnamed deviations; silent stops; corrections without reasons; unexplained evidence removal; duplicate active evidence; cross-org decisions/athletes/protocols/sources (database-level); cross-athlete evidence; superseded executions as link targets; reviews of in-progress executions; a miss recorded as success; confounded evidence strengthening a belief; evidence roles like "proof it worked".

## Evidence semantics

An evidence link is a typed claim: *this record, in this semantic role, bears on this execution*. Sources stay in their own tables (attempts, readiness, assessments, film observations, activity rows) — heterogeneous by design, validated per kind for existence, organization, and athlete match against the execution. `counterevidence` and `adverse_response` are first-class roles. Links are append-only; removal is a stamped state with a reason.

## Failure-learning semantics

Three separate answers, never one score: **PerformanceOutcome** (what happened), **HypothesisResult** (what happened to the belief — supported / partially_supported / contradicted / unresolved / confounded / insufficient_evidence), **LearningSignal** (what the episode revealed — strengthened/weakened belief, boundary discovered, non-response, transfer/retention/implementation failure, attribution changed, redundant, unresolved). A miss cannot validate success (constraint); a miss can and should produce a reviewed learning signal — "one hard-fought loss is worth a thousand easy victories" is enforced here, not just quoted. Abstention (`unresolved`, `insufficient_evidence`) is a valid output.

## Tests / runtime evidence

Fifteen pg contract tests across three embedded-Postgres suites (`interventionProtocols/​Executions/​Evidence.pg.test.ts`): migration stacking + idempotent re-apply, lineage shapes both directions, one-active-head/one-current-record/one-active-review partial indexes, planned-facts-survive-deviation, multi-execution spans, adherence/vocabulary/honesty constraint refusals, correction history preservation, cross-org and cross-athlete refusals by composite FK and by the per-source validation queries against real source tables. Eighteen route tests (role refusals, vocabulary 400s, hidden 404s without audit, audit payloads, supersession audits), eleven unit tests (closed vocabularies), nine page tests (structured posting, no score fields, planned-vs-actual and counterevidence rendering, honest unreviewed state). Runtime reachability on staging/production lands with the release wave that applies the three migrations.

## Known limitations

- Evidence sources are named by record id in the UI (no picker yet); the API validates them fully.
- Executions are corrected via API-first flow; the page covers start/close (corrections and mid-flight `record` are route-level).
- No SCED/experiment metadata (deliberate: only record design characteristics that actually occurred; none do yet).
- Legacy `shadow_decision_outcomes` (decision-linked, untyped `observation_ids`) continues to function; new execution-aware review attaches to executions. The legacy path's weaker provenance is left explicit rather than backfilled into fabricated executions.
- No aggregation, no cross-athlete reads, no statistics — downstream modules' work, by design.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-16 | external-research-ingestion | Owner-run external research reconciliation (Round 5, 2026-08-16): intervention execution/tracking is ranked the central missing learning primitive for the platform's evidence loop -- without a record of what intervention was actually run, outcomes cannot be attributed to anything. Raises this module's priority when its build turn comes; the Wave 9 audit confirmed no covering code exists today. |
| 2026-08-16 | claude-session | Slice 1 of 3 shipped: `pilot.intervention_protocols` (versioned intent, structured exposure, hypothesis-before-hindsight). |
| 2026-08-16 | claude-session | Slice 2 of 3 shipped: `pilot.intervention_executions` (planned-vs-actual snapshots, explicit adherence states, named deviations, correction lineage, org-bound decision links). |
| 2026-08-16 | claude-session | Slice 3 of 3 shipped: `pilot.intervention_evidence_links` + `pilot.intervention_outcome_reviews` (typed semantic evidence, three-answer human review, miss-cannot-validate-success and confound-cannot-strengthen as database constraints), the What We Learned loop view, and this document rewritten from scaffold. Status promoted to DONE per the playbook rule (slice shipped in code) with ManualVerification PENDING_SIGN_OFF; migrations await the next release wave. |
