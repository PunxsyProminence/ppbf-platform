# Phase-0 Implementation Spec

## Purpose

Convert the organization foundation analysis into an execution-ready Phase-0 plan without implementing runtime code in this step.

## Source reports

- [ORGANIZATION_IMPACT_REPORT.md](ORGANIZATION_IMPACT_REPORT.md)
- [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md)
- [ORGANIZATION_DATABASE_PLAN.md](ORGANIZATION_DATABASE_PLAN.md)
- [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md)
- [ORGANIZATION_MIGRATION_PLAN.md](ORGANIZATION_MIGRATION_PLAN.md)
- [ORGANIZATION_ADMIN_WORKFLOW.md](ORGANIZATION_ADMIN_WORKFLOW.md)

## Operating constraints

1. Reuse current pilot service architecture; avoid redesign.
2. Enforce strict cross-organization isolation.
3. Include Platform Owner identity (Jason Neale).
4. Keep platform analytics aggregate-only by default.

## Phase-0 deliverables

1. Canonical role dictionary and authority boundaries.
2. Canonical table ownership matrix (existing + required new domain tables).
3. SQL migration design package (DDL plan, backfill plan, constraints/index plan).
4. Service contract delta spec (principal/auth/access/entity filters).
5. Organization lifecycle workflow spec (create, assign admin, activate, user bootstrap).
6. Verification protocol and acceptance gates.

## Work packages

### WP0.1 Governance and role canon

Actions:

1. Finalize role set:
   - platform_owner
   - organization_admin
   - coach
   - athlete
   - parent
   - volunteer
   - staff
2. Define explicit deny-by-default cross-organization rule.
3. Define platform-owner private-data restrictions and delegated-access policy.

Acceptance criteria:

1. A signed role matrix exists with allowed and denied operations per role.
2. Platform-owner aggregate-only default is explicitly documented.
3. Every role operation is organization-scoped unless explicitly marked platform-scope.

Dependencies:

- [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md)
- [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md)

### WP0.2 Data ownership and isolation matrix

Actions:

1. Catalog all existing organization-owned tables.
2. Catalog required new domain tables:
   - parents
   - volunteers
   - staff
   - attendance
   - readiness
   - assessments
   - documents
   - messages
   - skills
3. Define organization_id requirement, FK intent, and uniqueness intent per table.

Acceptance criteria:

1. Every private table is marked organization-owned.
2. Every table has a clear key strategy (PK + organization-scoped uniqueness where needed).
3. No domain table remains unscoped to organization ownership.

Dependencies:

- [ORGANIZATION_IMPACT_REPORT.md](ORGANIZATION_IMPACT_REPORT.md)
- [ORGANIZATION_DATABASE_PLAN.md](ORGANIZATION_DATABASE_PLAN.md)

### WP0.3 Migration blueprint design

Actions:

1. Define DDL order for organizations and organization_memberships first.
2. Define additive migration sequence for organization_id across existing tables.
3. Define backfill strategy using bootstrap organization.
4. Define index and constraint rollout strategy.

Acceptance criteria:

1. Migration order is deterministic and reversible with rollback notes.
2. Backfill strategy maps all existing user/account/private records to bootstrap organization.
3. Constraint enablement sequencing avoids lockout risk during transition.

Dependencies:

- [ORGANIZATION_MIGRATION_PLAN.md](ORGANIZATION_MIGRATION_PLAN.md)
- [ORGANIZATION_DATABASE_PLAN.md](ORGANIZATION_DATABASE_PLAN.md)

### WP0.4 Service boundary delta spec

Actions:

1. Extend principal contract spec to include organization_id and platform context.
2. Specify auth resolution requirement for active organization membership.
3. Specify access check requirement: role + organization + ownership relation.
4. Specify entity query requirement: mandatory organization predicates.

Key code surfaces impacted later (for implementation phase):

- [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts)
- [apps/web/src/server/pilot/access.ts](apps/web/src/server/pilot/access.ts)
- [apps/web/src/server/pilot/entities.ts](apps/web/src/server/pilot/entities.ts)
- [apps/web/src/server/pilot/contracts.ts](apps/web/src/server/pilot/contracts.ts)

Acceptance criteria:

1. Contract deltas are documented for all auth/access/entity boundaries.
2. All read/write operations specify organization filter behavior.
3. Admin endpoints are explicitly organization-admin scoped.

Dependencies:

- [ORGANIZATION_IMPACT_REPORT.md](ORGANIZATION_IMPACT_REPORT.md)
- [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md)

### WP0.5 Organization lifecycle workflow spec

Actions:

1. Define create-organization workflow.
2. Define assign-organization-admin workflow.
3. Define organization activation/deactivation workflow.
4. Define organization-admin user onboarding workflow.

Acceptance criteria:

1. End-to-end workflow sequence is complete and testable.
2. Actor permissions are defined for each workflow step.
3. Audit event requirements are specified for each action.

Dependencies:

- [ORGANIZATION_ADMIN_WORKFLOW.md](ORGANIZATION_ADMIN_WORKFLOW.md)

### WP0.6 Verification and release gates

Actions:

1. Define non-functional verification gates:
   - isolation gate
   - role boundary gate
   - analytics separation gate
2. Define minimum test cases required before implementation rollout.
3. Define data privacy checks for platform dashboards.

Acceptance criteria:

1. Cross-organization data access attempts are expected-deny by design.
2. Platform-owner views are aggregate-only by default.
3. Organization-private domains require organization-scoped authorization.

Dependencies:

- [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md)
- [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md)

## Required artifacts checklist

1. Role and permissions matrix (final).
2. Table ownership matrix (existing + new).
3. SQL migration package design (ordered scripts + rollback notes).
4. Service contract delta document.
5. Organization lifecycle and admin workflow runbook.
6. Validation test plan for isolation and analytics boundaries.

## Phase-0 exit criteria

Phase-0 is complete only when all conditions below are true:

1. Organization ownership design is complete for all private domains.
2. Role model is finalized with platform-owner constraints.
3. Migration plan is implementation-ready (order, backfill, constraints, rollback intent).
4. Service-layer contract deltas are implementation-ready.
5. Verification gates and test-plan baseline are approved.

## Explicit non-goals in this document

1. No runtime code changes.
2. No schema migration execution.
3. No deployment changes.
4. No UI feature implementation.
