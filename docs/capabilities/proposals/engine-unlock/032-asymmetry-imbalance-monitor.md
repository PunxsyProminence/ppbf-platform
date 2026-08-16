# Engine Unlock Proposal — Module 032: Asymmetry / Imbalance Monitor

| Field | Value |
|-------|-------|
| Status | PROPOSAL (owner approval requested) — no code changes made |
| Module stub | `docs/capabilities/modules/032-asymmetry-imbalance-monitor.md` |
| Category | Physical Training System (`physicalTrainingSystem`) |
| Prepared against | current `infra/azure/*.sql` schema, read-only |

This document proposes the honesty gate that must be satisfied before Module 032
is allowed to compute or display anything to a user. It does not propose an
implementation, a UI, or an API. Nothing here is authorization to build; it is
the basis for an owner decision on what the module may and may not do.

---

## Schema reality check (read first) — the module cannot unlock as named

The stub's name — "Asymmetry / Imbalance Monitor" — presumes the platform can
tell left from right (or one limb/side from another). **It cannot. No table in
`infra/azure/*.sql` records laterality, side, limb, or a body region at all.**
This was checked directly, not assumed:

- `pilot.training_attempts` — `metric_kind` is one of `reps`, `time_seconds`,
  `distance_m`, `load_kg`, `rounds`, `hold_seconds`. There is no `side`,
  `limb`, `laterality`, or paired-exercise column. `note` is free text
  (`note text not null default ''`) — a coach *could* type "left arm" into
  it, but that is unstructured prose, not a queryable field, and this
  proposal explicitly rejects building a text-parsing heuristic to manufacture
  a laterality signal the schema was never designed to carry (see Open
  Question 1).
- `pilot.drills` — `name`, `category`, `focus`, `cues text[]`, `difficulty`.
  No structured unilateral/bilateral flag or body-region taxonomy a
  `training_attempts.context_id` could join through to infer sidedness.
- `pilot.assessments` / `pilot.assessment_protocols` — `result` is a bare
  `jsonb` blob with no enforced shape; `assessment_protocols` (`name`,
  `measure_kind`, `quality_measured`, `protocol_summary`, …) has no side/limb
  column. A protocol author could put left/right sub-keys inside the `result`
  JSON by convention, but nothing in the schema enforces, validates, or even
  names that convention today — there is no protocol on file that does this.
- `pilot.readiness` — `score numeric`, `category text`, `measured_at`. A
  whole-body/whole-person daily reading; structurally incapable of
  representing "left knee felt worse than right knee."
- `pilot.activity_log` — `activity_domain`, `duration_minutes`, `rpe`. Dose
  and domain only, no body-region or side dimension.
- `pilot.intervention_protocols` / `intervention_executions` /
  `intervention_evidence_links` / `intervention_outcome_reviews` — exposure
  is a `jsonb` dimension map and evidence is typed by **temporal role**
  (`baseline` / `during_intervention` / `immediate_post` / `retention` /
  `transfer` / `counterevidence` / `adverse_response` / `context`), never by
  body side. `adverse_response` exists and could hold a note about an
  asymmetric complaint, but it is prose, not a measurement.
- `pilot.safety_flags` — `flag_code` is free text, not an enum, so a new code
  (e.g. `asymmetry_observed`) *could* be added without a migration. But per
  `pilot_safety_flags_medical_human_only`, any flag_code that reads as a
  medical determination (schema names `medical_clearance_missing`,
  `concussion_rest_period`, `rtp_not_cleared`) may only be
  `triggered_by = 'human_entry'` — the system is structurally forbidden from
  raising that class of flag itself. This is directly relevant below.
- `pilot.safety_escalations` — `escalated_to_role` is constrained to
  `('coach', 'organization_admin', 'admin')`. **There is no `sports_medicine`,
  `physician`, or `athletic_trainer` role in the escalation vocabulary.**
  `pilot.medical_intake` exists (`physician_name`, `physician_phone`,
  `clearance_status`, `notes`) but is a static intake record, not an inbound
  referral queue — nothing writes a new medical concern *into* it from a
  training-side signal.

**Conclusion: Module 032 cannot unlock, at any tier, on the current schema.**
There is no laterality-capturing instrument anywhere in `infra/azure/*.sql`.
Building this module today would force one of two dishonest shortcuts: (1)
parsing free-text `note`/`result` fields to guess at sidedness, which is
exactly the kind of invented-from-nothing inference the honesty doctrine
forbids, or (2) inventing a synthetic "imbalance score" with no recorded
basis, which the Hard Walls explicitly prohibit. Neither is proposed. This
document instead specifies the exact instrument that would need to exist
before any unlock gate could be evaluated at all, and the routing gap that
would still need an owner decision even after that instrument exists.

---

## (a) What it computes / shows

**Nothing, on the current schema.** Once (and only if) a laterality-capturing
instrument is added (see (b)), this module may show:

- A **direct comparison of the athlete's own recorded values** for the same
  metric/test administered on each side, on dates the athlete actually
  performed it — e.g., "Left: 14 reps (2026-06-01) → 18 reps (2026-07-15).
  Right: 22 reps (2026-06-01) → 23 reps (2026-07-15)." Nothing summarized
  into a single "imbalance %" beyond a plain, labeled difference between two
  real recorded numbers, both shown alongside the number itself.
- The **count and span** of paired left/right observations actually on file
  ("6 paired administrations over 54 days"), never a rate or trend line the
  schema does not store enough points to support.
- An explicit **UNKNOWN** state for every metric/test where only one side has
  ever been recorded, or where side was not captured for a given row — shown
  as "side not recorded for this entry," never defaulted to "even" or
  omitted silently.

**Never shown, at any unlock state:**
- Any injury-risk score, likelihood, prediction, or "at risk" label of any
  kind. This monitor may report an observed numeric difference between two
  recorded values. It may never imply what that difference means for future
  injury, tissue health, or pathology — that is a clinical judgment this
  platform does not make and this module must not simulate.
- Any word implying diagnosis or pathology ("weakness," "deficit,"
  "compensation pattern," "at-risk limb") in generated text. Output is
  restricted to the measured quantities themselves ("left: X, right: Y,
  difference: Z") and the athlete's own history of those quantities.
- Any cross-athlete comparison, percentile, or "how does my asymmetry compare
  to teammates" surface, at any role or tier — forbidden outright, not a
  later phase.
- Any composite "imbalance score" combining multiple metrics/tests into one
  number.

**Explicit UNKNOWN states required:**
- No laterality instrument exists yet at all → the module reports "This
  monitor requires side-specific recording, which is not yet captured by any
  test or drill in this organization" — not a locked progress bar, an
  UNKNOWN.
- A metric/test has recordings for only one side → "no right-side [or
  left-side] recordings on file for this test" rather than assuming parity.
- A single pair of observations exists → shown as a single comparison point,
  explicitly labeled as insufficient for a trend ("1 paired observation — a
  trend requires more than one").

---

## (b) Data prerequisites

**The first prerequisite is not a count — it is the existence of a
laterality-capturing instrument at all**, which does not exist in
`infra/azure/*.sql` today. Everything below is conditional on that instrument
being added first, through its own separate, explicitly-approved schema
change (this proposal does not design that change; see Open Question 1).

### Prerequisite 0 (blocking, precedes all others)
A structured way to record which side/limb a `training_attempts` row or
`assessments` administration refers to — e.g., a `side` column on
`pilot.training_attempts` constrained to a small vocabulary (`'left'`,
`'right'`, `'bilateral'`, `'not_applicable'`), and/or a `side`-bearing
sub-structure inside a specific `assessment_protocols` catalog entry's
`result` shape, with that shape actually documented and enforced by the
writing module (not just "developers agree to nest it under a key"). Until
this exists in the live schema, every gate below reads zero rows by
construction and the module has nothing to compute.

### Per athlete (once Prerequisite 0 exists)

| # | Requirement | Real source (post-instrument) |
|---|---|---|
| 1 | ≥ 1 recorded value for **both** sides of the same metric/test, i.e. at least one `left` and one `right` row for the same `metric_kind` (or same `assessment_protocols.protocol_id`) | `training_attempts.side`/`metric_kind`/`athlete_id`, or `assessments.protocol_id` + side-bearing `result` |
| 2 | ≥ 2 paired left/right administrations over time to show change rather than a single snapshot comparison | same, grouped by administration date |
| 3 | For assessment-based pairs, the retest satisfies the protocol's own stated interval (`retest_interval_days` / `retest_after_training_hours`), per the existing `pilot.assessment_protocols` retest-integrity rule already enforced for Module 017 — a same-day or too-soon retest is measurement noise, not a trend | `assessment_protocols.retest_interval_days`, `.retest_after_training_hours`; `assessments.training_hours_at_administration` |

### Per organization (once Prerequisite 0 exists)

| # | Requirement | Real source |
|---|---|---|
| 1 | ≥ 1 `assessment_protocols`/drill-linked instrument in the org that actually captures side, with `active = true` | post-instrument catalog flag |
| 2 | ≥ 5 distinct athletes each independently clear the per-athlete gate above (not "5 rows total," to prevent an org-wide view built on one heavily-tested athlete) | grouped by `organization_id`, `athlete_id` |

**The single hardest prerequisite in this whole module is Prerequisite 0.**
Every other row in this table is a straightforward count; Prerequisite 0 is a
schema change plus a change to whatever coach-facing capture flow records
`training_attempts`/`assessments`, and it does not exist today in any form —
not partially, not as an unused column, not as a convention inside a `jsonb`
blob. No amount of ordinary floor logging under the current schema will ever
clear it.

---

## (c) Locked state

Because Prerequisite 0 does not exist, the module's locked state is not "X of
Y attempts recorded" — it is an honest statement that the instrument itself
is missing:

> Asymmetry / Imbalance Monitor — not available.
> This monitor requires recording which side (left/right) a test or attempt
> applies to. No test or drill in this organization currently captures that.
> There is nothing a coach or athlete can log today that will unlock this
> view — the gap is in what the platform records, not in how much training
> has happened.

If Prerequisite 0 is later approved and built, locked state becomes the
familiar honest-progress form used elsewhere in this register: real counts of
paired left/right observations on file per athlete, per test, with dates —
never a percentage framed as achievement, never "almost there" language, no
countdown or streak, per the Hard Walls (this module's users are minors).

At org level, locked state (pre- or post-instrument) shows only factual
counts — how many instruments capture side, how many athletes have cleared
their own gate so far as a number — never a list of which athletes, which
would leak athlete-level standing into an org-facing surface before unlock.

---

## (d) What unlocks

**At athlete level** (visible only to the athlete, their guardian, and staff
who already have standing access to that athlete's record):
- That athlete's own paired left/right values for a given metric/test, over
  their own recorded history only — a factual difference between two of
  their own numbers, with both source rows' dates shown.
- No comparison to any other athlete, teammate, cohort average, or normative
  range, at any unlock tier, under any framing. This is a permanent wall for
  this module, identical in force to the wall Module 017 already carries for
  athleticism — **leaderboards and cross-athlete comparison are forbidden
  outright, not a later phase.**
- No inference language. The most the UI may ever say is the measured
  difference itself ("left 14, right 22, difference 8") — never "you have an
  imbalance," never "your left side is weaker," never any framing that reads
  as a clinical or predictive claim about a minor's body.

**At org level** (roles already permitted org-wide views per
`pilot.organization_memberships`):
- Aggregate counts only, suppressed below an owner-decided minimum-N: e.g.,
  "X of Y active athletes have ≥ 1 paired left/right test on file," never a
  per-athlete breakdown inside the aggregate.
- Which instruments in the org's catalog capture side, and how many are
  active — metadata about tooling, not about any child, so safe pre-gate.
- **What this module must never unlock into, at any level:** an
  injury-risk flag, a referral decision, or an automated escalation. If an
  observed difference is large enough that a human believes it warrants
  clinical attention, the pathway is a human-entered `pilot.safety_flags` row
  (`flag_class = 'external_rule'` or a new human-entered code) or a manual
  note in `pilot.medical_intake`, exactly as `pilot_safety_flags_medical_human_only`
  already requires for every existing medical-determination flag code. This
  module supplies the observation a human reviews; it must never itself
  decide the observation means something medical, and it has no schema path
  to notify sports medicine automatically even if the owner wanted that (see
  Open Question 3).

---

## (e) Open questions for the owner

**1. Should PPBF build the laterality-capturing instrument (Prerequisite 0)
at all, and if so, where does side belong structurally?**
- (a) Add a constrained `side` column directly to `pilot.training_attempts`
  (`'left' | 'right' | 'bilateral' | 'not_applicable'`), the least invasive
  option since that table already carries the attempt-level metric spine.
- (b) Require side to live inside a specific, schema-documented shape within
  `assessment_protocols`/`assessments.result` for named unilateral tests only
  (e.g., single-leg hop, single-arm hang), keeping ordinary bilateral
  training attempts untouched.
- (c) Do both, scoped to different use cases (attempts for drill-level
  unilateral work, assessments for formal single-limb tests).
- (d) Do not build this instrument; retire or permanently park Module 032's
  stub, since without it the module can never be more than this document.

**2. If free-text notes already mention a side (e.g., a coach writes "left
arm" in `training_attempts.note`), should that ever be surfaced by this
module before Prerequisite 0 exists?**
- (a) No — never parse or infer structure from free text for this purpose;
  wait for a real structured field, full stop.
- (b) Surface such notes verbatim as unstructured context alongside other
  data, clearly labeled "coach's note, not a structured recording," but never
  aggregate or compare them.
- (c) Retroactively backfill a structured `side` value from historical notes
  via a one-time human-reviewed pass (a data-entry project, not an
  algorithmic inference), after which only structured data is ever used
  going forward.

**3. Given `pilot.safety_escalations.escalated_to_role` has no
`sports_medicine`/clinician option today, how should an athlete/guardian- or
coach-noticed asymmetry that looks concerning actually reach a medical
reviewer?**
- (a) Add a new `escalated_to_role` value (e.g., `'medical_referral'`) so a
  human-entered escalation can name a clinical reviewer explicitly — a schema
  change scoped narrowly to that one constraint.
- (b) Keep escalation routing to existing roles only (`coach` /
  `organization_admin` / `admin`) and rely on that staff member to make the
  offline referral to a physician, exactly as `pilot.medical_intake`'s
  `physician_name`/`physician_phone` fields already assume today.
- (c) Treat this as entirely out of scope for Module 032 — the module shows
  the observation; any referral pathway is a separate safeguarding/medical
  workflow decision unrelated to this engine, decided elsewhere.

**4. What minimum-N suppression floor applies to org-level aggregate views,
consistent with (or independent of) whatever floor the owner sets for other
engine-unlock modules (e.g., Module 017)?**
- (a) Use the same fixed floor decided for Module 017, for consistency across
  the register.
- (b) Set an independent, likely higher, floor for this module specifically,
  since a body-region/asymmetry observation is more sensitive than a generic
  athleticism metric even without a diagnostic claim attached.
- (c) Defer any org-level view for this module entirely, shipping
  athlete-level-only even after Prerequisite 0 exists, given the sensitivity
  of body-asymmetry data about minors.
