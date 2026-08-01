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

Note: coach-level constraints are not a default for any other role. A coach's
permissions are athlete-scoped, so borrowing them hands a role the named
athlete records it is not entitled to. `volunteer` and `staff` are not detailed
in the permission matrix below and each route's own guard is the authority for
them. `board` is detailed below, and its contract is narrower than every other
role's — read [Board](#board) before building anything a board member can open.

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

`board` sits outside this ladder rather than on a rung of it: it is an
organization-level oversight role with no athlete-scoped authority at all, so it
is neither above nor below coach. `volunteer` and `staff` work from their own
workspace and likewise carry no coaching assignment.

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

### Board

The board role is AGGREGATE-ONLY. A board member never sees athlete-scoped or
individually identifiable youth data.

[access.ts](apps/web/src/server/pilot/access.ts) is the authority for this role,
not this document. `assertActorCanAccessAthlete` throws for `board` before any
other branch and before any athlete lookup is attempted, and
[boardRoleBoundaries.test.ts](apps/web/src/server/pilot/boardRoleBoundaries.test.ts)
holds that at 403 across seven surfaces: the athlete record, goals, training
sessions, the intake review queue, admin capabilities, compliance violations,
and the scheduler.

Allowed inside own organization:

- organization-level aggregates that clear the k-anonymity floor. The floor is
  `BOARD_MINIMUM_COHORT_SIZE = 5` in
  [boardSummary.ts](apps/web/src/server/pilot/boardSummary.ts): a metric whose
  cohort is smaller than five reports `insufficient_data` and carries a null
  count. Any new board aggregate passes through that gate or an equivalent one.
- board seat assignments (`pilot.board_seats`), which describe an adult board
  member's own appointment and hold no athlete identifier of any kind — see
  [docs/BOARD_SEAT_ASSIGNMENT.md](docs/BOARD_SEAT_ASSIGNMENT.md)

Denied:

- every athlete record, and every list, queue, export, or report scoped to one
  athlete
- SHADOW chat. `/api/pilot/shadow/chat` does not admit the role, and
  `/api/pilot/board/chat` is a legacy compatibility URL that carries the board's
  name without granting it access. Board SHADOW context is deliberately empty;
  re-opening it requires re-deriving the aggregate boundary from scratch.
- any payload blob, `entity_id`, or `actor_account_id` in a board-facing view —
  `entity_id` is an athlete_id for many event types
- named outcomes at any cohort size. Five is the floor for reporting a count,
  not a threshold that releases identities: nothing unlocks a youth's name to
  the board when a cohort grows.

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

- deny an athlete-scoped resource to `board` first, before organization scope is
  even compared: a matching organization_id does not earn the board role access
  to an individual youth record.
- deny when organization_id does not match, unless the actor is platform_owner
  (standing cross-organization visibility into de-identified data during
  pilot, plus explicit aggregate-analytics actions).
