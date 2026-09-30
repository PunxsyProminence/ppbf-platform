# Engine Unlock Proposal — Module 033 Fatigue / Decay Monitor

## Status

PROPOSAL — awaiting owner approval. No code changes accompany this document.

The module stub (`docs/capabilities/modules/033-fatigue-decay-monitor.md`) currently says only: Status **DRAFT**, Active `false`, an empty one-paragraph Intent, the three generic Boundaries shared by every scaffolded module (no auto-approval, no unsuppressed athlete detail to board/public, no invented metrics), empty Dependencies, and an unchecked Acceptance-criteria checklist — plus the 2026-08-16 audit-log entry establishing that fitness-fatigue / impulse-response decay modeling is RESEARCH_FIRST for this module specifically.

## (a) What the engine computes and shows

This engine computes **no fatigue score, index, or curve of any kind.** Module 021's audit log (read as required reading) found no boxing-validated Banister impulse-response decay constants (tau1/tau2) and no youth evidence for any fixed tau, and ruled fitness-fatigue modeling RESEARCH_FIRST for both 021 and this module. Per the standing rule from issue #345 ("no algorithm constant changes merely because a paper exists"), this proposal imports zero constants from adult, non-boxing, or non-PPBF literature, and computes zero derived formula from them.

What it does instead is an honest **observational juxtaposition**: two things PPBF already records, shown on the same timeline for one athlete, so a human reads whatever relationship is or isn't there.

**Left rail — recorded exposure**, sourced from existing tables, never re-derived into one dose number:
- `pilot.activity_log.duration_minutes` + `.rpe` where `activity_domain = 'boxing_training'`, per `occurred_on` — the general training-load facts already used by module 020.
- `pilot.sparring_exposure.time_under_impact_sec`, `.coach_observed_intensity`, `.coach_observed_head_contact` — the sparring-specific exposure instrument (never round count).
- `pilot.session_load.rpe_physical` and `.rpe_cognitive`, kept split exactly as the schema requires — never merged, never multiplied into an sRPE load number (that arithmetic is explicitly not a stored column, and this module does not store it either).

**Right rail — recorded outcomes**, likewise never blended into the exposure side:
- `pilot.training_attempts.made` / `.achieved_value` / `.target_value`, grouped by `metric_kind`, over `attempted_at` — the failure-first ledger, read exactly as it already exists (module 020/021's dependency).
- `pilot.readiness.score` over `measured_at` — the athlete's existing daily check-in signal (already a real, tested formula per `readinessMath.ts`; this module reads it, it does not compute it).
- `pilot.session_load.next_session_quality` — the existing lagged carryover field, read as-is, not extrapolated.
- `pilot.training_holds` rows where `reason_category = 'fatigue'`, by `placed_at` — a human's own recorded judgment that training was paused for fatigue, which is itself outcome evidence, not something this engine infers.

The coach (or, at athlete level, the athlete themself for their own record) sees these two rails side by side over a chosen window and reads the relationship visually. The engine annotates gaps (windows with exposure but no readiness check-in, or vice versa) as UNKNOWN rather than interpolating.

**What it explicitly does NOT compute:** no fatigue index, no recovery-time estimate, no "days until ready," no cumulative/chronic load ratio, no acute:chronic workload ratio, no dose-response curve fit, no predicted injury or overtraining risk, no auto-flag or auto-hold, and no cross-athlete comparison of any of the above.

## (b) Data prerequisites

### Per athlete

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| General training exposure | `pilot.activity_log.duration_minutes` where `activity_domain='boxing_training'` | OWNER_DECISION (suggest ≥ 8 occurrences) | trailing 14 days | A single logged session cannot show a "relationship" — it's one point. The repo's existing evidence-ladder module (`patterns/policy.ts`) refuses any occurrence bar below 2 by hard-coded floor and requires the real bar to be owner-ratified, not invented here; this module should follow the same shape. |
| Sparring-specific exposure | `pilot.sparring_exposure.time_under_impact_sec` (+ `coach_observed_intensity`) | OWNER_DECISION (suggest ≥ 3 segments) | trailing 30 days | Sparring is intentionally a separate exposure type from conditioning (schema doctrine); too few segments and the `light/moderate/firm/unclear` range can't show any spread at all. |
| Recorded outcome: attempts | `pilot.training_attempts.made` for the same `metric_kind` | OWNER_DECISION (suggest ≥ 5 attempts, same `metric_kind`) | same window as exposure | Made/failed needs repeats on one metric before "pattern" language is honest — the identical logic module 021's evidence ladder already enforces for behavioural observations. |
| Recorded outcome: readiness | `pilot.readiness.score` | OWNER_DECISION (suggest ≥ 5 fresh check-ins) | trailing 14 days | Fewer readings than exposure-logging days means most of the exposure rail would have no adjacent outcome point to juxtapose — an empty rail is a locked state, not a sparse chart. |

### Per organization

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Athletes individually qualified | derived count of athletes meeting the per-athlete row above | OWNER_DECISION (suggest ≥ 5 distinct athletes) | trailing 30 days | Module boundary text (every scaffold, including this one) forbids exposing athlete-level data to org aggregates without suppression; an aggregate built from fewer athletes than this risks being reversible to one child's record, the same concern that drives the playbook's "board/public never gets individual athlete clinical detail" rule. |
| Fatigue-attributed holds | `pilot.training_holds` where `reason_category='fatigue'` | OWNER_DECISION (suggest ≥ 3 holds across ≥ 3 distinct athletes) | trailing 90 days | A single hold is one human's one decision on one day, not an organizational signal; requiring distinct athletes stops one athlete's repeated holds from posing as an org-wide pattern. |

No signal here depends on wearables, HR, or any biometric stream — `BACKLOG-wearables` is parked per `docs/current/ACTIVE_WORK.md` and this proposal does not design around it.

## (c) LOCKED state

Before an athlete's per-athlete row is satisfied, the athlete (own record) and their coach see real counts against the real thresholds above, phrased as progress toward a view, never as a game state:

> "6 of 8 boxing training sessions logged in the last 14 days. 2 of 5 recorded attempts on this metric. 3 of 5 readiness check-ins this week."

Each line names the specific real action that produces the missing data — log the next session (existing activity capture), record the attempt result (existing training-attempts flow), complete today's readiness check-in (existing daily check-in) — never an abstract "keep training." No XP, points, levels, streak flame, or badge appears anywhere in this surface; the engagement doctrine here is the same one `pilot.training_holds` already encodes for `athlete_explanation` (a gap is explained plainly, never used to shame). An athlete who has trained hard but simply hasn't logged assessments sees "insufficient recorded outcomes," never a lower rank or a red state implying they are behind anyone else.

For the org-level view, the LOCKED state is a single count: "3 of 5 athletes have enough recorded history for an org-level pattern view" — with no name, initial, or per-athlete breakdown ever shown pre- or post-unlock (see (d)).

## (d) What unlocks

### At athlete level (own record only)

Once the per-athlete thresholds are met, the athlete and their coach see the two-rail juxtaposition described in (a) — exposure timeline beside outcome timeline, for that one athlete's own record only. Nothing about this unlock produces a number that didn't already exist in `pilot.activity_log`, `pilot.sparring_exposure`, `pilot.session_load`, `pilot.training_attempts`, `pilot.readiness`, or `pilot.training_holds`. The unlock changes what is *displayed together*, not what is *computed*.

### At org / coach level

Once the org-level thresholds are met, staff (coach/organization_admin/admin) see only the aggregate count of qualified athletes and, if the owner approves it separately, an anonymized distribution shape (e.g., "of qualified athletes, most show a same-direction readiness dip within 48h of high-exposure sessions; a minority show none") with no athlete identity attached at any zoom level — matching module 026's staff-only, no-cross-athlete-comparison posture and the playbook's board/public suppression rule. This aggregate is descriptive counting, not a fitted model.

### What stays locked forever

**A modeled fatigue/decay curve (any Banister-style impulse-response fit, any fixed or fitted tau, any "recovery in N hours" output) is not unlockable by data volume, ever, under this proposal.** Record counts measure whether an *observational display* is honest to show — they cannot manufacture boxing-specific, youth-population-validated decay constants that do not currently exist in the literature per 021's audit. The only path this proposal recognizes for that gate to open is: (1) a dedicated research effort (internal PPBF longitudinal data reaching statistical adequacy, or a published boxing-specific, youth-validated reliability/validity study, mirroring the `reliability_status`/`validity_status`/`evidence_class` fields the assessment-protocols schema already carries for exactly this reason), followed by (2) its own owner-approved promotion review under the playbook — never an automatic transition triggered by hitting a row count.

## (e) Open questions for the owner

1. **Exact minimum-record numbers.** Options: (a) adopt the suggested defaults above (8 activity_log rows / 3 sparring segments / 5 attempts / 5 readiness check-ins per athlete; 5 athletes / 3 holds across 3 athletes per org); (b) set stricter numbers now, before any pilot data exists to calibrate against; (c) ship the thresholds as an owner-ratified, versioned policy object (mirroring `PatternFormationPolicy` in `apps/web/src/server/pilot/patterns/policy.ts`, which stamps every bar with a `policyVersion` and `ratifiedByAccountId` rather than a hardcoded constant) so the number is changeable without a code migration. **Recommendation:** (c) — this repo already has the pattern for exactly this problem; reuse it instead of hardcoding a number in this module too.
2. **Whether an org-level view should exist at all yet.** Options: (a) build the aggregate-count view now, gated at ≥5 athletes; (b) skip org-level entirely for v1 — many PPBF-scale gyms may never clear a 5-athlete floor, and a feature that's permanently locked for small orgs invites lowering the floor under pressure, which is exactly the suppression risk the threshold exists to prevent; (c) build only the bare qualified-athlete count (no distribution shape at all) so there is nothing to lower a floor *for*. **Recommendation:** (c) — smallest surface that cannot leak, and it can grow later once real org sizes are known.
3. **What evidence standard actually reopens the decay-curve question.** Options: (a) an internal PPBF single-case/statistical-inference result reaching adequacy under the existing `patterns/inference` machinery already in this codebase; (b) a published boxing-specific, youth-population-validated impulse-response study; (c) leave the bar undefined until a research ticket is explicitly opened. **Recommendation:** (a) or (b), formalized as an explicit non-goal note in the module doc now, so "just add wearables/wait for a paper" doesn't quietly become an implicit roadmap item — reopening this must be a deliberate, named, owner-approved decision each time, not a default outcome of more data existing.
