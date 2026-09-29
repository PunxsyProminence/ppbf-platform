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

Note: the enum above is not the whole cross-organization story. A second,
account-level dimension exists — `has_master_shadow_access` on `pilot.accounts`
— and it carries standing cross-organization reach without appearing in
`PilotRole` at all. Read
[Master SHADOW access](#master-shadow-access-account-flag-not-a-role) before
reasoning about tenant isolation from this list.

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

`has_master_shadow_access` sits outside the ladder too, and differently: it is
not a rung, not a role, and it does not change its holder's role. It is a flag
an account either carries or does not, added on top of whatever rung that
account already stands on.

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

### Master SHADOW access (account flag, not a role)

`has_master_shadow_access` is a `boolean not null default false` column on
`pilot.accounts`. It is the only cross-organization privilege in this model
besides `platform_owner`, and it is not a role: it is not a value of
`PilotRole`, it is not a row in `pilot.organization_memberships`, and it is not
scoped to an organization at all.
[auth.ts](apps/web/src/server/pilot/auth.ts) is the authority for it, not this
document.

How it is read:

- `resolvePrincipal` selects it on every request and carries it on the
  principal as `hasMasterShadowAccess`; both login paths read it the same way.
  It is deliberately never cached on the session token, so a revoke takes
  effect on the holder's next request and there is no session to invalidate.

Who may grant or revoke it:

- `platform_owner` only, through
  [POST /api/pilot/platform/users/master-shadow-access](apps/web/app/api/pilot/platform/users/master-shadow-access/route.ts),
  gated `requireRole(principal, ['platform_owner'])` — the same bar as
  assign-admin, transfer-admin, organizations/status and users/status. That
  route is the application's only write path for the column; before it existed,
  the only way an account held the flag was a direct database write.

What refuses it:

- athlete and parent accounts, outright. The `UPDATE` statement itself carries
  `role not in ('athlete', 'parent')`, so such a target matches zero rows and
  the call throws. The refusal lives in the statement rather than in the route,
  so a later caller cannot skip it by forgetting to repeat it
  ([auth.masterShadowAccess.test.ts](apps/web/src/server/pilot/auth.masterShadowAccess.test.ts)).
- an ineligible target and a nonexistent one return the same `Not found`
  message, so the response cannot be used to learn which account IDs exist.

Audited:

- both directions. Grant and revoke each write a pilot audit event
  (`event_type: 'update'`, `entity_type: 'account'`, `entity_id` the target
  account, `details.action` of `grant_master_shadow_access` or
  `revoke_master_shadow_access`) naming the acting platform owner
  ([route.test.ts](apps/web/app/api/pilot/platform/users/master-shadow-access/route.test.ts)).

Allowed:

- one route today:
  [GET /api/pilot/shadow/research-bridge/session-export](apps/web/app/api/pilot/shadow/research-bridge/session-export/route.ts).
  The flag widens that route from the caller's own organization to every
  organization on record except the reserved platform-library organization,
  regardless of organization status, and it is checked before the
  organization-admin branch so a holder is never silently narrowed back to its
  own organization. Scope is derived from the principal, never from a request
  parameter.

Denied:

- any widening of the payload itself. The export is the same
  `buildResearchBridgeExport` output the organization-scoped branch returns:
  de-identified research needs and approved evidence, opaque hashed IDs,
  redacted free text, and any research need carrying a subject link
  (`subject_id`, `athlete_id`, `account_id`, `parent_id`, `guardian_id`)
  filtered out. The flag widens organization scope; it does not lift
  de-identification.
- every other surface. Nothing else in the codebase reads
  `hasMasterShadowAccess` — it does not admit its holder to athlete records,
  SHADOW chat, organization admin controls, or any Platform Owner action above.

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
- actor `has_master_shadow_access` (account-level, read live per request)
- resource organization_id
- ownership relation (for coach, athlete, parent)

Decision rule:

- deny an athlete-scoped resource to `board` first, before organization scope is
  even compared: a matching organization_id does not earn the board role access
  to an individual youth record.
- deny when organization_id does not match, unless the actor holds one of the
  two standing cross-organization privileges. Role is only the first of them:
  - `platform_owner` — standing cross-organization visibility into
    de-identified data during pilot, plus explicit aggregate-analytics actions.
  - `has_master_shadow_access` on the actor's account — standing
    cross-organization reach into de-identified data, exercised today by the
    research-bridge session export alone. See
    [Master SHADOW access](#master-shadow-access-account-flag-not-a-role).
- read that flag from the account, not from the session: `resolvePrincipal`
  re-reads it on every request, so a revoke is effective immediately and no
  already-issued session carries a stale grant.

A note on session strength, which applies to the whole platform-level
cross-organization route family rather than to any one route: the session
export and its four siblings (`platform/users/status`,
`platform/organizations/status`, `platform/organizations/assign-admin`,
`platform/organizations/transfer-admin`) all authenticate with
`requirePrincipal` rather than `requireMicrosoftAuthenticatedPrincipal`, so no
one of these route guards demands a Microsoft-authenticated session. What keeps
a PIN session out of them sits one layer up:
[credentialPolicy.ts](apps/web/src/server/pilot/credentialPolicy.ts) classifies
`platform_owner`, `organization_admin`, `admin` and `board` as Microsoft roles,
PIN login refuses a role that is not PIN-eligible before a token row is written,
and `resolvePrincipal` revokes on sight any live `ppbf_local` session whose role
does not use a PIN. The guarantee holds; it is held by the session layer, and
these five route guards do not restate it.
