# Organization Migration Plan

## Goal

Introduce organization ownership and role hierarchy with minimal disruption and maximum reuse of current pilot services.

## Phase sequence

### Phase 0: Preparation

1. Add organizations and organization_memberships tables.
2. Seed platform owner identity for Jason Neale.
3. Define default initial organization for current single-gym records.

### Phase 1: Schema extension

1. Add organization_id to all existing private tables.
2. Backfill organization_id for existing records using default initial organization.
3. Add indexes and uniqueness constraints with organization_id.

### Phase 2: Service contract extension

1. Extend principal model to include organization_id and platform role context.
2. Extend auth token resolution path to assert active membership.
3. Extend role checks to include organization boundary checks.

### Phase 3: Query hardening

1. Update all entity queries in [apps/web/src/server/pilot/entities.ts](apps/web/src/server/pilot/entities.ts) to include organization filters.
2. Update admin endpoints to scope writes and reads to organization.
3. Ensure audit and shadow intake writes include organization context.

### Phase 4: Workflow cutover

1. Enable organization creation and admin assignment flow.
2. Shift user creation to organization admin workflow.
3. Validate no cross-organization visibility for all private domains.

### Phase 5: Analytics separation

1. Build platform aggregate views from organization-scoped fact tables.
2. Remove direct PII dependency from platform aggregate metrics.

## Table-by-table migration checklist

### Existing tables to alter

- profiles
- participants
- sessions
- coach_reviews
- safety_gates
- athlete_voice
- physical_training_logs
- continuity_ledger
- public.user_profiles
- pilot.accounts
- pilot.session_tokens
- pilot.athletes
- pilot.goals
- pilot.sessions
- pilot.coach_reviews
- pilot.shadow_intake
- pilot.audit_events

### New tables to create

- organizations
- organization_memberships
- parents
- volunteers
- staff
- attendance
- readiness
- assessments
- documents
- messages
- skills

## Backfill approach

1. Create one bootstrap organization for current records.
2. Map all existing users/accounts to that organization.
3. Propagate organization_id to dependent rows through joins.
4. Validate referential integrity before enabling stricter constraints.

## Rollout safety checks

1. Verify query plans use organization indexes.
2. Verify cross-organization access attempts are denied.
3. Verify platform owner aggregate analytics remain available.
4. Verify private-domain visibility remains organization-scoped.

## No-redesign reuse guidance

Reuse current pilot architecture and expand by adding organization context at boundaries rather than replacing service modules.
