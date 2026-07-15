# SHADOW Phase 1 Hardening Checklist

Purpose: convert SHADOW doctrine into an execution-ready hardening sequence without building unrelated features.

Scope:

- Authority
- Audit
- Telemetry
- Intake
- Routing
- Promotion

Out of scope:

- AI and ML implementation
- video and sensor pipelines
- dashboard expansion
- broad frontend redesign

## Execution Order

1. Authority
2. Audit
3. Telemetry
4. Intake
5. Routing
6. Promotion

## 1) Authority Hardening

Goal: no operational domain write bypasses SHADOW policy checks.

Checklist:

- [x] Define a centralized SHADOW authority-check service contract.
- [ ] Require authority checks before all managed writes (athlete, goal, session, coach review, intake promotion).
- [x] Enforce role boundary checks and organization boundary checks in one common flow.
- [x] Define blocked-action behavior and blocked-action event emission.
- [x] Add test cases for allowed and forbidden actions per role.

Exit criteria:

- every write route calls the shared authority-check path
- denied operations return consistent error shape
- blocked operations are auditable

## 2) Audit Hardening

Goal: all meaningful writes and control decisions are auditable with canonical SHADOW event semantics.

Checklist:

- [x] Introduce canonical SHADOW event names as additive mapping layer.
- [x] Ensure create, update, route, promote, and reject operations emit canonical events.
- [x] Include actor, role, organization, entity, decision context, and reason payload.
- [ ] Ensure audit insert is part of write transaction boundary where required.
- [x] Add retrieval filters by organization and event class.

Exit criteria:

- canonical event mapping exists
- all managed write paths emit canonical events
- audit retrieval supports governance review

## 3) Telemetry Hardening

Goal: capture operational telemetry independently from audit events.

Checklist:

- [x] Add dedicated telemetry write path and table design (documentation and migration plan first).
- [x] Define telemetry event envelope (event name, actor, org, source, context, timestamp).
- [ ] Emit telemetry for safety gate triggers, role boundary blocks, and operational warnings.
- [ ] Separate telemetry retention policy from immutable audit retention.
- [x] Add privacy scrub rules for sensitive payload fields.

Exit criteria:

- telemetry write path exists separately from audit path
- safety and boundary signals generate telemetry reliably
- retention and redaction rules are defined

## 4) Intake Hardening

Goal: no intake item becomes trusted knowledge without classification, validation, routing, and review state.

Checklist:

- [x] Enforce intake lifecycle states: received, classified, validated, routed, reviewed, stored.
- [x] Standardize intake classification labels and confidence markers.
- [x] Ensure each intake item has source metadata and verification status.
- [ ] Ensure invalid or insufficient intake routes to manual review.
- [x] Add intake state transition tests and invalid-transition guards.

Exit criteria:

- lifecycle states are explicit and enforced
- each intake item has source and verification fields
- invalid transitions are blocked and audited

## 5) Routing Hardening

Goal: routing decisions are explicit, reproducible, and auditable.

Checklist:

- [ ] Define routing policy registry (by type, source, verification, risk class).
- [ ] Persist route decision records with reason and policy version.
- [ ] Distinguish auto-route from manual-route decisions.
- [ ] Add fallback route for unknown or low-confidence items.
- [ ] Add route decision tests for core intake classes.

Exit criteria:

- route decision record exists for each routed intake item
- policy basis is traceable
- unknowns are safely handled

## 6) Promotion Hardening

Goal: promotion into operational truth requires authorized human decision and complete trace.

Checklist:

- [x] Restrict promotion authority to approved human roles by policy.
- [x] Persist promotion request, approval or rejection, and rationale.
- [ ] Require source verification threshold before promotion eligibility.
- [x] Ensure promoted records carry source and promotion lineage fields.
- [ ] Add rollback or correction workflow for erroneous promotions.

Exit criteria:

- no promotion occurs without authorized human approval
- each promotion has lineage, rationale, and audit trail
- corrections can be applied safely and audibly

## Cross-Cutting Requirements

### Safety Gates

- [ ] readiness and Delta RPE gate events produce audit and telemetry signals
- [ ] unsafe operations are blocked with explicit reason
- [ ] override actions require rationale and are traceable

### Multi-Gym Reservation

- [x] organization_id required in all SHADOW spine records
- [ ] gym_id and program_id reserved as nullable fields for staged rollout
- [ ] no single-gym assumptions introduced in new contracts

### Source Confidence

- [ ] define source confidence taxonomy: verified, partially_verified, unverified, unknown
- [ ] apply taxonomy to intake and knowledge-bearing outputs

### Testing and Verification

- [x] add route-level authorization tests
- [x] add event emission tests
- [x] add intake lifecycle and promotion gate tests
- [x] add organization-boundary regression tests

## Done Definition for Phase 1

Phase 1 is done when:

1. Managed writes are authority-gated by a shared SHADOW path.
2. Canonical SHADOW events are emitted for core operations.
3. Telemetry and audit paths are separated and reliable.
4. Intake lifecycle and routing decisions are explicit and enforced.
5. Promotion requires authorized human approval with traceable rationale.
6. Multi-gym reservation path is protected by schema and contracts.

## Suggested Ticket Seeds

1. P0-L1-T1: Introduce shared SHADOW authority-check service and enforce in managed write routes.
2. P0-L1-T2: Add canonical event mapping and update audit emitter usage.
3. P0-L3-T1: Add SHADOW telemetry write path and envelope.
4. P0-L4-T1: Enforce intake lifecycle transitions and source confidence fields.
5. P0-L4-T2: Persist routing decision records with policy version.
6. P0-L4-T3: Harden promotion lineage and rationale requirements.
