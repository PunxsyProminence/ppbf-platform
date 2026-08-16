# Engine Unlock Proposal — Module 031: Mobility / Range-of-Motion Engine

| Field | Value |
|---|---|
| Status | PROPOSAL — owner approval required, no code changes made |
| Module stub | `docs/capabilities/modules/031-mobility-range-of-motion-engine.md` |
| Prepared against | current `infra/azure/*.sql` schema, read-only |
| Classification (AGENT_KERNEL.md) | **OWNER_DECISION** — this engine cannot honestly unlock on the schema as it stands, and the fix is a medical/measurement-instrument decision, not an engineering one |

---

## Headline finding, stated plainly

**This engine cannot unlock today, and cannot unlock from any volume of existing data, because the platform does not yet have a place to put a Range-of-Motion measurement.**

- `pilot.assessments` (`infra/azure/pilot_slice_postgres.sql:313-324`) stores `assessment_type text` and `result jsonb not null default '{}'::jsonb` — free text and an unstructured blob. There is no `joint`, `movement`, `side` (left/right), `unit` (degrees), or `instrument` column, and nothing constrains what goes inside `result`.
- `pilot.assessment_protocols` (`infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql:30-59`) is the one table built to carry a measurement's protocol metadata (`measure_kind`, `quality_measured`, `protocol_summary`, `equipment_needed`, `reliability_status`, `validity_status`, `evidence_class`, `minimal_detectable_change`) — but no row of `measure_kind = 'physical_test'` for any ROM movement (shoulder flexion, hip flexion, ankle dorsiflexion, etc.) is defined or seeded anywhere in this repository. A repo-wide search for `range of motion`, `goniomet`, `ROM`, `dorsiflex`, `flexion` finds nothing outside the module stub itself.
- There is therefore no assessment on this platform, for any athlete, in any organization, that the system can currently identify as a ROM measurement at all — regardless of how many `pilot.assessments` rows exist.

Everything below describes what this engine could honestly show **after** that instrument gap is closed by an owner/medical decision. Until then, section (c) — LOCKED STATE — is the module's entire truthful behavior.

---

## (a) What it computes / shows

Honesty doctrine applies in full: no invented scores, no composite "mobility index," no dose scalar, no percentile, no color-graded rating. Every number shown must trace to a specific recorded row.

Once a real ROM protocol and real measurements exist (see prerequisites below), this engine may show, for **one athlete, about that athlete only**:

- The athlete's own recorded ROM values over time, one series per `(protocol_id, protocol_version)` — i.e., per specific joint/movement/instrument definition — each point showing: measured value, unit (as defined by the protocol, e.g. degrees), date administered (`pilot.assessments.administered_on`), who administered it (`assessor_role`), and which protocol version it was measured under.
- The numeric delta between one measurement and the immediately prior measurement under the **same** `protocol_id`/`protocol_version` (a subtraction of two real numbers, not a derived "score").
- Whether a retest is due, read directly from `pilot.assessment_protocols.retest_interval_days` / `retest_after_training_hours` against `pilot.assessments.administered_on` / `training_hours_at_administration` — a factual due/not-due state, never a countdown styled as pressure.
- An explicit `UNKNOWN` / "not enough data" state whenever: no ROM protocol exists for the org, zero measurements exist for the athlete, only one measurement exists (no delta is computable), the most recent measurement used a different, non-comparable protocol version, or the reliability/validity fields on the protocol are still at their default unvalidated state (`reliability_status = 'UNVALIDATED - PPBF MUST ESTABLISH'`, `validity_status = 'UNKNOWN'`) — in which case any displayed value must be labeled as unvalidated measurement, not as ground truth.
- Any active `pilot.training_holds` row (`scope`, `reason_category`, `athlete_explanation`) or non-current `pilot.medical_intake.clearance_status` covering the athlete must be surfaced **alongside** the measurement as a fact ("a training hold was active on this date"), never silently smoothed out of a trend line and never used by this engine to compute or imply a return-to-training clearance — that determination belongs to `pilot.return_to_training_plans`/`return_to_training_steps` and a qualified clinician, per the existing safety-flags doctrine (`infra/azure/pilot_slice_postgres_safety_flags_migration.sql:36-44`).

This engine must never:
- Estimate ROM from video. Per-skill video scoring is owner-parked (`docs/current/ACTIVE_WORK.md`, `BACKLOG-video-skill-scoring`, "shipping machine scores about minors' athletic ability without proven accuracy is the risk being refused"). Nothing in that parking decision is scoped to skill-video only in a way that would make ROM-from-video safer; the same refusal applies here.
- Show any cross-athlete comparison, ranking, percentile, or "average for this age group" — no normative reference table exists in this schema, and the hard walls forbid it even if one did.
- Infer, shorten, or clear a medical hold or rest period. Only a human (`return_to_training_plans.entered_by_account_id`, `training_holds.lifted_by_account_id`) does that.

---

## (b) Data prerequisites — exact, checkable, per athlete and per org

### 0. Instrument prerequisite (blocks everything else)
- At least one **owner/medical-approved** row in `pilot.assessment_protocols` with `measure_kind = 'physical_test'`, `quality_measured` naming a specific joint/movement/side (e.g. "shoulder flexion, right, goniometer"), `active = true`, and a real `protocol_summary`/`equipment_needed`. This does not exist today. Creating it is a medical/measurement-instrument decision (see Open Questions), not an engineering task — no code change can manufacture a valid protocol definition.

### Per athlete
- **≥ 1** row in `pilot.assessments` where `protocol_id`/`protocol_version` reference a ROM-tagged row in `pilot.assessment_protocols` above, `administered_on` populated, and `result` contains a numeric value in the unit the protocol declares. (Locked-but-partial state: exactly 1 such row — a single reading, no trend.)
- **≥ 2** such rows, on distinct `administered_on` dates, under the **same** `protocol_id`/`protocol_version`, to compute any delta/trend for that athlete on that specific joint/movement. Different `protocol_version` values do not count toward each other (a version bump means the measurement definition changed).
- No structural check currently exists to verify that `result` actually holds a number in the correct unit — `result` is unconstrained `jsonb`. Until a write-time validator is built, "measured value present in the correct unit" is a data-quality prerequisite that must be verified by the recording workflow, not assumed from row existence.
- Awareness (not blocking) of any `pilot.training_holds` row for the athlete with `status = 'active'` and `reason_category = 'medical'`, and of `pilot.medical_intake.clearance_status` — both must be checked and displayed alongside any measurement, per (a).

### Per organization
- **≥ 1** active ROM protocol row (§0) scoped to that `organization_id`.
- A count, for board/org display only, of **how many athletes have ≥ 2 qualifying measurements** — a coverage number, never a leaderboard, never naming which athletes.
- If this engine is wired into the platform's existing unlock-gate substrate (`pilot.shadow_feature_thresholds` / `pilot.shadow_feature_unlock_snapshots`, `infra/azure/pilot_slice_postgres.sql:540-567`), an org-level row of `feature_key` (e.g. `mobility_rom_engine`) with a `metric_key` and `min_value` the owner sets — see Open Question 3.

### Timespan
- No fixed calendar window is proposed here. `assessment_protocols.retest_interval_days` / `retest_after_training_hours` already exist specifically because ROM (like CMJ) has a sensitivity-to-change interval that a calendar cannot dictate generically — the module comment in `pilot_slice_postgres_assessment_protocols_migration.sql:9-12` is explicit that re-testing too frequently reads as improvement when it is measurement error. Whatever interval applies to the chosen ROM protocol should set the "too soon to show a new trend point" floor, not an arbitrary number invented here.

---

## (c) Locked state

Before the instrument prerequisite (§0) is met, org-wide, the module must show — truthfully, with no fabricated progress framing:

> **Mobility / Range-of-Motion — not yet available.**
> This organization has not defined a Range-of-Motion measurement protocol. 0 of 0 required protocols exist. This engine cannot unlock until a licensed medical/athletic-training authority defines one (owner decision pending) and measurements begin being recorded against it.

After a protocol exists but an individual athlete lacks measurements:

> **Mobility / Range-of-Motion — locked for [athlete].**
> 0 of 2 measurements recorded under [protocol name, v[N]]. A single measurement will show the most recent reading only; a second measurement under the same protocol version is needed before any change over time can be shown.

No percentage bar styled as near-complete, no streak framing, no "almost there" copy — these are minors; the hard walls forbid variable-reward/FOMO framing regardless of how close the real counts are. The locked message is a literal restatement of the real counts against the real prerequisite, nothing more.

---

## (d) What unlocks

### Athlete level — the athlete's own record only, never cross-athlete
- Their own ROM measurement history, one series per protocol/version, with date, value, unit, assessor role, and protocol name/version.
- Their own delta between consecutive same-protocol-version measurements.
- Their own retest-due status.
- Any training hold / non-current medical clearance overlapping their measurement history, shown as fact.
- **Forbidden at this level, structurally per the hard walls**: any teammate's value, any team/org average, any percentile, any rank, any "compared to other boxers your age" framing. Nothing in the schema (no normative table, no cohort-average view for ROM) supports this anyway.

### Org level
- Coverage count: athletes with ≥ 2 qualifying measurements vs. total roster — a number, not a list of names, and not broken down in any way that lets a board member reverse-engineer an individual's status (per the module stub's own boundary: "Does not expose athlete-level data to board / public aggregates without suppression rules").
- Count of overdue retests org-wide (protocol-driven `due_on` passed with no matching `administered_on`), sourced from `pilot.assessments.due_on` / `pilot.data_collection_requests` (`infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql:101-152`) — operational visibility for coaches, not a diagnostic claim.
- **Forbidden**: any org-level leaderboard, any ranking of coaches by "how mobile their athletes are," any aggregate that could be un-suppressed to a single athlete in a small organization.

---

## (e) Open questions for the owner

1. **What ROM measurement instrument/protocol should PPBF adopt?** The schema has a place to record a protocol (`pilot.assessment_protocols`) but no defined ROM protocol exists.
   - (a) A validated goniometric battery, administered only by a licensed PT/athletic trainer.
   - (b) Coach-administered goniometer readings, with documented training, accepted at `reliability_status = 'UNVALIDATED - PPBF MUST ESTABLISH'` until a reliability study runs (the platform already models this honestly — see `assessment_protocols.reliability_status` default).
   - (c) Defer entirely; keep this module dormant/PARKED until a sports-medicine partner is engaged.
   - (d) Some other instrument the owner specifies (inclinometer app, physician referral only, etc.).

2. **Which joints/movements are in scope for a boxing program specifically?**
   - (a) A minimal, boxing-injury-relevant set (shoulder flexion/extension/rotation, hip flexion, ankle dorsiflexion).
   - (b) A comprehensive general-athletic ROM battery.
   - (c) Owner/medical staff specify the exact list; engineering seeds only what's specified.

3. **What minimum measurement count/timespan should gate unlock, and should it be owner-configurable?**
   - (a) 1 measurement unlocks a "recorded" (no-trend) state; 2 unlocks a trend.
   - (b) Require 2 measurements before the module shows anything at all, to avoid any single-point display.
   - (c) Make the threshold a per-org configurable value via the existing `pilot.shadow_feature_thresholds` table rather than hard-coding a number in this proposal.

4. **How should an active medical hold interact with display, given `pilot.training_holds` has no body-region/joint column** (only `scope: all_training/contact_only/conditioning_only` and free-text `reason_text`)?
   - (a) Any active `reason_category = 'medical'` hold suppresses new ROM trend display for that athlete until lifted, regardless of which joint.
   - (b) Show the data regardless, but flag the hold prominently and leave clinical interpretation to a human.
   - (c) Add a body-region field to `training_holds`/`return_to_training_plans` as a separate schema-change ticket before this engine ships, so the hold can be matched to the specific joint being measured.

5. **Should ROM measurements ever auto-suggest linkage into the intervention-evidence ledger** (`pilot.intervention_evidence_links.source_kind = 'assessment'`) for mobility-focused `intervention_protocols`?
   - (a) Fully manual — staff decide what to link, exactly as every other evidence source works today.
   - (b) System suggests candidate links for human confirmation only; never auto-links (consistent with the platform's existing "deterministic gap suggestions, coach confirms or dismisses" pattern noted in `docs/current/ACTIVE_WORK.md`).

---

### Sources cited
- `infra/azure/pilot_slice_postgres.sql` — `pilot.assessments` (:313-324), `pilot.training_holds` (:789-822), `pilot.medical_intake` (:392-407), `pilot.shadow_feature_thresholds`/`pilot.shadow_feature_unlock_snapshots` (:540-567)
- `infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql` — `pilot.assessment_protocols` (:30-59), `pilot.data_collection_requests` (:114-152)
- `infra/azure/pilot_slice_postgres_safety_flags_migration.sql` — `pilot.safety_flags`, `pilot.return_to_training_plans`/`steps`
- `infra/azure/pilot_slice_postgres_intervention_evidence_migration.sql` — `pilot.intervention_evidence_links`
- `docs/current/ACTIVE_WORK.md` — `BACKLOG-video-skill-scoring` parked-work entry
- `docs/capabilities/modules/031-mobility-range-of-motion-engine.md` — module stub and its boundaries
