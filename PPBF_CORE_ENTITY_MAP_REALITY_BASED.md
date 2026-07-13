# PPBF Core Entity Map (Reality Based)

Project: PPBF_BACKEND_READINESS_PROJECT  
Mode: Architecture Only  
Date: 2026-07-13

## Sequence Gate Notice

This document is gated and must not be treated as active implementation input unless all Step 1 artifacts are complete and an explicit proceed decision is recorded.

Required Step 1 artifacts:

- PPBF_CAPABILITY_MAP_REALITY_BASED.md
- PPBF_MISSING_CAPABILITY_REGISTER_REALITY_BASED.md
- PPBF_CAPABILITY_MAP_SELF_AUDIT.md

Rule: Do not create or advance Core Entity Map work before Step 1 is complete.

Prerequisite: `PPBF_CAPABILITY_MAP_REALITY_BASED.md` (Step 1)

## Scope And Method
This report is Step 2 in the required PPBF backend-readiness sequence:

1. Capability Map
2. Core Entity Map
3. Relationship Map
4. Dataverse Blueprint
5. Backend Build Plan

Capability state and roadmap gaps must be resolved before entity modeling begins.

For this Step 2 report, the method remains reality-first:

1. Reality
2. Code
3. Business Need
4. Recommendations

Guardrails applied:

- Files are authoritative source.
- Screens/tabs/routes do not create entities by themselves.
- Mock arrays do not establish backend entities.
- SQL drafts in `infra/supabase/*` are treated as quarantined reference material only.
- Jason Neale approval is final authority for promotion/build decisions.

---

## Authoritative Input Resolution
The named audits are not present as standalone files in the current repository snapshot. To preserve intent, evidence was mapped to equivalent authoritative sources:

- Repository Architecture Audit (reality equivalent): typed domain code and active app structures in `apps/web/**` and `packages/**`.
- Revenue Audit (reality equivalent): active revenue surface and donation workflow in `apps/web/components/RevenueFundingCenter.tsx`.
- Reality vs Recommendation Audit (reality equivalent): current code and runtime structures versus recommendation docs in `docs/archive/*RECOMMENDATIONS*.md`.
- Backend Drift Quarantine Audit (reality equivalent): SQL drafts in `infra/supabase/schema.sql` and `infra/supabase/ppbf_core_schema.sql` treated as non-authoritative until approved.

---

## Task 1: Current Reality Inventory

### CONFIRMED
Entities with direct, typed, business-operational evidence in shared or active runtime code.

- ParticipantProfile
  - Evidence: `packages/execution/models.ts` (`ParticipantProfile`)
- SessionLog
  - Evidence: `packages/execution/models.ts` (`SessionLog`)
- DevelopmentRoute
  - Evidence: `packages/execution/models.ts` (`DevelopmentRoute`)
- Assignment
  - Evidence: `packages/execution/models.ts` (`Assignment`)
- ConsentRecord
  - Evidence: `packages/execution/consentManager.ts` (`ConsentRecord`)
- ProgressEntry
  - Evidence: `packages/execution/progressTracker.ts` (`ProgressEntry`)
- DecisionLogEntry (Continuity Ledger event)
  - Evidence: `packages/continuity/ledger.ts` (`DecisionLogEntry`)
- Capability (governance asset)
  - Evidence: `apps/web/app/admin/page.tsx` (`Capability`, repository load/save, assignment/status lifecycle)
- Role Session (operational access state)
  - Evidence: `apps/web/components/roleSession.ts` (`RoleSession`), `apps/web/components/roleRoutes.ts` (`ClubRole`)

### MOCK ONLY
Structures exist and are actively used in UI flows, but currently front-end/local-state only.

- DonationRecord
  - Evidence: `apps/web/components/RevenueFundingCenter.tsx`
- RevenueAccount, RevenueItem
  - Evidence: `apps/web/components/RevenueFundingCenter.tsx`
- IntakeItem, ConsoleLogEntry, TelemetryEvent
  - Evidence: `apps/web/app/admin/shadow/page.tsx`
- Child, HomeAssignment, ParentObservation, FamilyGoal, AttendanceEntry, ProgressMilestone, ParentResource
  - Evidence: `apps/web/components/ParentHub.tsx`
- Athlete, WorkoutBlock, CoachTask, CoachGoal
  - Evidence: `apps/web/components/CoachWorkspace.tsx`
- AthleteProfile, TrackAssignments, TrackManifest
  - Evidence: `apps/web/components/trackAssignments.ts`
- TelemetryTrace (public intake)
  - Evidence: `apps/web/app/public/page.tsx`

### SQL DRAFT ONLY (QUARANTINED)
Present only in SQL draft artifacts; not authoritative yet.

- profiles
- participants
- sessions
- coach_reviews
- safety_gates
- athlete_voice
- physical_training_logs
- continuity_ledger
- user_profiles

Evidence:

- `infra/supabase/schema.sql`
- `infra/supabase/ppbf_core_schema.sql`

### FUTURE CANDIDATE
Supported by business need and partial evidence, but not yet established as authoritative backend entities.

- CoachReviewDecision (distinct from SessionLog status string)
  - Evidence: `SessionLog.coachReviewStatus` in `packages/execution/models.ts`; draft table `coach_reviews` in SQL
- SafetyIncident/Event (distinct from embedded flags arrays)
  - Evidence: `safetyFlags` in session model + safety gate logic in `packages/execution/safetyGate.ts`
- PublicIntakeSubmission
  - Evidence: public intake flow in `apps/web/app/public/page.tsx` currently local/trace-only
- FileGovernanceArtifact (source item promotion object)
  - Evidence: source-control/audit/admin-shadow pages currently mock timeline/state lanes
- RevenueCommitment (unified donation/membership/sponsor obligation record)
  - Evidence: active donation workflow + placeholders in `apps/web/components/RevenueFundingCenter.tsx`

### REJECT
Not entities; these are UI/runtime/service helper constructs.

- Tab identifiers (`TabID`, `RevenueFundingTab`, etc.)
- View filters/sort options (`MatrixFilter`, `QueueSort`, etc.)
- AppState runtime wrapper (`packages/execution/appState.ts`)
- Request/response helper DTOs (`RouteRequest`, `SafetyCheckResult`, AI request DTOs)
- Screen timeline cards and dashboard stat cards by themselves

---

## Task 2: Entity Candidate Matrix

| Entity | Evidence | Source | Current Status | Business Need | Implementation Risk | Jason Approval Required |
|---|---|---|---|---|---|---|
| ParticipantProfile | Typed domain model used for participant operations | `packages/execution/models.ts` | CONFIRMED | Core participant identity and classification | Medium | Yes |
| SessionLog | Typed session model with safety and review fields | `packages/execution/models.ts` | CONFIRMED | Core training/session record | Medium | Yes |
| DevelopmentRoute | Typed route model | `packages/execution/models.ts` | CONFIRMED | Program routing/progression | Medium | Yes |
| Assignment | Typed assignment model | `packages/execution/models.ts` | CONFIRMED | Daily/weekly execution tracking | Low | Yes |
| ConsentRecord | Typed consent record | `packages/execution/consentManager.ts` | CONFIRMED | Compliance boundary and consent proof | Medium | Yes |
| ProgressEntry | Typed progress record | `packages/execution/progressTracker.ts` | CONFIRMED | Trend/progression analysis | Low | Yes |
| DecisionLogEntry | Append-only continuity ledger event | `packages/continuity/ledger.ts` | CONFIRMED | Governance traceability/audit | Low | Yes |
| Capability | Capability lifecycle and role assignment with repository semantics | `apps/web/app/admin/page.tsx` | CONFIRMED | Governance/feature posture control | Medium | Yes |
| RoleSession | Role + expiry operational state | `apps/web/components/roleSession.ts` | CONFIRMED | Access routing and role gating | Medium | Yes |
| DonationRecord | Working donation intake/status flow (local) | `apps/web/components/RevenueFundingCenter.tsx` | MOCK ONLY | Revenue/funding operations | Medium | Yes |
| RevenueAccount | Account placeholders in revenue center | `apps/web/components/RevenueFundingCenter.tsx` | MOCK ONLY | Sponsorship/B2B tracking | Medium | Yes |
| RevenueItem | Revenue line placeholders in revenue center | `apps/web/components/RevenueFundingCenter.tsx` | MOCK ONLY | Revenue lane normalization | Medium | Yes |
| IntakeItem | Admin SHADOW intake queue object | `apps/web/app/admin/shadow/page.tsx` | MOCK ONLY | File/data intake governance | Medium | Yes |
| TelemetryTrace/Event | Public/admin trace objects | `apps/web/app/public/page.tsx`, `apps/web/app/admin/shadow/page.tsx` | MOCK ONLY | Operational observability | Low | Yes |
| CoachReviewDecision | Review signal exists, entity not formalized | `coachReviewStatus` in `SessionLog`; SQL draft `coach_reviews` | FUTURE CANDIDATE | Decision lifecycle beyond status string | Medium | Yes |
| SafetyIncident | Safety signal exists, entity not formalized | `safetyFlags`, `runSafetyGate`; SQL draft `safety_gates` | FUTURE CANDIDATE | Explicit safety incident workflow | Medium | Yes |
| PublicIntakeSubmission | Public intake exists in local form state | `apps/web/app/public/page.tsx` | FUTURE CANDIDATE | Public onboarding/interest funnel | Medium | Yes |
| FileGovernanceArtifact | Promotion pipeline exists as mock states | `apps/web/app/source-control/page.tsx`, `apps/web/app/audit/page.tsx` | FUTURE CANDIDATE | Source file governance lifecycle | Medium | Yes |
| profiles / participants / sessions / etc. SQL tables | SQL table drafts only | `infra/supabase/schema.sql`, `infra/supabase/ppbf_core_schema.sql` | SQL DRAFT ONLY | Potential backend implementation reference | High (drift risk) | Yes |

---

## Task 3: Minimum PPBF Entity Set (Smallest Viable)

This is the smallest defensible model before Dataverse planning, based on current reality and business need:

1. Person
   - Represents any human actor (participant, coach, parent/guardian, admin/board).
2. RoleAssignment
   - Binds person to role(s) and access scope.
3. ParticipantProfile
   - Participant-specific classification, baseline/risk, consent-state linkage.
4. SessionLog
   - Session execution record with intensity, focus, safety flags, review status.
5. DevelopmentRoute
   - Goal intake mapping to assigned route, task dimensions, lifecycle tags.
6. Assignment
   - Planned work item for participant progression.
7. ConsentRecord
   - Compliance and permission proof.
8. ProgressEntry
   - Measurable progression datapoint.
9. DecisionLogEntry
   - Governance/continuity decision trail.
10. Capability
    - Governance-controlled capability definition and assignment state.
11. IntakeSubmission
    - Unified intake object (public/admin file/data intake), promoted from current mocks when approved.
12. RevenueCommitment
    - Unified donation/membership/sponsor commitment object, promoted from current donation workflow + revenue mocks when approved.

Why these 12:

- They are directly evidenced by code and business operations.
- They avoid tab/screen inflation.
- They preserve governance and safety traceability as first-class concerns.

---

## Task 4: No Build List

Do not build the following as backend entities:

1. Screen-label entities
   - Examples: "Athlete Workspace", "Parent Hub", "Revenue & Funding Center".
2. Tab-name entities
   - Examples: `dashboard`, `overview`, `payment-settings`, `shadow`.
3. Recommendation-only entities without code evidence
   - Any item only appearing in archived recommendation docs.
4. Pipeline/card UI labels as entities
   - Examples: "Draft lane", "Review lane", "Promotion Queue" labels by themselves.
5. Runtime-only helper DTO/state wrappers
   - Examples: `AppState`, `RouteRequest`, `SafetyCheckResult`, filter/sort types.

---

## Task 5: Canonical Candidates (Foundation-First)

Recommended foundational candidates for pre-Dataverse consideration (evidence-backed):

1. Person
2. RoleAssignment
3. ParticipantProfile
4. SessionLog
5. DevelopmentRoute
6. Assignment
7. ConsentRecord
8. ProgressEntry
9. DecisionLogEntry
10. Capability
11. IntakeSubmission (candidate; currently mock-backed)
12. RevenueCommitment (candidate; currently mock-backed)

---

## Reality Separation Summary

### WHAT EXISTS (authoritative in code)
- ParticipantProfile, SessionLog, DevelopmentRoute, Assignment, ConsentRecord, ProgressEntry, DecisionLogEntry, Capability, RoleSession.

### WHAT IS MOCK
- DonationRecord/RevenueAccount/RevenueItem, IntakeItem and trace logs, many parent/coach/public structures, source-control lane cards.

### WHAT IS SQL DRAFT
- Supabase table definitions in `infra/supabase/schema.sql` and `infra/supabase/ppbf_core_schema.sql`.

### WHAT IS BUSINESS REQUIRED
- Participant + session + route + assignment + safety/compliance + governance + funding intake/commitment.

### WHAT IS FUTURE SPECULATION
- Any advanced/expanded recommendations not grounded in current typed code and active workflow evidence.

---

## Decision Before Dataverse Planning

Proceed to Dataverse planning only on the 12-entity minimum set above, with staged Jason approval gates:

- Gate A: Confirm canonical entities and reject no-build list.
- Gate B: Approve promotion of `IntakeSubmission` and `RevenueCommitment` from mock-only to planned backend entities.
- Gate C: Decide whether SQL drafts are adopted, transformed, or discarded.

This gives a strict, reality-based entity boundary before backend planning begins.
