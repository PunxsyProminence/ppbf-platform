# Organization Role Model

## Target roles

- platform_owner
- organization_admin
- coach
- athlete
- parent
- volunteer
- staff

## Current role mismatch to resolve

Current backend role enum in [apps/web/src/server/pilot/contracts.ts](apps/web/src/server/pilot/contracts.ts) is limited to:

- admin
- coach
- athlete

Current UI role set in [apps/web/components/roleRoutes.ts](apps/web/components/roleRoutes.ts) includes board and parent variants not represented in pilot backend role contracts.

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

Allowed:

- create organization
- assign organization admin
- activate/deactivate organization
- view platform totals and anonymous benchmarks

Denied by default:

- private messages
- medical records
- emergency contacts
- private athlete notes
- internal organization documents

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

- deny when organization_id does not match unless operation is explicit platform-owner aggregate analytics action.
