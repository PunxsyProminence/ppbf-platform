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
2. Organization data is invisible outside its organization to every role except
   Platform Owner (see Platform owner boundary below for the pilot-phase
   exception and its de-identification requirement).
3. Organization membership is authoritative and required for every authenticated user.
4. Authorization is role + organization scoped, with Platform Owner scoped to
   the platform as a whole.

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

**Current intent (pilot phase):** Platform Owner has standing cross-organization
visibility into platform data, bounded by law rather than an internal
org-isolation wall. This is deliberate, for two reasons:

1. Operational — Jason needs to navigate and fix issues across organizations
   while the app is being polished during pilot.
2. SHADOW's ML/formula engine needs to learn training cause-and-effect
   patterns across the whole platform, not be blind within one organization's
   silo.

Data used this way has personal identifiers stripped permanently
(irreversibly, not just masked) rather than relying on organization boundaries
for privacy. This is the current stance and may change later (e.g.
consent-based re-identification), but nothing beyond this is currently
planned. Whether cross-org visibility narrows back to per-organization
isolation once the platform moves past pilot, or a paid-tier customization
model, is an open question — not yet decided.

This does not weaken the SHADOW medical-status write-isolation gate
(`shadow_medical_administrative_status`): medical data is the category most
likely to carry real legal constraints even after de-identification, and that
gate is deliberately strict-by-construction independent of this boundary.

Platform Owner can additionally:

- create organizations
- assign organization admins
- activate and deactivate organizations
- view platform aggregates and benchmarks

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
