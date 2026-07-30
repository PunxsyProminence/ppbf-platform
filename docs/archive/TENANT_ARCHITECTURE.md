# Tenant Architecture

## Current State

The current SQL inventory does not contain tenant isolation fields. None of the repository SQL files define a `tenant_id` column today.

Relevant files:

- [infra/supabase/schema.sql](infra/supabase/schema.sql)
- [infra/supabase/ppbf_core_schema.sql](infra/supabase/ppbf_core_schema.sql)
- [infra/supabase/pilot_slice_schema.sql](infra/supabase/pilot_slice_schema.sql)
- [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql)

## Tenant Ownership Model

Use a shared-schema, tenant-scoped model:

- Every multi-gym row carries `tenant_id`.
- Every authenticated principal carries a tenant identifier in the server session.
- Every write path validates that the actor belongs to the same tenant.
- Every read path filters by `tenant_id` before any role-specific logic is applied.

## Required Tables

The following table families need tenant-scoped design:

- Users
- Athletes
- Attendance
- Readiness
- Documents
- Messages
- Assessments
- Skills

Minimum requirement for each table:

- `tenant_id` column
- index on `tenant_id`
- foreign-key relationship to a tenant table where appropriate
- RLS or equivalent server enforcement for tenant scope

## Isolation Rules

1. No cross-tenant reads unless the operation is explicitly platform-admin scoped.
2. No cross-tenant writes.
3. Related child records must inherit the same `tenant_id` as their parent.
4. Any background job, import, or report must propagate the tenant context explicitly.
5. Storage paths, documents, and message threads must remain tenant-scoped.

## Query Filtering Requirements

- All list queries must filter on `tenant_id` first.
- All lookup queries must verify both the record key and tenant scope.
- All join chains must preserve tenant filters through every hop.
- Any cached or paginated data must include the tenant key in the cache identity.

## Schema Shape

Recommended pattern for core rows:

```sql
tenant_id uuid not null
```

For every tenant-owned table:

- add `tenant_id`
- index `tenant_id`
- add composite uniqueness where needed, such as `(tenant_id, external_id)`
- avoid global uniqueness unless the value is truly platform-global

## Future Scaling Considerations

- Start with shared schema and strong tenant filters.
- Add tenant-aware RLS and server enforcement before any migration to schema-per-tenant.
- Keep identifiers tenant-safe so future shard or database splits remain possible.
- Separate platform admin operations from tenant operations at the service boundary.

## Relationship to Current Auth Work

Tenant isolation depends on the auth refactor first:

- the backend must know the authenticated principal
- the principal must carry tenant context
- the frontend must not be the source of tenant trust
