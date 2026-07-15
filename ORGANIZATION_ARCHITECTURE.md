# Organization Architecture

## Objective state

Transform PPBF into a multi-organization platform with strict organization isolation and platform-level aggregate observability.

## Governance hierarchy

1. Platform Owner (Jason Neale)
2. Organization Admin
3. Coach
4. Athlete
5. Parent

## Core architecture principles

1. Every private record is organization-owned.
2. Organization data is invisible outside its organization unless explicitly delegated.
3. Platform Owner sees aggregate metrics by default, not private organization content.
4. Organization membership is authoritative and required for every authenticated user.
5. Authorization is role + organization scoped.

## Organization boundary model

Boundary is enforced in three layers:

1. Data layer
   - organization_id column on every organization-owned table
   - foreign keys to organization table
   - indexes including organization_id for all access paths
2. Service layer
   - principal contains organization_id and role
   - all queries include organization predicate
3. Policy layer
   - role permissions evaluated within organization scope
   - platform owner permissions evaluated in platform scope

## Platform owner boundary

Platform Owner can:

- create organizations
- assign organization admins
- activate and deactivate organizations
- view platform aggregates and benchmarks

Platform Owner cannot automatically view organization-private content such as:

- private messages
- medical and emergency records
- private athlete notes
- internal organization documents

unless explicit delegated permission is granted and audited.

## Analytics separation

Two analytics planes:

1. Platform analytics plane
   - aggregate and anonymous only
   - no direct PII dependency
2. Organization analytics plane
   - full organization-private metrics
   - visible to organization admins and permitted roles only

## Reuse strategy from current codebase

Reuse existing pilot service structure:

- [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts)
- [apps/web/src/server/pilot/access.ts](apps/web/src/server/pilot/access.ts)
- [apps/web/src/server/pilot/entities.ts](apps/web/src/server/pilot/entities.ts)
- [apps/web/src/server/pilot/db.ts](apps/web/src/server/pilot/db.ts)

Adjustment pattern:

- extend principal with organization_id and platform_role
- add organization filters to all entity queries
- split global admin into platform owner and organization admin behaviors

## Scaling model

Phase 1:

- shared schema with strict organization_id enforcement

Phase 2:

- optional partitioning/sharding by organization_id for high-scale workloads

Phase 3:

- optional organization-specific data services where needed without changing authorization contracts
