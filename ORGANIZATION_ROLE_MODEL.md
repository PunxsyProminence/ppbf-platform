# Organization Role Model

## Roles

Live enum: `PilotRole` in [apps/web/src/server/pilot/contracts.ts](apps/web/src/server/pilot/contracts.ts).

- platform_owner
- organization_admin
- admin (legacy-compatible with organization_admin, see [access.ts](apps/web/src/server/pilot/access.ts))
- board
- coach
- athlete
- parent
- volunteer
- staff

Note: `board`, `volunteer`, and `staff` exist in the live enum but are not
separately detailed in the permission matrix below — treat coach-level
constraints as the closest default until a dedicated matrix entry is written.

## Role hierarchy and authority

1. platform_owner
   - global organization lifecycle and aggregate analytics
2. organization_admin
   - user lifecycle and organization-level operations
3. coach
   - coaching operations in own organization
4. athlete
   - self data in own organization
5. parent
   - linked dependent data in own organization

## Permission matrix

### Platform Owner

Allowed (pilot phase — see [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md#platform-owner-boundary)):

- create organization
- assign organization admin
- activate/deactivate organization
- view platform totals and anonymous benchmarks
- standing cross-organization visibility into de-identified data, for pilot
  operations and SHADOW's cross-platform ML/formula learning

Still gated regardless of the above:

- SHADOW medical-administrative-status writes remain isolated to their own
  module (`shadow_medical_administrative_status`) — this boundary is not
  loosened by Platform Owner's data visibility

### Organization Admin

Allowed inside own organization:

- create users
- create and manage coaches
- create and manage athletes
- create and manage parents
- manage volunteers and staff
- reset credentials
- manage organization users
- view organization datasets

Denied:

- access to other organizations
- platform owner controls

### Coach

Allowed inside own organization:

- assigned athlete operations
- training logs and reviews

Denied:

- cross-organization access
- organization admin controls

### Athlete

Allowed:

- own records within organization scope

Denied:

- other athlete records
- administrative controls

### Parent

Allowed:

- linked dependent records within organization scope

Denied:

- unrelated athlete records
- administrative controls

## Enforcement model

Authorization decision inputs:

- actor role
- actor organization_id
- resource organization_id
- ownership relation (for coach, athlete, parent)

Decision rule:

- deny when organization_id does not match, unless the actor is platform_owner
  (standing cross-organization visibility into de-identified data during
  pilot, plus explicit aggregate-analytics actions).
