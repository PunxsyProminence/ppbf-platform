# Multi-AI Execution Plan (SHADOW Function-First)

## Objective
Ship SHADOW functionally complete with current visual design preserved.

## Operating Model
Use one AI per role to avoid overlap and rework.

1. Architect AI
- Defines scope, acceptance criteria, and task boundaries.
- Produces immutable ticket specs for the sprint slice.

2. Implementer AI
- Writes code only for assigned ticket.
- Must not expand scope.

3. Reviewer AI
- Performs adversarial review focused on regressions and security.
- Produces findings with severity and file references.

4. QA/Gate AI
- Runs build and gate scripts.
- Returns pass/fail evidence and logs.

## Canonical Build Order (Locked)

1. SHADOW Authority Layer
2. Athlete Domain (Athlete, Goal, Session, Coach Review)
3. SHADOW Audit Layer
4. SHADOW Intake Layer
5. SHADOW Telemetry Layer
6. SHADOW Analytics Layer
7. Everything Else

## Current Priority Backlog by Layer

### P0-L1 SHADOW Authority Layer
1. RBAC and action-level authorization hardening.
2. 12-role viewport isolation at UI and API boundaries.
3. Override authority rules and safety boundary checks.

### P0-L2 Athlete Domain
1. Athlete CRUD consistency and org scoping guarantees.
2. Goal/session/coach-review integrity and linkage validation.
3. Domain mutation guardrails and deterministic error handling.

### P0-L3 SHADOW Audit Layer
1. Immutable audit coverage for create/update/review/promote flows.
2. Correlated event IDs across intake and athlete domain actions.
3. Retrieval verification endpoints and audit completeness checks.

### P0-L4 SHADOW Intake Layer
1. Intake upload classification and queue reliability.
2. Approve/reject/promote hardening for edge and retry cases.
3. Document ownership binding and retrieval traceability.

### P1-L5 SHADOW Telemetry Layer
1. Readiness score engine and enforced lockouts.
2. Delta RPE lock with mandatory rationale enforcement.
3. Override trace events and safety interceptor telemetry.

### P1-L6 SHADOW Analytics Layer
1. Trend and risk aggregations over readiness/intake/domain events.
2. AI/ML-ready scoring interfaces with confidence/reason schema.
3. Explainability-ready output contracts.

### P2-L7 Everything Else
1. Peripheral portals and non-critical feature expansions.
2. Production alerts/synthetics and reporting enhancements.
3. Extended UX optimizations without changing established visual language.

## Standard Ticket Contract (Use in Every AI)

### Input
- Goal:
- In scope:
- Out of scope:
- Files allowed:
- Acceptance criteria:
- Required tests/gates:

### Output
- Changes made:
- Files touched:
- Commands executed:
- Evidence:
- Risks/open questions:

## Handoff Schema

### Architect -> Implementer
1. Ticket ID
2. Exact acceptance criteria
3. Allowed files list
4. Test/gate commands

### Implementer -> Reviewer
1. Diff summary
2. Why each change was needed
3. Evidence from build/tests

### Reviewer -> QA
1. Findings list (severity-ordered)
2. Required fixes
3. Regression risk checks

### QA -> Owner
1. Gate results
2. Final status (Pass/Fail)
3. Deployment recommendation

## Cadence Rules
1. 20-40 minute cycles per ticket.
2. No overlapping file ownership between AIs in same cycle.
3. Stop and rescope if a ticket fails gate twice.
4. Merge only with green gates and reviewer signoff.

## Required Commands (Current Repo)
Run from apps/web unless noted.

1. Build
`npm run build`

2. Core gate
`npm run gate:pilot`

3. Multi-org gate
`npm run gate:pilot:multiorg`

4. SHADOW intake gate
`npm run gate:pilot:shadow-intake`

## Day-1 Execution Sequence
1. Architect AI writes Ticket P0-L1-T1 (Authority Layer: RBAC hardening).
2. Implementer AI executes P0-L1-T1 only.
3. Reviewer AI reviews P0-L1-T1.
4. QA AI runs gates and reports.
5. Repeat per-ticket through P0-L1, then P0-L2, P0-L3, and P0-L4.

## Success Definition
1. All P0-L1 through P0-L4 tickets merged.
2. All gates green on production endpoint.
3. Domain and SSL active for intended public URLs.
4. SHADOW safety and role boundaries enforceable end to end.
