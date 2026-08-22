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

- **Organization-private athlete records.** `assertActorCanAccessAthlete`
  refuses `platform_owner` unconditionally, and refuses it *first* — ahead of
  `board` and ahead of any organization comparison (access.ts:316-318,
  `Forbidden: platform owner cannot access organization-private athlete records
  by default`). The batched counterpart `accessibleAthleteIds` returns an empty
  set for the same role and says so in its own comment (access.ts:372-376). The
  cross-organization visibility above is **de-identified and aggregate**; it is
  not a key to an individual youth record, and the two must never be collapsed.
  See [Enforcement model](#enforcement-model).
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
not this document. `assertActorCanAccessAthlete` throws for `board` in its
**second** branch — `platform_owner` is refused first — and, like that first
refusal, before any athlete lookup is attempted and before organization scope is
compared at all.
[boardRoleBoundaries.test.ts](apps/web/src/server/pilot/boardRoleBoundaries.test.ts)
holds that at 403 across **twelve** surfaces: the athlete record, goals,
training sessions, the intake review queue, admin capabilities, safety and
compliance violations, the athlete scheduler, safety escalations, wrestling
league seasons, the league roster, external competitions, and competition
entries.

**Corrected 2026-08-22.** This paragraph said `board` was refused "before any
other branch" and that the test held seven surfaces. Measured, both were wrong:
`platform_owner` is the first branch (access.ts:316-318) and the test is a
`test.each` of twelve cases. Nothing about the board boundary itself changed —
only its position in the ladder, and the size of the proof standing under it.

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

- deny an athlete-scoped resource to `platform_owner` **first**, before
  organization scope is even compared. `assertActorCanAccessAthlete` opens with
  it (access.ts:316-318) and takes no argument from organization_id, from the
  role ladder above, or from the pilot-phase visibility in
  [Platform Owner](#platform-owner).
- deny an athlete-scoped resource to `board` **second**, and likewise before
  organization scope is compared: a matching organization_id does not earn the
  board role access to an individual youth record.
- for every other role, deny when organization_id does not match. **There is no
  platform_owner exemption at this step for an athlete-scoped resource** — that
  actor was already refused two branches earlier.

**Corrected 2026-08-22.** The second bullet used to read "deny when
organization_id does not match, unless the actor is platform_owner". That
inverted the guard on the exact records it exists to protect: anyone writing a
new athlete-scoped route against this section would have written the exemption
back in and handed the platform owner every minor's record in every
organization. The code has never behaved that way — the refusal is
unconditional and is the function's first branch. What the pilot-phase
visibility genuinely covers is de-identified, aggregate, cross-organization
data; it was never athlete-record access.
