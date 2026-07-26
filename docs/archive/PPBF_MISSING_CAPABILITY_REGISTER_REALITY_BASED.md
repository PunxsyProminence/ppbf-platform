# PPBF Missing Capability Register (Reality Based)

Project: PPBF_BACKEND_READINESS_PROJECT
Mode: Architecture + Front-End Readiness Audit Only
Date: 2026-07-13

## Purpose

This register is the required gap ledger that must be completed before Core Entity Map creation is allowed.

Status: COMPLETE

## State Legend

- MISSING: no implemented capability workflow is present.
- PLACEHOLDER: visible as planned in front-end, but non-operational.
- PARTIAL-HIGH-RISK: partially present but missing critical execution depth.

## Register

| Capability | Domain | Current State | Evidence | Front-End Visibility Required | Backend Mapping Risk If Ignored | Gate Recommendation |
|---|---|---|---|---|---|---|
| AI/ML Video Analysis | Intelligence | MISSING | Capability map findings + operations capability radar | Show Planned Capability button only | High | Block Core Entity Map until scoped |
| Video Review Intelligence | Coach/Intelligence | PLACEHOLDER | Operations capability radar | Show Planned Capability button only | High | Keep as roadmap candidate |
| Performance Analytics Intelligence | Athlete/Coach | PLACEHOLDER | Operations capability radar | Show Planned Capability button only | High | Keep as roadmap candidate |
| Grant Compliance Intelligence | Revenue/Governance | PLACEHOLDER | Operations capability radar | Show Planned Capability button only | High | Keep as roadmap candidate |
| Automated Publication Workflow | Governance/Source Control | MISSING | Source-control flow is staged/manual | Show Planned Capability button only | Medium-High | Define governance artifact model first |
| Automated Compliance Monitoring | Revenue/Governance | MISSING | Revenue capability map | Show Planned Capability button only | High | Define compliance signal model first |
| Closed-Loop Progression Intelligence | Athlete Development | MISSING | No full closed-loop intelligence workflow present | Show Planned Capability button only | High | Defer entity design until capability spec |
| Film Study Intelligence Pipeline | Coach Operations | PARTIAL-HIGH-RISK | Coach film study exists without full pipeline | Show Open Capability button with partial badge | Medium | Treat as partial with explicit boundaries |
| One-on-One Session Orchestration Depth | Coach Operations | PARTIAL-HIGH-RISK | Session mode exists, orchestration depth limited | Show Open Capability button with partial badge | Medium | Scope missing orchestration before entity inflation |
| Public Intake Triage Automation | Admin/Public | PARTIAL-HIGH-RISK | Intake exists with partial triage chain | Show Open Capability button with partial badge | Medium | Confirm intake lifecycle before entity locking |

## Required Actions Before Core Entity Map

1. Confirm missing capabilities that are in near-term scope vs deferred roadmap.
2. Confirm placeholder capabilities that must remain UI-visible only.
3. Confirm partial-high-risk capabilities requiring explicit non-assumption boundaries.
4. Approve which missing/placeholder capabilities are allowed as future candidates (not current entities).

## Completion Gate

This register is now complete and can be referenced in sequence gate checks.
