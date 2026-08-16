# Module 026 — Intervention Tracking Engine

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Active | false |
| Promotion required | true |
| Category | Physical Training System (`physicalTrainingSystem`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

## Intent
_One paragraph: what this module owns and what it must never do._

## Boundaries
- Does **not** auto-approve progression, medical, or board decisions.
- Does **not** expose athlete-level data to board / public aggregates without suppression rules.
- Does **not** invent metrics that are not stored by the platform.

## Dependencies
- Upstream: 
- Downstream: 
- Related original-25 capability: 

## Acceptance criteria
- [ ] Data model / tables named
- [ ] API surface listed (or explicitly none)
- [ ] Roles that may read / write
- [ ] Safety / refusal cases
- [ ] Audit events
- [ ] UI surface or "API-only"

## Implementation notes
_Scaffold only. Do not mark active until promotion review._

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-16 | external-research-ingestion | Owner-run external research reconciliation (Round 5, 2026-08-16): intervention execution/tracking is ranked the central missing learning primitive for the platform's evidence loop -- without a record of what intervention was actually run, outcomes cannot be attributed to anything. Raises this module's priority when its build turn comes; the Wave 9 audit confirmed no covering code exists today. |
| 2026-08-16 | claude-session | Slice 2 of 3 shipped: `pilot.intervention_executions` -- what was ACTUALLY delivered against a protocol version. Planned exposure/task-context are snapshotted from the protocol at start and no write path touches them again; actual facts live beside them. Adherence is an explicit five-state vocabulary (never a percentage), deviations must be named when claimed, stops must state a reason, and corrections are supersession with a required stated reason (all database constraints). Composite FK binds an execution's decision link to the SAME organization (unique index added on `shadow_decisions(organization_id, decision_id)`); decision-and-athlete match is module-enforced. A decision remains valid with zero executions; one protocol/decision legally spans many. Route `/api/pilot/coach/intervention-executions` (staff only) audits start/record/close/correct; page `/coach/intervention-executions` ("The Work") renders planned vs actual side by side. Slice 3 (typed evidence links + outcome/hypothesis/learning review) remains unbuilt; module stays DRAFT. |
| 2026-08-16 | claude-session | Slice 1 of 3 shipped (owner-directed keystone spec, 2026-08-16): `pilot.intervention_protocols` with drill-style supersession lineage (one active head per lineage, enforced by partial unique index; lineage-shape check both directions), structured exposure over the fixed 8-dimension vocabulary (dose scalars refused at the route), hypothesis-before-hindsight fields (`contradicting_evidence`, `alternative_explanations`) recorded at filing time, coach/admin route with audit events on create/revise/retire, and `/coach/intervention-protocols`. Slice 2 (executions: planned-vs-actual, adherence, deviations) and slice 3 (typed evidence links + hypothesis-result review) are NOT built. Module stays DRAFT per the spec's own rule: not DONE merely because tables exist -- promotion waits for the full tested workflow. |
