# Multi-Organization Migration Runbook

## Objective
Apply multi-organization schema changes, seed bootstrap organization ownership, and validate isolation boundaries.

## Preconditions
- Approved change window.
- Backup and recovery path validated.
- Environment variables available:
  - AZURE_POSTGRES_CONNECTION_STRING
  - AZURE_STORAGE_CONNECTION_STRING
  - PPBF_PILOT_BOOTSTRAP_KEY
  - PPBF_PILOT_DEFAULT_ORG_ID (recommended)
- Application deployed with multi-org pilot API code.

## Migration artifacts
- Base schema: [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql)
- Additive migration: [infra/azure/pilot_slice_postgres_multiorg_migration.sql](infra/azure/pilot_slice_postgres_multiorg_migration.sql)
- Migration runner: [apps/web/scripts/pilot-apply-multiorg-migration.mjs](apps/web/scripts/pilot-apply-multiorg-migration.mjs)
- Multi-org gate: [apps/web/scripts/pilot-multiorg-gate.mjs](apps/web/scripts/pilot-multiorg-gate.mjs)

## Step-by-step execution
1. Run preflight checks.
   - Command: npm --prefix apps/web run pilot:preflight
2. Apply additive multi-org migration.
   - Command: npm --prefix apps/web run pilot:apply-multiorg
3. Build verification.
   - Command: npm --prefix apps/web run build
4. Execute multi-org API gate (requires running app endpoint and bootstrap key).
   - Command: npm --prefix apps/web run gate:pilot:multiorg

## Expected outcomes
- New tables exist:
  - pilot.organizations
  - pilot.organization_memberships
  - pilot.parents
  - pilot.volunteers
  - pilot.staff
  - pilot.attendance
  - pilot.readiness
  - pilot.assessments
  - pilot.documents
  - pilot.messages
  - pilot.skills
- Existing pilot tables have organization_id ownership populated.
- Duplicate athlete_id values are allowed across different organizations.
- Platform-owner org lifecycle endpoints are functional.
- Organization-private endpoint access is not available to platform owner by default.

## SQL verification queries
1. Check ownership nulls:
```sql
select 'accounts' as table_name, count(*) as null_org from pilot.accounts where organization_id is null
union all
select 'session_tokens', count(*) from pilot.session_tokens where organization_id is null
union all
select 'athletes', count(*) from pilot.athletes where organization_id is null
union all
select 'goals', count(*) from pilot.goals where organization_id is null
union all
select 'sessions', count(*) from pilot.sessions where organization_id is null
union all
select 'coach_reviews', count(*) from pilot.coach_reviews where organization_id is null
union all
select 'shadow_intake', count(*) from pilot.shadow_intake where organization_id is null;
```
2. Verify memberships seeded:
```sql
select organization_id, role, count(*)
from pilot.organization_memberships
group by organization_id, role
order by organization_id, role;
```
3. Verify organization-scoped athlete duplicates supported:
```sql
select athlete_id, count(distinct organization_id) as org_count
from pilot.athletes
group by athlete_id
having count(distinct organization_id) > 1;
```

## Sign-off checklist
- Migration logs captured.
- Gate output captured.
- SQL verification output captured.
- Production deployment approved.
