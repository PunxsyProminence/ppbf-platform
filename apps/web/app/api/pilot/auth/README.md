# Authentication, sessions and organization scoping -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

Written from what the code does on `origin/main` at `04dd116b`.

## What this capability is

The floor every other gate in the platform stands on: who is calling, and which
gym the call is about.

Routes under `app/api/pilot/auth/`:

- `login/route.ts` -- account id + PIN. Athletes only.
- `microsoft/start/route.ts`, `microsoft/callback/route.ts` -- Microsoft OAuth.
- `magic-link/request/route.ts`, `magic-link/consume/route.ts` -- one-time
  emailed link for adults who are not administrators.
- `activate/route.ts` -- redeem an activation code.
- `change-pin/route.ts` -- the one route reachable while still on the bootstrap
  PIN.
- `session/route.ts` -- read the current session.
- `logout/route.ts` -- revoke it.

Server modules: `auth.ts` (login, `resolvePrincipal`, revocation, cleanup),
`credentialPolicy.ts` (which credential a role must use), `pinPolicy.ts`,
`sessionPolicy.ts`, `rateLimit.ts`, `security.ts`, `http.ts` (the per-route
gate), `pageGuard.ts` (the per-page gate), `env.ts` (`PILOT_SESSION_COOKIE`, the
default organization).

## The tenancy invariant, stated once

Every gym's data lives in the same tables, separated only by `organization_id`.
So "which gym is this request about" **is** the entire tenancy boundary, and
`src/server/pilot/organizationScope.convention.test.ts` states the rule in its
own header:

> There are exactly two safe answers: derive it from the session
> (`principal.organizationId`), or accept it from the caller and then prove the
> caller is allowed to name it. A route that takes the value and uses it directly
> has handed a stranger the key to every gym on the platform, and it looks
> completely ordinary in review -- one destructured field among ten.

That test is a **build-time gate**, not documentation. See gate 8.

## What it may do

- Mint a 24-hour opaque session token, stored only as a hash.
- Refuse a credential a role is not permitted to use, in one place.
- Refuse every route except the PIN change while an account is on its bootstrap
  PIN.
- Require a Microsoft session for privileged operations regardless of role.
- Revoke a live session the moment its account, its organization, or its
  credential class stops being valid -- without a sweep.
- Throttle PIN guessing durably, across container replicas and deploys.
- Fail a route's build if it takes `organization_id` from the caller without a
  guard.

## What it may NOT do

- It may not mint a PIN session for a non-athlete role (gate 2).
- It may not let a bootstrap-PIN session read anything (gate 4).
- It may not let a PIN session perform a privileged operation (gate 5).
- It may not honour a session whose organization is not `active` (gate 6).
- It may not let an admin revoke, or reach, an account outside their own
  organization (gate 7).
- It may not let an athlete choose the published starting PIN (gate 9).
- It may not disclose why a sign-in was refused (gate 10).

## What must be true before a request is served

Every authenticated route funnels through this. `http.ts:requirePrincipal`:

| # | Must be true | Where | If it is not |
|---|---|---|---|
| 1 | A `PILOT_SESSION_COOKIE` value is present | `auth.ts:resolvePrincipal` | 401 `Unauthorized` |
| 2 | Its SHA hash matches a `pilot.session_tokens` row that is unrevoked and unexpired | same | 401 `Unauthorized` |
| 3 | The account exists and `active_flag = true` | same | 401 `Unauthorized` |
| 4 | An **active** `pilot.organization_memberships` row joins that account to the session's organization | same (an inner join) | 401 `Unauthorized` |
| 5 | The credential class still fits the role -- a `ppbf_local` session for a non-PIN role is revoked on sight | same | 401, and the token row is revoked |
| 6 | The organization's `status` is `active` (unless the account is the platform owner) | same | 401 `Unauthorized` |
| 7 | `must_change_pin` is not `true` | `http.ts:requirePrincipal` | 403 `Forbidden: PIN change required before using this account` |

Only then does the route's own role check run.

## Gates

### Gate 1 -- the session token is opaque, hashed at rest, and absolutely bounded

- **What it checks:** `security.ts:hashToken(cookieValue)` against
  `pilot.session_tokens.token_hash`, plus `revoked_at is null` and
  `expires_at > now()` in the same predicate.
- **Where it runs:** `auth.ts:resolvePrincipal`. The token is created by
  `security.ts:createOpaqueToken` and the expiry by
  `sessionPolicy.ts:computeSessionExpiry`
  (`SESSION_ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1000`).
- **What it refuses with:** `null` from `resolvePrincipal`, which
  `http.ts:requirePrincipalAllowingPinChange` turns into 401 `Unauthorized`.
- **Why it matters:** the token carries no claims, so nothing about a session can
  be forged or self-asserted -- role, organization and athlete id are all read
  from the database on **every** request. The stored value is a hash, so a
  database read does not yield usable sessions. The lifetime is absolute, not
  sliding: there is no refresh, so a stolen cookie dies within 24 hours whatever
  the holder does.
- **The cookie flags are part of the gate:** `httpOnly: true`,
  `sameSite: 'lax'`, `secure` in production, `path: '/'`, and `maxAge` set from
  `SESSION_ABSOLUTE_LIFETIME_SECONDS` so the browser and the row agree.

### Gate 2 -- one source of truth for which credential a role must use

- **What it checks:** `credentialPolicy.ts:requiredCredentialFor({ role, boardSeats })`,
  total over `PilotRole`.
  - `MICROSOFT_ROLES` = `platform_owner`, `organization_admin`, `admin`
    (legacy alias), `board`.
  - `MAGIC_LINK_ROLES` = `coach`, `staff`, `volunteer`, `parent`.
  - `athlete` -> `pin`.
  - Holding **any** board seat upgrades the holder to Microsoft, checked before
    role.
- **Where it runs:** `auth.ts:loginWithAccountIdAndPin` calls
  `usesPin({ role })` before minting a token; `auth.ts:resolvePrincipal` calls it
  again on every request (gate 3); `staffProvisioning.ts` uses it to decide who
  may be invited as a Microsoft account; `app/login/page.tsx` uses it to decide
  which sign-in tab to show.
- **What it refuses with:** `null` from the login function, which the route turns
  into 401 `Invalid credentials`, after logging
  `pilot-auth login rejected { accountId, reason: 'role_not_pin_eligible' }`.
  A `PilotRole` added without being classified is a **compile error** -- the
  function ends in `const unclassified: never = role;` and throws
  `UNCLASSIFIED_ROLE:<role>` if one somehow arrives at runtime, "rather than
  handed the weakest credential by default."
- **Why it exists:** the rule used to live in five places and they had already
  drifted. The module names the loser: "The login page... defaulted to the PIN tab
  and offered an Account ID/PIN form to everyone, while PIN sign-in accepts only
  athletes -- so every coach, parent and staff member met a form that could not
  authenticate them, and a generic 'Invalid account ID or PIN' that blamed their
  credential rather than the door. The rule was correct in the server and wrong
  in the one place a user actually reads." `credentialPolicyDrift.test.ts` fails
  the build if an auth path decides for itself instead of asking here.
- **Why parents get the weaker credential, stated deliberately:** "A parent
  reaches identifying data about a minor, so this credential protects real
  PII -- weaker than Microsoft, and chosen anyway because requiring a Microsoft
  account of every parent at a community gym is an adoption wall rather than a
  security control." Parents are also never permitted an alias: "the real name on
  the account is how an adult is matched to the child they are responsible for."

### Gate 3 -- a privileged local session is revoked on sight, mid-request

- **What it checks:** `row.auth_provider === 'ppbf_local' && !usesPin({ role })`.
- **Where it runs:** `auth.ts:resolvePrincipal`, after the token matches. It
  **writes** -- `update pilot.session_tokens set revoked_at = now()` -- then
  returns `null`.
- **What it refuses with:** 401 `Unauthorized`, and the session is dead for every
  subsequent request "so subsequent checks also fail without re-evaluating this
  branch."
- **Why it exists, with the incident:** "This is what made the 19 abandoned
  platform-owner accounts found in production on 2026-08-07 inert rather than
  exploitable: every one was `ppbf_local` with a non-athlete role, so no session
  they held could survive this branch." Fail closed, retroactively, without a
  migration.

### Gate 4 -- the bootstrap PIN can read nothing

- **What it checks:** `principal.mustChangePin === true`.
- **Where it runs:** `http.ts:requirePrincipal` -- the default gate for every
  authenticated route -- and `pageGuard.ts:requirePageRole` for pages. The two
  routes that must work mid-bootstrap (`auth/session`, `auth/change-pin`) call
  `resolvePrincipal` or `http.ts:requirePrincipalAllowingPinChange` instead.
- **What it refuses with:** 403
  `Forbidden: PIN change required before using this account`; on a page, a
  redirect to `/change-pin`.
- **Why it exists:** `pinPolicy.ts` is explicit that
  `DEFAULT_FIRST_LOGIN_PIN = '123456'` "is a bootstrap credential, not a secret:
  it is public knowledge by design, so an admin can say it out loud instead of
  shepherding a one-time activation code. What stops it being a way in is
  `accounts.must_change_pin`." Enforcing it centrally "means a new route is
  covered by default, and cannot forget to check."
- **The check is `=== true`, not truthy**, because the field is optional on the
  interface "and a security stop should read as 'block when this is set', not
  'block on anything truthy'."
- **The invariant that makes the published PIN safe:** "this PIN is only ever
  written alongside `must_change_pin = true`." `auth.ts:resetAccountPin` sets both
  in one transaction, together with revoking every existing session for the
  account -- "so a caller is never told a reset succeeded while the old PIN or an
  old session is still valid." Without the `must_change_pin` line "that promise
  was simply untrue, and the reset handed out full access on 123456."

### Gate 5 -- privileged operations require a Microsoft session, not just a role

- **What it checks:** `principal.authProvider !== 'microsoft'`.
- **Where it runs:** `http.ts:requireMicrosoftAuthenticatedPrincipal`, used by
  the routes that manage accounts, roles and access --
  `admin/accounts/revoke`, `admin/accounts/pin-reset`, `admin/coach-coverage`,
  and their siblings.
- **What it refuses with:** 403 `Forbidden: Microsoft-authenticated session required`.
- **Why it exists as a second axis:** it is not the same question as the role
  check. `privacyTiers.ts` names all three axes and warns against conflating
  them: "`requireRole` tuples decide who may CALL a route; tiers decide how far a
  FIELD may travel. Session strength (`requirePrincipal` vs the Microsoft gate) is
  a third axis." A six-digit PIN must not be able to grant an adult access to a
  child's record even if the account's role would otherwise allow it.

### Gate 6 -- every refusal a sign-in can produce is decided before a token exists

- **What it checks:** on the Microsoft path, in order: the account exists and is
  active; the organization is `active` (unless platform owner);
  `getPilotRoleDestination(role)` resolves; and, for `platform_owner`, that the
  email equals `auth.ts:getPrimaryOwnerEmail()`.
- **Where it runs:** `auth.ts:loginWithMicrosoftEmail`, all of it **above** the
  `insert into pilot.session_tokens`.
- **What it refuses with:** `null` (mapped to a generic failure by the callback
  route), or 403 `Forbidden: unsupported authenticated role`, or 403
  `Forbidden: platform owner identity mismatch`.
- **Why the ordering is a gate:** the comment says it -- "A refusal that ran after
  the insert still wrote a `pilot.session_tokens` row for a session the user was
  never given." An orphan token row is a live credential nobody accounts for.
- **The owner identity has one definition.** `getPrimaryOwnerEmail()` is used by
  both the sign-in path and the platform-owner bootstrap, "so the address that
  bootstrap writes and the address sign-in accepts cannot drift apart."
- **The organization status check is re-run on every request** in
  `resolvePrincipal`, not only at login, so suspending a gym ends its members'
  live sessions without a sweep.

### Gate 7 -- revocation is scoped to the acting admin's own organization

- **What it checks:** an **active** `pilot.organization_memberships` row for this
  exact `(account_id, organization_id)` pair -- "not the account's single
  denormalized `pilot.accounts.organization_id`" -- and that the target is not a
  platform owner.
- **Where it runs:** `auth.ts:revokeAllSessionsForAccountInOrganization`, called
  from `app/api/pilot/admin/accounts/revoke/route.ts:POST` behind gate 5 and an
  `organization_admin` role check.
- **What it refuses with:** `Account not found or cannot be revoked` -- the **same
  generic error for every denial reason** (no such account, no membership here, an
  inactive membership, or a platform owner), "so none of those conditions can be
  distinguished from the response."
- **What it does on success:** revokes only the sessions that account holds
  **scoped to this organization**. "Sessions the same account holds in any other
  organization are left untouched" -- which is why the membership table, not the
  denormalized column, is the authority: a legitimate secondary membership is
  correctly revocable, while a foreign or inactive one is correctly denied.
- **Honest defect in how that refusal reaches the caller:** the message begins
  with `Account`, which matches **no** prefix branch in `http.ts:jsonError`
  (`Not found` requires the message to *start* with those words). It therefore
  falls into the generic-500 branch, which replaces the text with
  `Internal server error`. The *non-disclosure* property survives -- the response
  is opaque either way -- but the **status is wrong**: an admin who mistypes an
  account id, or names an account in another gym, receives a 500 rather than a
  4xx, and cannot tell a bad request from an outage. This is exactly the failure
  class `errors.ts` was written about. Recorded as a finding in
  `docs/capabilities/GATES.md`; **not fixed here**, and no test pins the current
  behaviour (`app/api/pilot/admin/accounts/revoke/route.test.ts` covers the 403
  and the 200 only).

### Gate 8 -- a build-time gate on organization scoping

- **What it checks:** every route handler under `app/api` (test files excluded).
  If it reads `organization_id` off the request -- from
  `searchParams.get('organization_id')` or `body.organization_id`, including the
  optional-chained form -- it must also contain one of four recognised guards:
  1. a `requireRole([... platform_owner ...])` gate (those routes are cross-gym
     **by design** -- they create organizations and appoint their admins);
  2. a resolver that weighs the requested value against the principal --
     `resolveOrganizationId`, `resolveTargetOrganization`,
     `assertOrganizationAccess`;
  3. compare-and-reject against `principal.organizationId`, as
     `platform/users/create` does -- "the body value is read only to be checked,
     never to be used";
  4. an explicit allowlist entry in the test, with the reason recorded.
- **Where it runs:** `src/server/pilot/organizationScope.convention.test.ts`, in
  the ordinary unit-test gate. It reads the route files off disk.
- **What it refuses with:** a failing test, before merge.
- **Why it exists, with the near miss:** "This is not hypothetical.
  `verifyCompletion` shipped with `organizationId` OPTIONAL and an unscoped
  fallback that updated by `completion_id` alone (#214), and a `completion_id` is
  handed to the client on every write. Both callers happened to pass the
  organization, so nothing failed -- the hole was one forgotten argument away, in
  a repo where several agents write routes in parallel. A human caught that one
  by reading. This catches the next one."
- **The companion default:** almost every route never names an organization at
  all, because `principal.organizationId` comes from the session row and the
  session row's organization is itself join-verified against an active membership
  (gate 4 of the request table above).

### Gate 9 -- an athlete cannot choose the PIN everybody knows

- **What it checks:** `pinPolicy.ts:assertChosenPinAllowed` refuses
  `DEFAULT_FIRST_LOGIN_PIN` on the path where a PIN is **chosen**;
  `:validatePinPolicy` refuses a missing PIN, non-digits, the wrong length, and
  trivially guessable shapes (all-one-digit, and ascending/descending runs
  **with wraparound**, so `890123` is caught).
- **Where it runs:** `app/api/pilot/auth/change-pin/route.ts` and
  `auth.ts:resetAccountPin`. The two functions are deliberately **not** merged:
  "the admin PIN-reset flow legitimately sets `DEFAULT_FIRST_LOGIN_PIN`, and
  `validatePinPolicy` is on that path. The distinction is not the value, it is
  whether `must_change_pin` is being set with it."
- **What it refuses with:** typed `ValidationError` -> **400** with the message
  intact and a machine code: `PIN cannot be the starting PIN everyone is given.
  Choose a different one.` (`PIN_IS_DEFAULT_FIRST_LOGIN`), `PIN is required`
  (`PIN_REQUIRED`), `PIN must contain only digits` (`PIN_NOT_NUMERIC`),
  `PIN must be exactly 6 digits` (`PIN_WRONG_LENGTH`).
- **Why it exists:** "without this, an athlete could change their PIN back to the
  starting PIN, which clears `must_change_pin` and leaves the account reachable by
  anyone who knows the sign-in ID -- on a PIN that is published in this file and
  printed in the admin UI."
- **Why the type and not the message prefix:** this is the worked example in
  `errors.ts`. The guessable-shape check used to begin with "That", so
  `jsonError`'s prefix matcher sent it to the generic 500 branch "and told the
  athlete nothing", while its siblings beginning with "PIN" worked. "Carrying the
  status on the type removes the spelling from the contract."
- **Why the pattern check matters more than the digit count:** "Six digits is a
  million combinations only if they are chosen uniformly, and nobody chooses
  uniformly. The brute-force budget that matters is not 10^6, it is the few dozen
  patterns a person actually picks."

### Gate 10 -- PIN guessing is throttled durably, and every refusal is logged

- **What it checks:** four limiters per attempt -- volatile (in-process) and
  durable (database) buckets, each keyed per account (`pin_account:<id>`) and per
  IP (`pin_ip:<ip>`). `rateLimit.ts`: 5 attempts before throttling, exponential
  backoff from 1s to 60s, a 15-minute window.
- **Where it runs:** `app/api/pilot/auth/login/route.ts:POST`, before
  `loginWithAccountIdAndPin`. Success clears both stores "so a legitimate athlete
  who fat-fingered their PIN a few times is not still throttled".
- **What it refuses with:** 429 `Too many login attempts. Please try again later.`
  or 429 `Too many login attempts from this IP. Please try again later.`;
  and 401 `Invalid credentials` for every wrong-credential case.
- **Why durable and not just volatile:** the route's comment -- "The in-memory
  limiter alone was the only brake on a 6-digit athlete PIN, and it is
  per-process: N container replicas meant N independent attempt budgets against
  the same child's account, and every deploy reset every lockout to zero.
  `pilot.accounts` has no failed-attempt column, so nothing else survived a
  restart."
- **Why the durable check fails OPEN on a database blip:** "A durable lookup that
  cannot reach the database returns not-limited rather than throwing, so a blip
  degrades to the volatile limiter instead of locking every athlete out --
  failing this check closed would be a worse outage than the brute force it
  guards against." A named, bounded fail-open.
- **The forensic half:** every rejection in `loginWithAccountIdAndPin` logs a
  reason code (never the PIN) --
  `unknown_or_inactive_account`, `organization_not_active`, `no_pin_set`,
  `wrong_pin`, `role_not_pin_eligible`. The reason: the durable bucket is deleted
  once it is more than 15 minutes old, so "an attacker spacing guesses out, or
  spreading them across accounts, previously left zero trace anywhere once that
  window passed -- no forensic trail for a suspected brute-force against a minor's
  account."
- **`getClientIp` is not naive.** It walks `x-forwarded-for` from the right using
  `PPBF_TRUSTED_PROXY_COUNT` (default 1) rather than trusting the leftmost value,
  which a client controls.

### Gate 11 -- a refusal sends you where you can actually go

- **What it checks:** on a page (not a route), three outcomes that a single
  `try/catch` used to collapse into one.
- **Where it runs:** `pageGuard.ts:requirePageRole`.
  - No principal -> `/login`.
  - `mustChangePin === true` -> `/change-pin`.
  - Wrong role -> `getPilotRoleDestination(principal.role) ?? '/login'`.
- **Why it is a gate and not a nicety:** the module records what the old shape
  did. "An authenticated coach who opened an athlete URL was shown the login
  form, and because `/login`'s own effect sees a valid session and forwards them
  on, the visible result was a login page flashing past on the way back to where
  they started -- indistinguishable from having been logged out."
- **Two implementation constraints that are themselves safety properties:**
  `redirect()` signals by throwing `NEXT_REDIRECT`, "so nothing here may sit
  inside a try/catch -- swallowing that throw is precisely how the old shape ended
  up with one destination for every outcome." And a genuine failure (the database
  is unreachable) is deliberately **not** converted into a redirect: "'the gym's
  database is down' must not be presented to a member as 'you are signed out' --
  the old shape did exactly that, and it makes an outage unreportable."
- **It changes only WHERE a refusal is sent, never WHO is admitted.** "Role
  matching stays an exact list membership, the same test `requireRole` applies."

### Gate 12 -- unauthenticated surfaces never accept an organization

- **What it checks:** the absence of a parameter. Each unauthenticated route
  hard-codes `env.ts:getPilotDefaultOrganizationId()` instead of reading one.
- **Where it runs:** `app/api/pilot/announcements/public/route.ts` ("never
  accepts caller-supplied `organization_id` (audit finding)"),
  `app/api/pilot/wall/route.ts` ("this cannot be pointed at another gym's
  children"), `app/api/pilot/floor-hours/public/route.ts`.
- **The one exception, and why it is safe:** `app/api/public/store/route.ts`
  **does** take `organization_id`, because "every gym has its own catalogue, its
  own suppliers and its own prices... Without `?organization_id` it returns the
  index of gyms that have a store." It compensates by holding no athlete data at
  all -- "there is no join here to anything about a child, and there must never be
  one" -- selecting a `PUBLIC_FIELDS` projection that omits wholesale cost, and
  exposing exactly one verb: "#111 removed a route that let an anonymous request
  run DDL... An anonymous endpoint on this platform gets exactly one verb."
- **`app/api/pilot/admin/bootstrap/route.ts`** is unauthenticated by necessity and
  gated on a header secret (`security.ts:bootstrapKeyMatches`) plus a **durable**
  per-IP limiter, because the route "still distinguishes a correct key from a
  wrong one via which error message comes back... which is a live oracle for
  guessing `PPBF_PILOT_BOOTSTRAP_KEY` even though it never grants access."
  Refuses with 403 `Forbidden: invalid bootstrap key` or 429.

### Gate 13 -- session rows are cleaned up, on either terminal condition

- **What it checks:** `auth.ts:cleanupExpiredSessions(retentionDays = 7)` deletes
  rows where the session expired **or** was revoked more than `retentionDays`
  ago. Only one condition need hold.
- **Where it runs:** `auth.ts`, driven by a CLI wrapper. `retentionDays` is
  validated inside the function by `sessionPolicy.ts:parseRetentionDays`, "so any
  caller -- script or application code -- gets the same rejection of malformed
  input".
- **Why either condition and not both:** "a session that was revoked immediately
  after being minted (`expires_at` still far in the future) is just as eligible
  for cleanup, on `revoked_at` alone, as a session that simply expired without
  ever being revoked. This keeps a short forensic window on both kinds of
  terminal session before hard-deleting them."

## Deliberately not gated

- **No sliding session, no refresh, and no idle timeout.** 24 hours absolute,
  full stop. A tablet left signed in on the gym floor stays signed in for the
  rest of the day; the control is `logout` and the admin revoke route, not a
  timer.
- **No concurrent-session limit, and no device binding.** One account may hold any
  number of live tokens. `resolvePrincipal` binds a token to nothing about the
  client -- no IP, no user agent -- so a stolen cookie works from anywhere until it
  expires or is revoked.
- **No account lockout, only throttling.** Gate 10 slows guessing; it never
  disables an account. That is deliberate given who the accounts belong to -- a
  lockout on a child's account is a denial-of-service anyone can trigger by
  guessing at them -- but it means an attacker with patience is bounded only by
  the backoff.
- **No PIN rotation and no PIN expiry.** Once an athlete chooses a compliant PIN
  it is good indefinitely.
- **Magic-link and activation-code redemption are gated in their own modules**
  (`magicLink.ts`, `magicLinkStore.ts`, `activation.ts`,
  `activationPolicy.ts`) -- single use, TTL-bounded, hashed at rest -- and are not
  documented gate-by-gate here. They are listed in
  `docs/capabilities/GATES.md`.
- **`getPilotDefaultOrganizationId()` is a fallback in `resolvePrincipal` and both
  login paths** (`row.organization_id || getPilotDefaultOrganizationId()`). An
  account with a null `organization_id` is therefore treated as a member of the
  default gym. On a single-gym deployment that is correct; on a multi-gym one it
  is a quiet default rather than a refusal, and nothing warns about it. The
  membership join in gate 4 constrains the damage -- the session's organization
  must still have an active membership row -- but the fallback itself is not
  gated.
- **The role-destination map is the de facto role allow-list at sign-in.**
  `loginWithMicrosoftEmail` refuses a role only because
  `getPilotRoleDestination(role)` returns nothing for it. That is an indirection:
  a routing table doubles as an authentication policy, and adding a destination
  for a new role silently makes it signable-in.
- **Nothing rate-limits the Microsoft or magic-link paths at this layer.** Gate 10
  is on the PIN route only.
- **These routes return JSON, not stamps.** Design-system Law 7 applies to
  `app/login` and the pages, not here.

## Verified by

- `src/server/pilot/organizationScope.convention.test.ts` -- gate 8, the
  build-time tenancy gate, including its recorded allowlist.
- `src/server/pilot/credentialPolicy.test.ts` and `credentialPolicyDrift.test.ts`
  -- gate 2: the full role-to-credential mapping, the board-seat upgrade, the
  exhaustiveness of `requiredCredentialFor`, and that no auth path re-decides the
  rule locally.
- `src/server/pilot/auth.sessionCreation.test.ts`,
  `auth.sessionExpiry.test.ts`, `sessionPolicy.test.ts` -- gate 1: the hashed
  opaque token, the absolute expiry, and that an expired or revoked row does not
  resolve.
- `src/server/pilot/auth.accounts.test.ts`,
  `auth.microsoftLogin.test.ts`, `federatedAuth.test.ts`,
  `microsoftOAuthFlow.test.ts` -- gates 3 and 6: the `ppbf_local`
  non-athlete revoke-on-sight, the inactive-organization refusal, the
  role-destination refusal, and the platform-owner identity match.
- `src/server/pilot/auth.revocation.test.ts` and
  `app/api/pilot/admin/accounts/revoke/route.test.ts` -- gate 7: the
  membership-based authorization, the identical generic error for all four denial
  reasons, and that only this organization's sessions are revoked. (Neither pins
  the HTTP status of that refusal -- see gate 7's honest note.)
- `src/server/pilot/auth.resetPin.test.ts`, `firstLoginPin.test.ts`,
  `pinPolicy.test.ts`, `app/api/pilot/auth/change-pin/route.test.ts` -- gates 4
  and 9: `must_change_pin` set on reset, sessions revoked in the same
  transaction, the starting-PIN refusal, the trivially-guessable shapes including
  wraparound, and the typed 400s.
- `src/server/pilot/http.test.ts` -- `requirePrincipal`'s `=== true` PIN stop,
  `requireMicrosoftAuthenticatedPrincipal` (gate 5), `hiddenNotFound`, and every
  `jsonError` branch including the generic-500 scrub.
- `app/api/pilot/auth/login/route.test.ts` -- gate 10: both limiter pairs, the
  429s, the clear-on-success, and the 401 for every wrong-credential case.
- `src/server/pilot/rateLimit.clientIp.test.ts` -- `getClientIp`'s
  right-to-left walk under `PPBF_TRUSTED_PROXY_COUNT`.
- `src/server/pilot/auth.cleanup.test.ts` -- gate 13's either-condition delete
  and the `retentionDays` validation.
- `src/server/pilot/auth.masterShadowAccess.test.ts`,
  `auth.adminTransfer.test.ts`, `boardRoleBoundaries.test.ts` -- the adjacent
  privilege boundaries the principal carries.
- `src/server/pilot/durableRateLimit.pg.test.ts`,
  `gateSession.pg.test.ts`, `sessionExpiry.migration.pg.test.ts`,
  `activationPinExposure.pg.test.ts` -- the same properties against a real
  database. **Not run by this lane** (`*.pg.test.ts` is excluded here); named so
  the next reader knows they exist.
