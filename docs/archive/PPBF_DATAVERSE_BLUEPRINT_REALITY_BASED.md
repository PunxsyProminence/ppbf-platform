# PPBF Dataverse Blueprint (Reality Based)

Project: PPBF_BACKEND_READINESS_PROJECT
Mode: Architecture Only
Step: 4 (Dataverse Blueprint)
Date: 2026-07-13

## Preconditions

Step 1 approved and locked:

- PPBF_CAPABILITY_MAP_REALITY_BASED.md
- PPBF_MISSING_CAPABILITY_REGISTER_REALITY_BASED.md
- PPBF_CAPABILITY_MAP_SELF_AUDIT.md
- PPBF_STEP1_APPROVAL_LOCK.md

Step 2 active:

- PPBF_CORE_ENTITY_MAP_REALITY_BASED.md

Step 3 active:

- PPBF_RELATIONSHIP_MAP_REALITY_BASED.md

## Guardrails

- Blueprint only (no table creation execution)
- No SQL generation
- No API implementation
- No backend build
- No auth implementation changes
- No assumptions from missing/placeholder capabilities

## Blueprint Scope

This blueprint covers the Step 2 minimum set with Step 3 relationship alignment.

Canonical blueprint entities:

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
11. IntakeSubmission
12. RevenueCommitment

## Dataverse Table Blueprint (Logical)

Naming uses logical singular entity names; physical naming convention to be finalized in implementation phase.

### 1) Person

Purpose:

- Master actor record across participant, coach, parent/guardian, admin, board, sponsor/donor contexts

Key fields (logical):

- PersonId (PK)
- DisplayName
- PersonType
- ContactEmail
- ContactPhone
- Status
- CreatedAt
- UpdatedAt

Notes:

- PersonType supports multi-role population; role access is modeled through RoleAssignment.

### 2) RoleAssignment

Purpose:

- Role and access scope assignment for people

Key fields:

- RoleAssignmentId (PK)
- PersonId (FK -> Person)
- RoleCode
- ScopeType
- ScopeRef
- EffectiveFrom
- EffectiveTo
- Status

Notes:

- Supports board seat, admin scope, coach scope, parent/guardian scope.

### 3) ParticipantProfile

Purpose:

- Participant-specific operational profile and readiness context

Key fields:

- ParticipantProfileId (PK)
- PersonId (FK -> Person)
- ProgramTrack
- BaselineClassification
- SafetyLevel
- ActiveRouteId (FK -> DevelopmentRoute, nullable)
- Status
- CreatedAt
- UpdatedAt

### 4) SessionLog

Purpose:

- Program session execution records

Key fields:

- SessionLogId (PK)
- ParticipantProfileId (FK -> ParticipantProfile)
- SessionDate
- SessionType
- IntensityLevel
- CoachReviewStatus
- SafetyFlagsJson (transitional)
- Notes
- CreatedAt

Notes:

- SafetyFlagsJson is transitional until explicit SafetyIncident promotion is approved.

### 5) DevelopmentRoute

Purpose:

- Route model for participant progression plans

Key fields:

- DevelopmentRouteId (PK)
- RouteName
- RouteCategory
- LifecycleTag
- Status
- Version
- EffectiveFrom
- EffectiveTo

### 6) Assignment

Purpose:

- Planned participant work items aligned to route and progression

Key fields:

- AssignmentId (PK)
- ParticipantProfileId (FK -> ParticipantProfile)
- DevelopmentRouteId (FK -> DevelopmentRoute, nullable)
- AssignmentTitle
- AssignmentType
- DueDate
- CompletionStatus
- Priority
- Notes

### 7) ConsentRecord

Purpose:

- Consent/compliance artifacts linked to participant and person context

Key fields:

- ConsentRecordId (PK)
- PersonId (FK -> Person)
- ParticipantProfileId (FK -> ParticipantProfile, nullable)
- ConsentType
- ConsentStatus
- EffectiveFrom
- EffectiveTo
- ArtifactRef

### 8) ProgressEntry

Purpose:

- Point-in-time progression metrics/events

Key fields:

- ProgressEntryId (PK)
- ParticipantProfileId (FK -> ParticipantProfile)
- SessionLogId (FK -> SessionLog, nullable)
- MetricType
- MetricValue
- MetricUnit
- RecordedAt
- Notes

### 9) DecisionLogEntry

Purpose:

- Cross-domain governance and continuity audit trail

Key fields:

- DecisionLogEntryId (PK)
- DecisionType
- SourceEntityType
- SourceEntityId
- DecisionByPersonId (FK -> Person, nullable)
- DecisionOutcome
- DecisionNotes
- DecisionAt

Notes:

- SourceEntityType + SourceEntityId support polymorphic trace across Capability, Assignment, SessionLog, IntakeSubmission, RevenueCommitment.

### 10) Capability

Purpose:

- Capability governance and lifecycle control

Key fields:

- CapabilityId (PK)
- CapabilityName
- CapabilityDomain
- CapabilityState
- VisibilityState
- OwnerRoleCode
- RiskLevel
- Priority
- Status
- UpdatedAt

### 11) IntakeSubmission

Purpose:

- Unified intake object for public/admin intake flows

Key fields:

- IntakeSubmissionId (PK)
- PersonId (FK -> Person, nullable)
- IntakeType
- IntakeSource
- SubmissionStatus
- ReviewState
- SubmittedAt
- ReviewedAt
- PayloadRef

Notes:

- Subtype separation (public/admin) deferred to Step 5 decision.

### 12) RevenueCommitment

Purpose:

- Unified sponsorship/donation/membership commitment abstraction

Key fields:

- RevenueCommitmentId (PK)
- PersonId (FK -> Person, nullable)
- ParticipantProfileId (FK -> ParticipantProfile, nullable)
- CommitmentType
- CommitmentStatus
- Amount
- EffectiveFrom
- EffectiveTo
- Designation
- Notes

Notes:

- Multi-party support is intentional (participant/guardian/sponsor/donor).

## Relationship Blueprint (Dataverse-Facing)

Mandatory relationships:

- Person 1:N RoleAssignment
- Person 1:N ConsentRecord
- Person 1:N IntakeSubmission
- Person 1:N RevenueCommitment
- ParticipantProfile 1:N SessionLog
- ParticipantProfile 1:N Assignment
- ParticipantProfile 1:N ProgressEntry
- DevelopmentRoute 1:N Assignment

Candidate relationships (promote in Step 5 by approval):

- Person 1:N ParticipantProfile
- ParticipantProfile N:1 DevelopmentRoute (active route reference)
- ParticipantProfile 1:N RevenueCommitment
- SessionLog 1:N DecisionLogEntry (via polymorphic source)
- Assignment 1:N DecisionLogEntry (via polymorphic source)
- Capability 1:N DecisionLogEntry (via polymorphic source)
- IntakeSubmission 1:N DecisionLogEntry (via polymorphic source)
- RevenueCommitment 1:N DecisionLogEntry (via polymorphic source)

## Security And Access Blueprint (Logical)

Role alignment model:

- Access is role-driven through RoleAssignment
- Record ownership strategy to be finalized in Step 5
- Row-level access segmentation required for:
  - Athlete/guardian data
  - Board governance data
  - Admin-only capability controls

Baseline access pattern:

- Athlete: own participant profile and assigned program data
- Coach: assigned participant cohort/session context
- Parent/Guardian: linked child participant views only
- Board: governance and compliance views only
- Admin: cross-domain operational control with least privilege boundaries

## Explicit Exclusions (From Step 1 Lock)

Do not include Dataverse blueprint entities for:

- AI/ML Video Analysis
- Video Review Intelligence
- Performance Analytics Intelligence
- Grant Compliance Intelligence
- Automated Publication Workflow
- Automated Compliance Monitoring
- Closed-Loop Progression Intelligence

These remain roadmap/front-end visibility items only.

## Implementation Readiness Classification

- READY (for Step 5 planning):
  - Person, RoleAssignment, ParticipantProfile, SessionLog, DevelopmentRoute, Assignment, ConsentRecord, ProgressEntry, DecisionLogEntry, Capability

- CONDITIONAL (requires explicit promotion decision in Step 5):
  - IntakeSubmission
  - RevenueCommitment

## Step 5 Handoff Decisions Required

1. Confirm final logical names and ownership strategy per entity.
2. Confirm candidate relationship promotions.
3. Confirm IntakeSubmission subtype policy (public/admin split or unified).
4. Confirm RevenueCommitment party model and minimum required fields.
5. Confirm DecisionLogEntry polymorphic source policy.
6. Confirm phased rollout order and non-disruptive migration strategy.

## Approval Gate

This Step 4 blueprint is ready for Jason review and approval before Step 5 Backend Build Plan drafting.
