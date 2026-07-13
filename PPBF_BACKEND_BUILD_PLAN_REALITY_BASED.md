# PPBF Backend Build Plan (Reality Based)

Project: PPBF_BACKEND_READINESS_PROJECT
Mode: Architecture Planning Only
Step: 5 (Backend Build Plan)
Date: 2026-07-13

## Preconditions

Required prior artifacts:

- PPBF_CAPABILITY_MAP_REALITY_BASED.md (Step 1, approved + locked)
- PPBF_MISSING_CAPABILITY_REGISTER_REALITY_BASED.md (Step 1)
- PPBF_CAPABILITY_MAP_SELF_AUDIT.md (Step 1)
- PPBF_STEP1_APPROVAL_LOCK.md (Step 1 lock record)
- PPBF_CORE_ENTITY_MAP_REALITY_BASED.md (Step 2)
- PPBF_RELATIONSHIP_MAP_REALITY_BASED.md (Step 3)
- PPBF_DATAVERSE_BLUEPRINT_REALITY_BASED.md (Step 4)

## Guardrails

- Planning document only
- No backend code generation in this step
- No Dataverse table creation in this step
- No API implementation in this step
- No SQL implementation in this step
- No auth implementation change in this step
- No payment processing implementation in this step

## Build Strategy

Use phased delivery with hard gates.

- Phase 0: Decision closure and scope freeze
- Phase 1: Foundation entity rollout
- Phase 2: Core workflow services
- Phase 3: Governance and traceability hardening
- Phase 4: Controlled promotion of candidate entities
- Phase 5: Deferred capability enablement planning

## Phase 0: Decision Closure And Scope Freeze

Objective:

- Resolve all Step 4 handoff decisions before implementation begins.

Required decisions:

1. Confirm final logical names and ownership model for 12 entities.
2. Confirm candidate relationship promotions (promote vs defer list).
3. Confirm IntakeSubmission subtype strategy (unified vs split).
4. Confirm RevenueCommitment party strategy (participant/guardian/sponsor).
5. Confirm DecisionLogEntry polymorphic source policy.
6. Confirm release sequencing and non-disruptive migration approach.

Exit criteria:

- Decision log approved by Jason
- Scope lock for Phase 1 established

## Phase 1: Foundation Entity Rollout (Ready Set)

Scope (READY from Step 4):

- Person
- RoleAssignment
- ParticipantProfile
- SessionLog
- DevelopmentRoute
- Assignment
- ConsentRecord
- ProgressEntry
- DecisionLogEntry
- Capability

Outcomes:

- Stable core data backbone
- Role-based access scaffolding and governance trace path

Quality gates:

- Data model validation
- Access boundary validation
- Governance trace integrity checks

## Phase 2: Core Workflow Service Alignment

Objective:

- Align existing front-end flows with the foundation entity model.

Workflow areas:

- Program execution (participant/session/assignment/progress)
- Governance operations (capability state and decision trace)
- Consent and compliance capture baseline

Notes:

- This phase is alignment-first, not feature expansion.
- No roadmap capability activation in this phase.

## Phase 3: Governance And Traceability Hardening

Objective:

- Ensure all high-risk operations are traceable and role-bounded.

Focus areas:

- DecisionLogEntry coverage for critical actions
- RoleAssignment consistency for access checks
- Capability lifecycle integrity and approval trace

Exit criteria:

- Auditability checks pass
- Governance review passes

## Phase 4: Candidate Entity Promotion (Conditional)

Conditional scope (requires explicit approval):

- IntakeSubmission
- RevenueCommitment

Promotion policy:

- Promote only if linked process definitions are approved.
- Keep as deferred candidates if process definitions are incomplete.

Risk controls:

- Prevent premature schema expansion
- Prevent coupling to roadmap-only capabilities

## Phase 5: Deferred Capability Enablement Planning

Deferred capability group (from Step 1 lock):

- AI/ML Video Analysis
- Video Review Intelligence
- Performance Analytics Intelligence
- Grant Compliance Intelligence
- Automated Publication Workflow
- Automated Compliance Monitoring
- Closed-Loop Progression Intelligence

Policy:

- Keep as roadmap/front-end visibility only.
- Create separate enablement charters before backend promotion.
- No direct dependency from current canonical model.

## Release Waves

Wave A (Foundation):

- Person, RoleAssignment, ParticipantProfile, DevelopmentRoute, Assignment

Wave B (Execution + Compliance):

- SessionLog, ProgressEntry, ConsentRecord

Wave C (Governance):

- Capability, DecisionLogEntry

Wave D (Conditional promotions):

- IntakeSubmission, RevenueCommitment (only after approval)

## Environment Promotion Path

- Dev -> Test -> Pre-Prod -> Prod

Each promotion requires:

1. Schema/model validation checks
2. Access boundary checks
3. Regression checks for existing front-end flows
4. Governance signoff

## Risks And Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Scope creep from missing capabilities | High | Enforce deferred capability exclusion list |
| Premature promotion of candidate entities | High | Phase 4 explicit promotion gate |
| Role boundary leakage | High | RoleAssignment validation + access audits |
| Governance trace gaps | Medium-High | Mandatory DecisionLogEntry instrumentation policy |
| Drift between front-end placeholders and backend rollout | Medium | Keep capability state matrix synchronized each wave |

## What Must Not Be Built Yet

- AI/ML inference services
- Automated publication engines
- Compliance automation engines
- Prediction/recommendation engines
- External competition integrations
- Payment processor implementations

These remain outside this Step 5 execution boundary unless separately approved.

## Deliverables Checklist (Step 5 Planning Complete)

- Phase plan and wave plan defined
- Ready vs conditional scope defined
- Risk and mitigation map defined
- Deferred capability policy defined
- Promotion gates defined

## Approval Gate

This Step 5 backend build plan is ready for Jason approval before any backend implementation work begins.
