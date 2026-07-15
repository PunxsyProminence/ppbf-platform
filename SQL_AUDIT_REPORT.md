# SQL Audit Report

## Scope

Reviewed SQL files:

- [infra/supabase/schema.sql](infra/supabase/schema.sql)
- [infra/supabase/ppbf_core_schema.sql](infra/supabase/ppbf_core_schema.sql)
- [infra/supabase/pilot_slice_schema.sql](infra/supabase/pilot_slice_schema.sql)
- [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql)

## Findings

### 1. No tenant isolation columns exist

None of the reviewed SQL files define `tenant_id`. That means the current schema cannot enforce multi-gym isolation yet.

Affected files:

- [infra/supabase/schema.sql](infra/supabase/schema.sql)
- [infra/supabase/ppbf_core_schema.sql](infra/supabase/ppbf_core_schema.sql)
- [infra/supabase/pilot_slice_schema.sql](infra/supabase/pilot_slice_schema.sql)
- [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql)

### 2. Supabase-specific auth dependency is not portable as-is

[infra/supabase/schema.sql](infra/supabase/schema.sql) references `auth.users`, which is a Supabase auth schema dependency. That makes the file non-portable to a standalone Azure PostgreSQL database without an equivalent auth layer.

### 3. Supabase extension dependency needs a supported deployment target

[infra/supabase/schema.sql](infra/supabase/schema.sql) enables `uuid-ossp`. That is valid in PostgreSQL when the extension is available, but the deployment pipeline must ensure the target environment supports it.

### 4. pilot_slice schema is duplicated for two targets

[infra/supabase/pilot_slice_schema.sql](infra/supabase/pilot_slice_schema.sql) and [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql) are currently the same schema content. That creates a maintenance risk because any change must be duplicated manually.

### 5. pilot_slice schema is not tenant-aware

Both pilot slice files model a single global `pilot` namespace with accounts, athletes, sessions, coach reviews, shadow intake, and audit events, but no tenant discriminator.

### 6. Audit and session tables are global

The `pilot.audit_events` and `pilot.session_tokens` tables are global in the current model. That is workable for a single gym, but it is not enough for tenant isolation.

## PostgreSQL Compatibility Notes

- The reviewed DDL uses standard PostgreSQL constructs such as `timestamptz`, `jsonb`, and identity columns.
- The main compatibility concern is not syntax alone; it is the assumed surrounding platform.
- `infra/supabase/schema.sql` assumes Supabase auth tables and extensions.
- `infra/azure/pilot_slice_postgres.sql` should be checked against the exact Azure PostgreSQL deployment process to confirm extension support and migration order.

## Migration Issues

- There is no tenant migration path because no tenant columns exist yet.
- The pilot slice schema would need data backfill before tenant enforcement can be added.
- Any future split between shared auth and tenant data should preserve account/session continuity.

## Azure PostgreSQL Concerns

- Verify extension availability before relying on `uuid-ossp` in Azure.
- Confirm the target auth layer before using `auth.users`-style references.
- Keep migrations idempotent and ordered so they can run cleanly in CI/CD.

## Result

No schema files were modified for this audit. The main blocking items are tenant absence, Supabase portability assumptions, and duplicate pilot schema maintenance.
