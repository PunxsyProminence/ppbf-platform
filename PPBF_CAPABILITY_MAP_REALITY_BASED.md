# PPBF Capability Map (Reality Based)

Project: PPBF_BACKEND_READINESS_PROJECT
Mode: Architecture + Front-End Readiness Audit Only
Date: 2026-07-13
Step 1 Status: APPROVED
Step 1 Lock: LOCKED

## Required Project Sequence (Updated)

This capability map is now the required first step for backend readiness planning.

1. Capability Map
2. Core Entity Map
3. Relationship Map
4. Dataverse Blueprint
5. Backend Build Plan

Rule: do not move into entity or backend model design until capability reality and gaps are explicitly mapped.

## Guardrails Applied

- No backend code was created.
- No APIs were created.
- No Dataverse or SQL schemas were created.
- No payment processing was created.
- No authentication/persistence architecture was changed.
- Findings are based on current repository and front-end behavior evidence only.

## Capability State Definitions

- EXISTS: actively present in current UI flow with clear interaction surface.
- PARTIAL: present but incomplete, placeholder-backed, or lacking full workflow depth.
- PLACEHOLDER: intentionally shown as planned but non-operational.
- MISSING: intended capability not currently represented as an implemented flow.
- ROADMAP: future capability candidate that should remain visible as planned, not implemented now.

## Domain Audit (Reality)

### Athlete Development

Evidence: apps/web/components/AthleteWorkspace.tsx, apps/web/app/athlete/dashboard/page.tsx, apps/web/app/athlete/dashboard/sparring/page.tsx

- Athlete dashboard: EXISTS
- Athlete floor: EXISTS
- Goals: EXISTS
- Tasks: EXISTS
- Assessments: PARTIAL (placeholder modules + start actions, not full lifecycle)
- Readiness: EXISTS
- Recovery: PARTIAL (readiness/soreness inputs exist; recovery workflows are shallow)
- Tracks: PARTIAL (track lane visible, deeper progression logic placeholder)
- Skill progression: PARTIAL (goal/progress views exist without full progression engine)
- Competition readiness: PARTIAL (sparring surface exists; readiness intelligence is limited)

### Coach Operations

Evidence: apps/web/components/CoachWorkspace.tsx, apps/web/app/coach/review-queue/page.tsx, apps/web/app/coach/environment/intake-router/page.tsx, apps/web/app/coach/environment/passbook-check/page.tsx

- Coach dashboard: EXISTS
- Coach floor: EXISTS
- One-on-one coaching controls: PARTIAL (session mode exists, no deep scheduling/workflow state)
- Group session control: PARTIAL (mode + floor flows exist, advanced orchestration missing)
- Observations: PARTIAL (entry surfaces exist, limited persistence and analytics)
- Coach development: EXISTS (dedicated tab and modules)
- Coach tasks: EXISTS
- Film study: PARTIAL (surface exists, no full indexing/review pipeline)
- Athlete reviews: PARTIAL (review pages exist; decision depth still front-end staged)

### Parent / Guardian Support

Evidence: apps/web/components/ParentHub.tsx, apps/web/app/parent/dashboard/page.tsx, apps/web/app/guardian/page.tsx

- Parent hub: EXISTS
- At-home tasks: EXISTS
- Parent observations: EXISTS
- Family goals: EXISTS
- Membership/support visibility: PARTIAL (support context appears, funding detail depth is limited)
- Communication: EXISTS
- Parent resources: EXISTS

### Board Governance

Evidence: apps/web/app/board/page.tsx, apps/web/components/BoardMemberDashboard.tsx, apps/web/app/board/*/page.tsx

- Board workspace: EXISTS
- Board seats: EXISTS
- Governance: EXISTS
- Strategy: EXISTS
- Policies: EXISTS
- Resolutions: EXISTS
- Committees: EXISTS
- Compliance: EXISTS
- Documents: EXISTS
- Board SHADOW: PARTIAL (governance SHADOW feed exists; deeper intelligence agents are roadmap)

### Admin Operations

Evidence: apps/web/app/admin/page.tsx, apps/web/app/admin/shadow/page.tsx, apps/web/app/operations/page.tsx

- Admin hub: EXISTS
- Capability management: EXISTS
- People management: PARTIAL (admin people surfaces exist, lifecycle depth is limited)
- Revenue & Funding Center: PARTIAL (strong front-end lane model; still non-transactional)
- Public intake management: PARTIAL (intake exists, full triage/approval chain is partial)
- Communications: PARTIAL (messaging/reporting surfaces exist with limited depth)
- System control: PARTIAL (control and audit surfaces exist; orchestration remains staged)

### Revenue & Funding

Evidence: apps/web/components/RevenueFundingCenter.tsx, apps/web/app/admin/page.tsx

- Membership tracking: PARTIAL
- Donation operations: EXISTS (front-end operational workflow)
- Sponsor management: PARTIAL
- B2B account management: PARTIAL
- Wholesale account management: PARTIAL
- Grant tracking: PARTIAL
- Scholarship tracking: PARTIAL
- Treasurer review queue: EXISTS (front-end oversight queue)
- Payment processor integrations: PLACEHOLDER (explicitly not connected)
- Compliance automation: MISSING

### Intelligence, Evidence, and Operations Support

Evidence: apps/web/app/research/page.tsx, apps/web/app/research/chat/page.tsx, apps/web/app/evidence/page.tsx, apps/web/app/knowledge-graph/page.tsx, apps/web/app/simulator/page.tsx, apps/web/app/source-control/page.tsx, apps/web/app/shadow/page.tsx

- Research intake and chat: EXISTS
- Evidence workflow: EXISTS
- Knowledge graph view: EXISTS
- Scenario simulator: EXISTS
- Source-control publication surface: PARTIAL (front-end staged flow)
- SHADOW assistant surfaces: PARTIAL (multi-role UI integration exists, deep role intelligence partial)

### AI/ML and Advanced Capability Gap Check

Evidence: repo-wide current front-end surfaces + capability labels in PPBF_CAPABILITIES.json + operations capability visibility maps

- AI/ML video analysis: MISSING
- Video review intelligence: PLACEHOLDER
- Automated performance analytics: PLACEHOLDER
- Grant compliance intelligence: PLACEHOLDER
- Publication workflow automation: MISSING
- Closed-loop progression intelligence: MISSING

These are major intended capabilities and must be considered before final backend entity boundaries are frozen.

## Cross-Domain Totals (Current)

- EXISTS: 26
- PARTIAL: 22
- PLACEHOLDER: 5
- MISSING: 5

Interpretation: core multi-role platform is real and usable, but several strategic intelligence capabilities are not implemented yet and must remain explicit in planning.

## Front-End Planned Capability Visibility (Required)

The following should remain visible in front-end capability maps as planned, not represented as implemented:

- AI/ML Video Analysis (planned)
- Video Review Intelligence (planned)
- Performance Analytics Intelligence (planned)
- Grant Compliance Intelligence (planned)
- Automated Publication Workflow (planned)
- Advanced SHADOW Intelligence Modes (planned)

Visibility guideline:

- Show state badges: EXISTS / PARTIAL / PLACEHOLDER / MISSING.
- Link only to real routes for EXISTS/PARTIAL capabilities.
- For PLACEHOLDER/MISSING, use roadmap labels with no fake workflow.

## Preconditions Before Backend Mapping

Before Core Entity Map and Relationship Map proceed:

1. Freeze capability state taxonomy (EXISTS/PARTIAL/PLACEHOLDER/MISSING).
2. Confirm which PLACEHOLDER capabilities are in near-term roadmap scope versus deferred.
3. Confirm which PARTIAL capabilities must become first-class backend entities.
4. Separate UI placeholders from true domain entities.
5. Keep funding/payment boundaries explicit: operational tracking now, transactional processing later.
6. Preserve governance boundaries (board/admin/role-scoped SHADOW data boundaries) before designing shared data models.

## Output Handoff To Next Step

This file is Step 1 and is the required handoff into Step 2 (Core Entity Map).

Step 2 must explicitly reference this capability state map and may only model entities for:

- current EXISTS capabilities,
- approved PARTIAL capabilities,
- explicitly approved roadmap candidates.

No entity should be introduced solely because it appears in archived recommendations or placeholder UI labels.
