# Coach coverage -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

Written from what the code does on `origin/main` at `04dd116b`. Where a gate is
not there, this file says so rather than describing the intention.

## What this capability is

Temporary, per-athlete, expiring access for a coach who is **not** the athlete's
coach of record -- a substitute taking a session, a coach picking up cover while
somebody is away.

Three verbs on one route, `app/api/pilot/admin/coach-coverage/route.ts`:

- `POST` -- grant coverage of one athlete to one coach, for a bounded number of
  hours.
- `GET` -- every grant currently in effect in the caller's own gym, soonest to
  expire first.
- `DELETE` -- end a grant now.

The state lives in `pilot.coach_coverage`. The reason this capability exists in
this shape rather than as a roster-wide "cover for Coach X" switch is written
into `src/server/pilot/access.ts` itself: coverage is *bounded exposure to one
athlete's record*, and the bound is the whole point.

Every helper lives in `src/server/pilot/access.ts`. That file is owned by open
PR #431 and is called, never edited, from here.

## What it may do

- Admit a covering coach through the one function every athlete-scoped read and
  write in the platform already funnels through
  (`access.ts:assertCoachAssignedToAthlete`), so a covered athlete behaves for
  that coach exactly as an assigned one does -- including the pain-report alert
  path and the escalations feed layered on top of it
  (`app/api/pilot/escalations/route.ts:coachAthleteIds` unions assigned and
  actively-covered athletes for the same reason).
- Expire on its own clock, with no cleanup job. Expiry is a SQL predicate
  (`starts_at <= now() and expires_at > now()`) evaluated on every read, so a
  lapsed grant stops working the moment it lapses.
- Be revoked early by setting `expires_at = now()`, which is the same mechanism
  as expiry and therefore needs no second code path.
- Be listed. Until `GET` existed, `POST`/`DELETE` shipped with no way to see
  what they had done.

## What it may NOT do

- It may not grant coverage of an athlete in another organization (gate 2).
- It may not name a grantee who is not an active coach in this organization
  (gate 3) -- not a parent, not an athlete, not a deactivated coach, not a
  typo.
- It may not run unbounded. `ttl_hours` is capped at 336 (14 days), default 24
  (gate 4).
- It may not stack. At most one live grant per (athlete, coach) (gate 5).
- It may not be converted into permanent access. A covering coach cannot write
  `pilot.athletes.coach_id` (gate 7) -- the escalation that would otherwise
  outlive the grant.
- It may not be granted or revoked from a PIN session (gate 1b), or by a coach,
  parent, athlete, board member or the platform owner (gate 1c).
- It does not delete anything. Revoking expires the row so the audit trail of
  who held access survives.

## What must be true before a coach gets access to a child they do not coach

The inverse of the gate list, because "what does this refuse" and "what do I
need in place" are different questions.

`POST /api/pilot/admin/coach-coverage` writes a grant only when **all** of these
hold. They are evaluated in this order and the first failure refuses the whole
write:

| # | Must be true | If it is not | Who can make it true |
|---|---|---|---|
| 1 | The caller holds a live, non-bootstrap session | 401 `Unauthorized` / 403 `Forbidden: PIN change required before using this account` | Sign in; change the bootstrap PIN |
| 2 | That session is Microsoft-authenticated | 403 `Forbidden: Microsoft-authenticated session required` | Sign in through Microsoft, not a PIN |
| 3 | The caller is an organization admin | 403 `Forbidden: role not allowed` | An admin performs the action |
| 4 | `athlete_id` and `covering_coach_id` are both present | 400 `Missing athlete_id or covering_coach_id` | Fix the request |
| 5 | The athlete belongs to the caller's own organization | 403 `Forbidden: athlete does not belong to organization` | Nothing -- this is the tenancy boundary |
| 6 | `covering_coach_id` is an **active coach account in this organization** | 400 `Missing covering_coach_id: must be an active coach account in this organization` | Provision the coach, or correct the id |
| 7 | `ttl_hours`, if supplied, is a positive integer <= 336 | 400 `Missing ttl_hours: must be a positive integer of at most 336` | Ask for less time |
| 8 | No live grant already exists for this (athlete, coach) pair | 409 `Coverage already exists: <coverage_id> for this coach and athlete is still active` | Revoke the named grant first |

No feature flag, no environment variable. This capability is live on `main`
today. The one operational dependency is the `pilot.coach_coverage` migration
(see gate 8's note on the pre-migration window).

## Gates

### Gate 1 -- only an organization admin, on a Microsoft session, may grant or revoke

- **What it checks:** three things in sequence, on all three verbs.
  - (a) a valid, unrevoked, unexpired session token whose account is active and
    whose organization is `active`, and which is **not** still on the
    admin-issued bootstrap PIN;
  - (b) `principal.authProvider === 'microsoft'`;
  - (c) `isOrganizationAdminRole(principal.role)` -- `organization_admin` or the
    legacy `admin` alias, and nothing else.
- **Where it runs:** `src/server/pilot/http.ts:requireMicrosoftAuthenticatedPrincipal`
  (which calls `requirePrincipal` -> `auth.ts:resolvePrincipal`), then the
  explicit `isOrganizationAdminRole` check at the top of each of `GET`, `POST`
  and `DELETE` in `route.ts`.
- **What it refuses with:** 401 `Unauthorized`; 403
  `Forbidden: PIN change required before using this account`; 403
  `Forbidden: Microsoft-authenticated session required`; 403
  `Forbidden: role not allowed`. All four via `jsonError`'s prefix branches.
- **Why it exists:** this route hands one adult access to a specific child's
  record. `credentialPolicy.ts` states the platform's rule -- "administrators
  use Microsoft, adults use their email, kids use a stage name and a PIN" -- and
  the Microsoft gate is what stops a six-digit PIN session from being able to
  issue that access. The role check is separate from `requireRole` on purpose:
  `isOrganizationAdminRole` is the helper that also admits the legacy `admin`
  rows, so an older organization's admin is not locked out of revocation.

### Gate 2 -- the athlete must be in the granting admin's own organization

- **What it checks:** a `pilot.athletes` row with this `athlete_id` **and** this
  `organization_id`.
- **Where it runs:** `src/server/pilot/access.ts:assertAthleteBelongsToOrganization`,
  called first inside `access.ts:grantCoachCoverage` -- before the TTL is
  resolved and before the grantee is checked.
- **What it refuses with:** 403
  `Forbidden: athlete does not belong to organization`.
- **Why it exists:** every gym's records live in the same tables separated only
  by `organization_id`. `athlete_id` arrives from the request body. Without this
  check an admin of gym A could grant one of gym A's coaches coverage of a child
  in gym B, and every downstream read would then honour it, because
  `assertCoachAssignedToAthlete`'s coverage branch is satisfied by the row this
  route wrote.

### Gate 3 -- the grantee must be an active coach in this organization

- **What it checks:** a `pilot.accounts` row with `account_id = covering_coach_id`,
  `organization_id` = the caller's, `role = 'coach'` and `active_flag = true`.
- **Where it runs:** `src/server/pilot/access.ts:assertActiveCoachAccount`,
  called from `grantCoachCoverage` with `field = 'covering_coach_id'` so the
  refusal names the caller's own input.
- **What it refuses with:** 400
  `Missing covering_coach_id: must be an active coach account in this organization`.
- **Why it exists:** the module's own comment says it plainly -- a typo'd id is
  not a bad reference, it is *access granted to whatever account the typo
  names*. `pilot.coach_coverage` exists in order to admit its holder through
  `assertCoachAssignedToAthlete`, and that function does not re-check the
  grantee's role. So an id naming a parent, an athlete or a deactivated coach
  would be handed coach-level reach into a child's record by a single mistyped
  character. This is the only gate on this route that validates *who* the
  access is for, and it is the reason its absence on the guardian-link path
  (see `docs/capabilities/GATES.md`, "Known gaps") is a finding.
- **Why 400 and not 403:** the caller is entitled to grant coverage; what is
  wrong is the value they sent. `errors.ts` draws that line, and the `Missing `
  prefix is what `jsonError` maps to 400.

### Gate 4 -- coverage is time-bounded, and the bound is enforced

- **What it checks:** `ttl_hours`, when the caller supplies one, must be a safe
  positive integer no greater than `MAX_COVERAGE_TTL_HOURS` (14 * 24 = 336).
  Omitted means `DEFAULT_COVERAGE_TTL_HOURS` = 24.
- **Where it runs:** `src/server/pilot/access.ts:resolveCoverageTtlHours` (module-private,
  called by `grantCoachCoverage`); the value becomes
  `expires_at = now() + ($5 || ' hours')::interval` on the insert.
- **What it refuses with:** 400
  `Missing ttl_hours: must be a positive integer of at most 336`.
- **Why it exists:** "a substitute covering one session needs hours, not
  months", and -- the sentence that matters -- "a bound nobody enforces is not
  a bound". The roster-wide alternative to this capability was rejected
  precisely because coverage is *bounded* exposure; an unbounded `ttl_hours`
  would have quietly reintroduced the rejected design through the request body.
  Mirrors `activation.ts:resolveTtlHours`.

### Gate 5 -- at most one live grant per (athlete, coach)

- **What it checks:** whether any row already exists for this
  `(organization_id, athlete_id, covering_coach_id)` with `expires_at > now()`.
- **Where it runs:** `src/server/pilot/access.ts:grantCoachCoverage`, after the
  grantee check and before the insert.
- **What it refuses with:** 409
  `Coverage already exists: <coverage_id> for this coach and athlete is still active`
  -- routed to 409 by `jsonError`'s explicit `Coverage already exists` branch
  (it sits in the same list as `Hold already exists`), and it names the live
  grant so the admin can revoke it.
- **Why it exists:** stacked overlapping grants make revocation lie. An admin
  revokes "the" grant, a hidden second one keeps the door open, and the
  organization believes access has ended. Refusing the overlap makes revocation
  mean what it says.

### Gate 6 -- expiry and revocation are the same predicate, evaluated at read time

- **What it checks:** on every access decision,
  `starts_at <= now() and expires_at > now()`.
- **Where it runs:** `src/server/pilot/access.ts:assertCoachAssignedToAthlete`
  (single-athlete assertions) and `access.ts:accessibleAthleteIds` (the batched
  form used to filter pages of rows). `access.ts:revokeCoachCoverage` sets
  `expires_at = now()` under a `expires_at > now()` guard.
- **What it refuses with:** `Forbidden: coach not assigned to athlete` (403) --
  **deliberately byte-identical** to the message a coach with no relationship at
  all receives. `accessibleAthleteIds` returns the id absent from its set rather
  than throwing.
- **Why it exists:** there is no cron in this codebase. A grant that needed a
  sweep to stop working would keep working for as long as the sweep was broken.
  Making expiry a predicate means the failure direction is "access ends", and
  revocation reuses it so there is one mechanism, not two.
- **Why one message for three different states:** whether a coach has no
  relationship to this athlete, an expired grant, or a revoked one is not
  something the error channel should disclose. It also keeps the pre-coverage
  assertion text unchanged for every existing caller and test.
- **What revocation does NOT do:** it expires the row, it does not delete it.
  The row survives as the record of who held access and when it was cut short.
  `access.ts:listActiveCoachCoverage` deliberately excludes it, because that
  read answers "who has access right now", not "who ever did" -- the history
  lives in `pilot.audit_events` under `entity_type = 'coach_coverage'`.

### Gate 7 -- a covering coach cannot make the access permanent

- **What it checks:** on an athlete update, that a `coach` actor has not changed
  `coach_id`.
- **Where it runs:** `src/server/pilot/access.ts:assertAthleteUpdateAllowed`,
  called from the athlete update path.
- **What it refuses with:** 403 `Forbidden: coach cannot change coach assignment`.
- **Why it belongs in THIS capability's gate list:** it is the gate that makes
  gate 4 and gate 6 mean anything. `assertAthleteUpdateAllowed`'s own comment
  spells out the attack: a coach reaching an athlete through a *temporary* grant
  sets `coach_id` to their own account, at which point the grant's expiry stops
  mattering -- they match the permanent assignment check from then on -- and the
  athlete's actual coach, who no longer matches `coach_id`, loses access. "A
  bound that the bounded party can write their way out of is not a bound." The
  knock-on is worse than the record: `profileDb.ts` mints
  `coach_of_subject` straight from `pilot.athletes.coach_id`, and that
  relationship is one of the three in `profileVisibility.ts:MINOR_CIRCLE` -- the
  circle a minor's photograph never leaves. Writing that column admits the
  writer to a child's portrait.

### Gate 8 -- one narrow, deliberate fail-open: the pre-migration window

- **What it checks:** nothing. This documents where the capability
  deliberately behaves as "no coverage" instead of failing.
- **Where it runs:** `access.ts:assertCoachAssignedToAthlete` and
  `access.ts:accessibleAthleteIds` each catch Postgres `42P01` (undefined
  relation) around the `pilot.coach_coverage` query and treat it as "no
  coverage found". Any other database error still propagates.
- **Why it exists:** migrations are operator-applied, so this code legitimately
  runs against a database the `coach_coverage` migration has not reached yet. In
  that window a missing relation must mean exactly what the pre-coverage code
  meant -- *no* coverage -- rather than turning every non-assigned-coach 403
  into an opaque 500 that also takes down the pain-report alert path layered on
  this gate.
- **Honest reading of the direction:** this is fail-**closed** for access (no
  grant is honoured) and fail-open only for availability. It cannot widen
  anyone's reach. `grantCoachCoverage` has no such catch, so on a
  pre-migration database granting fails outright, which is correct.

## Deliberately not gated

- **Who may be covered, beyond organization membership.** Any athlete in the
  organization may be the subject of a grant. There is no "this coach may only
  ever cover athletes in their own program/floor group" rule, and none is
  implied. The bound on this capability is *time* and *one named child*, not a
  category of children.
- **Why coverage was granted.** `pilot.coach_coverage` has no reason column and
  the route requires no note. Compare `training-holds`, which refuses a
  placement with no `athlete_explanation`, and `compliance/violations`, which
  refuses a resolution with no note. Coverage records who granted it, to whom,
  for which child and until when -- in the row and in the audit event -- but not
  why. An admin auditing a grant after the fact can see everything except the
  reason.
- **A cap on how many grants one coach may hold at once.** Gate 5 stops
  *stacking on one child*; nothing stops one coach holding simultaneous grants
  on twenty different children. The roster-wide grant that the design rejected
  is therefore still reachable by repetition, one `POST` at a time, by an
  organization admin. That is a real limit of this design, not a bug in it: the
  actor is already the role that can read every athlete record in the gym.
- **Re-granting after revocation.** Nothing prevents an admin revoking and
  immediately re-granting, which resets the clock. Gate 5 only blocks the
  overlap.
- **`GET` discloses coach and granter email addresses.**
  `listActiveCoachCoverage` left-joins `pilot.accounts.login_email` for both the
  covering coach and the granter, and the route returns them. That is
  staff-to-staff disclosure inside one organization to an admin who could read
  those accounts anyway; it is noted here because it is a field-level
  disclosure that no tier check gates.
- **The refusal is not rendered as a stamp.** Design-system Law 7 says "refusal
  is a stamp, not an error toast". This is a JSON route; whichever admin surface
  calls it decides how the refusal renders, and nothing in this change touched
  that.

## Verified by

- `src/server/pilot/access.test.ts` -- `assertCoachAssignedToAthlete` including
  its `coverage grants (T-002)` block (assigned coach still passes; an active
  grant admits; an expired grant does not; `42P01` reads as no coverage while
  any other error propagates), `grantCoachCoverage` (organization check first,
  grantee must be an active coach, TTL bounds, the overlap 409),
  `revokeCoachCoverage` (idempotence, and that it cannot extend a lapsed
  grant), `listActiveCoachCoverage`, `accessibleAthleteIds` (`coach role`
  block: the batched form agrees with the per-id assertion, coverage included),
  and `assertAthleteUpdateAllowed` (`coach role` block: the `coach_id` refusal
  of gate 7).
- `app/api/pilot/admin/coach-coverage/route.test.ts` -- the wiring for all
  three verbs: the Microsoft-session and org-admin refusals, `Missing
  athlete_id or covering_coach_id`, that the audit event is written with the
  athlete, the covering coach and `expires_at`, that `DELETE` audits only when
  a row actually changed, and that `revoked: false` is a 200 rather than a 404
  so a coverage id cannot be probed across gyms.
- `src/server/pilot/coachCoverage.pg.test.ts` -- the schema and index behaviour
  against a real database. **Not run by this lane** (`*.pg.test.ts` is excluded
  from the unit-test gate here); named so the next reader knows it exists.
