# Organization Impact Report

## Scope audited

Schema and backend surfaces reviewed:

- [infra/supabase/schema.sql](infra/supabase/schema.sql)
- [infra/supabase/ppbf_core_schema.sql](infra/supabase/ppbf_core_schema.sql)
- [infra/supabase/pilot_slice_schema.sql](infra/supabase/pilot_slice_schema.sql)
- [infra/azure/pilot_slice_postgres.sql](infra/azure/pilot_slice_postgres.sql)
- [apps/web/src/server/pilot/entities.ts](apps/web/src/server/pilot/entities.ts)
- [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts)
- [apps/web/src/server/pilot/access.ts](apps/web/src/server/pilot/access.ts)
- [apps/web/src/server/pilot/contracts.ts](apps/web/src/server/pilot/contracts.ts)

## Executive summary

Current data model is single-organization. There is no organization or tenant discriminator in active SQL tables, no organization membership table, and no platform owner role in backend contracts. Multi-organization isolation cannot be enforced yet.

## Existing tables requiring organization ownership

### Supabase merged schema tables

- profiles
- participants
- sessions
- coach_reviews
- safety_gates
- athlete_voice
- physical_training_logs
- continuity_ledger

All of the above require organization ownership for isolation.

### Supabase core schema tables

- public.user_profiles

This table requires organization ownership and role scoping by organization.

### Pilot schema tables

- pilot.accounts
- pilot.session_tokens
- pilot.athletes
- pilot.goals
- pilot.sessions
- pilot.coach_reviews
- pilot.shadow_intake
- pilot.audit_events

All of the above require organization context to prevent cross-organization access.

## Domain tables explicitly requested that are not yet present as organization-aware entities

No dedicated organization-aware tables currently exist for:

- parents
- volunteers
- staff
- attendance
- readiness (as a distinct domain table)
- documents (general document domain outside shadow intake)
- messages
- skills
- assessments (as a distinct domain table)

These should be introduced as organization-owned entities in the database plan.

## API and service impact by organization ownership

### Authentication and principal resolution

- [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts)
  - Login and principal resolution must include organization membership validation.
- [apps/web/src/server/pilot/contracts.ts](apps/web/src/server/pilot/contracts.ts)
  - Role model currently supports only admin/coach/athlete.

### Authorization

- [apps/web/src/server/pilot/access.ts](apps/web/src/server/pilot/access.ts)
  - Access checks currently enforce role and athlete assignment, but not organization isolation.

### Entity persistence

- [apps/web/src/server/pilot/entities.ts](apps/web/src/server/pilot/entities.ts)
  - Queries currently key by athlete/session/goal IDs without organization filter predicates.

### Administrative endpoints

- [apps/web/app/api/pilot/admin/athlete-accounts/route.ts](apps/web/app/api/pilot/admin/athlete-accounts/route.ts)
- [apps/web/app/api/pilot/admin/accounts/pin-reset/route.ts](apps/web/app/api/pilot/admin/accounts/pin-reset/route.ts)
- [apps/web/app/api/pilot/admin/accounts/revoke/route.ts](apps/web/app/api/pilot/admin/accounts/revoke/route.ts)

These endpoints need organization ownership constraints and organization-admin scoping.

## Platform owner requirement impact

Requested owner is Jason Neale as Platform Owner. Current backend role model does not include a platform-level role distinct from organization-level admin.

Required additions:

- Platform owner role
- Organization admin role
- Explicit organization membership model
- Platform-level analytics boundary separate from organization-private data

## Isolation risk if unchanged

If current model is reused without organization ownership:

- Athlete and account identifiers can collide across organizations
- Role checks can authorize across organization boundaries
- Session and audit data cannot be partitioned safely
- Document and messaging privacy guarantees cannot be met

## Conclusion

All active user, auth, athlete, training, review, document intake, and audit tables require organization ownership changes. New organization and membership tables are mandatory for isolation and scalable multi-organization operation.
