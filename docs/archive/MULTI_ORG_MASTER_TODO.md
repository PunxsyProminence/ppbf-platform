# Multi-Organization Foundation Master Todo

## How to use this checklist

1. Work top to bottom by phase.
2. Do not start a phase until previous phase exit criteria are met.
3. Keep every item traceable to an artifact or test result.

## Source documents

- [PHASE0_IMPLEMENTATION_SPEC.md](PHASE0_IMPLEMENTATION_SPEC.md)
- [ORGANIZATION_IMPACT_REPORT.md](ORGANIZATION_IMPACT_REPORT.md)
- [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md)
- [ORGANIZATION_DATABASE_PLAN.md](ORGANIZATION_DATABASE_PLAN.md)
- [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md)
- [ORGANIZATION_MIGRATION_PLAN.md](ORGANIZATION_MIGRATION_PLAN.md)
- [ORGANIZATION_ADMIN_WORKFLOW.md](ORGANIZATION_ADMIN_WORKFLOW.md)

## Phase 0: Final design and approval (no runtime changes)

### Governance and role canon

- [x] Finalize canonical roles: platform_owner, organization_admin, coach, athlete, parent, volunteer, staff.
- [x] Define deny-by-default cross-organization policy statement.
- [x] Define platform-owner aggregate-only policy.
- [ ] Define delegated private-data access policy and approval flow.
- [ ] Approve role matrix with explicit allow/deny capabilities.

### Data ownership and schema design

- [x] Produce table ownership matrix for all existing tables.
- [x] Confirm every private table requires organization_id.
- [x] Define key strategy for legacy identifiers (organization-scoped uniqueness).
- [x] Define organization and organization_memberships canonical schema.
- [x] Define schema for new domain tables: parents, volunteers, staff, attendance, readiness, assessments, documents, messages, skills.

### Migration design

- [x] Define deterministic migration order (create core tables first, then additive alterations).
- [x] Define backfill strategy for bootstrap organization mapping.
- [x] Define index rollout strategy.
- [x] Define constraint enablement sequence.
- [ ] Define rollback and recovery notes per migration step.

### Service contract design

- [x] Define principal model delta: organization_id + platform context.
- [x] Define authentication membership validation requirements.
- [x] Define authorization rule contract: role + organization + ownership relation.
- [x] Define mandatory organization predicate requirements for reads/writes.
- [x] Define admin endpoint scoping requirements (organization_admin only, platform_owner scope where required).

### Workflow and operations design

- [x] Finalize platform owner workflow: create org, assign admin, activate/deactivate.
- [x] Finalize organization admin workflow: user creation and lifecycle.
- [x] Define audit requirements for all lifecycle actions.
- [x] Define analytics separation requirements (aggregate vs org-private planes).

### Phase 0 exit gate

- [ ] All design docs approved.
- [ ] No unresolved role-policy conflicts.
- [ ] No unresolved table ownership gaps.
- [ ] Migration design marked implementation-ready.

## Phase 1: Database implementation

### Core tenancy tables

- [ ] Create organizations table (database execution pending).
- [ ] Create organization_memberships table (database execution pending).
- [ ] Seed platform owner identity for Jason Neale.
- [ ] Create bootstrap organization for existing records (database execution pending).

### Existing table alterations

- [ ] Add organization_id to profiles.
- [ ] Add organization_id to participants.
- [ ] Add organization_id to sessions.
- [ ] Add organization_id to coach_reviews.
- [ ] Add organization_id to safety_gates.
- [ ] Add organization_id to athlete_voice.
- [ ] Add organization_id to physical_training_logs.
- [ ] Add organization_id to continuity_ledger.
- [ ] Add organization_id to public.user_profiles.
- [ ] Add organization_id to pilot.accounts (database execution pending).
- [ ] Add organization_id to pilot.session_tokens (or enforce equivalent via guaranteed account join contract) (database execution pending).
- [ ] Add organization_id to pilot.athletes (database execution pending).
- [ ] Add organization_id to pilot.goals (database execution pending).
- [ ] Add organization_id to pilot.sessions (database execution pending).
- [ ] Add organization_id to pilot.coach_reviews (database execution pending).
- [ ] Add organization_id to pilot.shadow_intake (database execution pending).
- [ ] Add organization_id to pilot.audit_events (database execution pending).

### New domain table creation

- [ ] Create parents table with organization ownership (database execution pending).
- [ ] Create volunteers table with organization ownership (database execution pending).
- [ ] Create staff table with organization ownership (database execution pending).
- [ ] Create attendance table with organization ownership (database execution pending).
- [ ] Create readiness table with organization ownership (database execution pending).
- [ ] Create assessments table with organization ownership (database execution pending).
- [ ] Create documents table with organization ownership (database execution pending).
- [ ] Create messages table with organization ownership (database execution pending).
- [ ] Create skills table with organization ownership (database execution pending).

### Constraints and indexes

- [ ] Add FKs from organization-owned tables to organizations (database execution pending).
- [ ] Add organization-scoped uniqueness constraints where required (database execution pending).
- [ ] Add access-path indexes containing organization_id (database execution pending).
- [ ] Validate query plans for critical read/write paths.

### Data backfill and validation

- [ ] Backfill organization_id for all legacy rows (database execution pending).
- [ ] Backfill organization memberships for current users (database execution pending).
- [ ] Validate referential integrity.
- [ ] Validate no null organization_id remains in private tables.

### Phase 1 exit gate

- [ ] Database migrations applied successfully in non-prod.
- [ ] Backfill completed with validation report.
- [ ] Constraint and index checks complete.

## Phase 2: Service layer implementation

### Contracts and principal

- [x] Update role contracts in [apps/web/src/server/pilot/contracts.ts](apps/web/src/server/pilot/contracts.ts).
- [x] Update principal type to include organization context.

### Authentication and sessions

- [x] Update login flow in [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts) to resolve active organization membership.
- [x] Update principal resolution to enforce organization status and membership active state.
- [x] Update session handling to preserve organization context safely.

### Authorization

- [x] Update [apps/web/src/server/pilot/access.ts](apps/web/src/server/pilot/access.ts) for role + organization + ownership checks.
- [x] Enforce deny on organization mismatch for all private resource access.
- [x] Add platform-owner special handling only for platform-scope operations.

### Data access

- [x] Update all entity queries in [apps/web/src/server/pilot/entities.ts](apps/web/src/server/pilot/entities.ts) to include organization predicates.
- [x] Update audit writes in [apps/web/src/server/pilot/audit.ts](apps/web/src/server/pilot/audit.ts) to stamp organization context.
- [x] Update shadow intake pipeline in [apps/web/app/api/pilot/shadow/upload/route.ts](apps/web/app/api/pilot/shadow/upload/route.ts) to enforce organization ownership.

### Admin endpoints

- [x] Update athlete account creation endpoint in [apps/web/app/api/pilot/admin/athlete-accounts/route.ts](apps/web/app/api/pilot/admin/athlete-accounts/route.ts) for organization-admin scope.
- [x] Update PIN reset endpoint in [apps/web/app/api/pilot/admin/accounts/pin-reset/route.ts](apps/web/app/api/pilot/admin/accounts/pin-reset/route.ts) for organization-admin scope.
- [x] Update session revoke endpoint in [apps/web/app/api/pilot/admin/accounts/revoke/route.ts](apps/web/app/api/pilot/admin/accounts/revoke/route.ts) for organization-admin scope.

### Phase 2 exit gate

- [ ] All private operations are organization-scoped in code review.
- [ ] No endpoint bypasses organization checks.
- [ ] Platform-owner boundaries are enforced by policy and code.

## Phase 3: Registration and lifecycle workflows

### Platform owner flows

- [x] Implement create organization workflow.
- [x] Implement assign organization admin workflow.
- [x] Implement activate/deactivate organization workflow.

### Organization admin flows

- [ ] Implement create coach workflow.
- [x] Implement create athlete workflow.
- [ ] Implement create parent workflow.
- [ ] Implement create volunteer workflow.
- [ ] Implement create staff workflow.
- [ ] Implement user lifecycle controls (activate/deactivate/reset credentials) scoped to organization.

### Audit and compliance

- [x] Emit audit events for all membership and organization lifecycle actions.
- [x] Include actor id, actor role, organization_id, action type, timestamp in lifecycle audit payloads.

### Phase 3 exit gate

- [ ] End-to-end org onboarding flow passes test script.
- [ ] End-to-end org admin user management flow passes test script.

## Phase 4: Analytics separation and privacy

### Platform analytics plane

- [ ] Define and implement aggregate-only metrics views.
- [ ] Remove direct PII dependencies from platform analytics surfaces.
- [ ] Validate no private organization records are exposed in platform owner dashboards by default.

### Organization analytics plane

- [ ] Ensure organization-private metrics remain scoped by organization_id.
- [ ] Validate role-based access to organization analytics.

### Phase 4 exit gate

- [ ] Privacy review passes.
- [ ] Aggregate-only assertions pass.

## Phase 5: Test and validation

### Unit and integration tests

- [ ] Add tests for role permissions by organization scope.
- [ ] Add tests for organization mismatch denial.
- [ ] Add tests for principal resolution with inactive membership.
- [ ] Add tests for organization-admin endpoint scoping.

### Security and isolation tests

- [ ] Add negative tests for cross-organization data access attempts.
- [ ] Add token/session misuse tests across organizations.
- [ ] Add audit coverage tests for sensitive operations.

### Data and migration tests

- [ ] Migration dry run in staging-like environment.
- [ ] Backfill correctness validation script.
- [ ] Post-migration integrity validation script.

### Acceptance test suite

- [ ] Platform-owner aggregate visibility test.
- [ ] Organization admin domain control test.
- [ ] Coach athlete-assignment and org-boundary test.
- [ ] Athlete self-data-only test.
- [ ] Parent dependent-data-only test.

### Phase 5 exit gate

- [ ] Test suite passes in CI.
- [ ] No critical isolation defects.

## Phase 6: Deployment and rollout

### Pre-rollout

- [x] Prepare release notes and migration runbook.
- [x] Prepare rollback runbook.
- [ ] Approve change window.

### Rollout execution

- [ ] Apply migrations in production order.
- [ ] Deploy service changes.
- [ ] Run smoke tests for auth, role gates, and org boundaries.

### Post-rollout

- [ ] Validate audit stream health.
- [ ] Validate analytics separation in production.
- [ ] Capture incident watch for first 72 hours.

### Phase 6 exit gate

- [ ] Production validation checklist complete.
- [ ] No unresolved P0/P1 issues.

## Phase 7: Stabilization and operations

- [ ] Define org onboarding operational SLA.
- [ ] Define membership change audit review cadence.
- [ ] Define quarterly role-policy review.
- [ ] Define privacy and analytics access recertification cadence.
- [ ] Define post-incident isolation forensics playbook.

## RACI starter (fill in owners)

- [ ] Platform Owner approvals: Jason Neale
- [ ] Data migrations owner: ______
- [ ] Service implementation owner: ______
- [ ] QA/security validation owner: ______
- [ ] Release manager owner: ______

## Final definition of done

- [ ] Multi-organization data isolation is enforced for all private domains.
- [ ] Platform owner can manage organizations while seeing aggregate-only metrics by default.
- [ ] Organization admins can manage only their own organization.
- [ ] Role and authorization behavior is verified by automated tests.
- [ ] Audit trail covers organization and membership lifecycle actions end-to-end.
