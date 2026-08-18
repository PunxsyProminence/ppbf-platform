# Pass 1 — Authentication & session

Scope: every way an identity is established or elevated. Login, magic link, PIN,
Microsoft OIDC, activation, the bootstrap key, session issuance/expiry/
revocation, `requirePrincipal`, and `AUTH_CONTRACT.md` conformance.

Pinned to `origin/main` at `04dd116b`, read from branch
`docs/full-spectrum-audit-2026-08-18` at `5cc4d7f9`. Read-only pass: no
application code was changed, nothing was executed, no database was reached.

De-duplicated against `AGENT_KERNEL.md`, `AUTH_CONTRACT.md`,
`docs/capabilities/NETWORK_STATUS.md` (read from `origin/docs/agent-handoff-briefs`,
because it is **not** on `main` or on this branch),
`docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md` (read from
`origin/claude/app-audit-ux-ui-report-78o4cm`), this directory's
`PASS-02-authorization.md`, and `git log --oneline origin/main -40`.

---

## Method

**Read start to finish (16 modules, ~3,700 lines):**
`src/server/pilot/auth.ts` (1,283), `http.ts` (203), `security.ts` (76),
`sessionPolicy.ts` (37), `credentialPolicy.ts` (147), `authProviders.ts` (37),
`pinPolicy.ts` (119), `magicLink.ts` (248), `magicLinkStore.ts` (149),
`microsoftOAuthFlow.ts` (153), `federatedAuth.ts` (353), `rateLimit.ts` (314),
`activation.ts` (338), `researchBridgeAuth.ts` (129), `env.ts` (58),
`src/shared/pilotRoleRouting.ts` (51).

**Read start to finish (11 routes, ~1,300 lines):** all 9 under
`app/api/pilot/auth/**` — `login`, `logout`, `session`, `activate`,
`change-pin`, `magic-link/request`, `magic-link/consume`, `microsoft/start`,
`microsoft/callback` — plus both bootstrap routes,
`admin/bootstrap` and `admin/bootstrap/platform-owner-microsoft`.

**Read at handler level (12 routes):** `platform/athlete-shell`,
`platform/organizations/memberships`, `platform/users/create`, `admin/staff`,
`admin/athlete-accounts`, `admin/activation-codes`, `admin/data-deletion`,
`admin/coach-coverage`, `admin/accounts/repair-auth-provider`, `board/seats`,
`feedback/list`, `shadow/jobs/process`.

**Partially read:** `staffProvisioning.ts` lines 190–470 (the provisioning
transaction and its guards); `app/login/page.tsx`, `app/admin/people/page.tsx`
and `app/admin/pin/page.tsx` by targeted grep plus the surrounding blocks;
`credentialPolicyDrift.test.ts` first 80 lines; `infra/azure/pilot_slice_postgres.sql`
lines 1–80 and `pilot_slice_postgres_magic_link_migration.sql` in full;
`.github/workflows/deploy-production.yml` and `deploy-staging.yml` by grep plus
the smoke-check and gate blocks; `apps/web/scripts/lib/gate-session.mjs`
lines 1–160.

**Did not open:** the other 217 of 228 API routes (that is pass 2's territory
and its reach is stated in its own file), 37 of the 38 auth-domain test files,
the SHADOW subsystem, and every page component other than the four named above.

**Did not run:** anything. Every claim below is source reading. Two claims are
explicitly marked as unverifiable without production or Actions access and are
in *Could not establish* rather than in *Findings*.

**Counts used:** 228 route files, 429 modules in `src/server/pilot`, 9 auth
routes, 3 bootstrap-key call sites, 6 places that mint or clear the session
cookie, 10 functions that mutate `pilot.accounts` role/organization/credential.

---

## How identity is established

There are **four** ways to obtain a `ppbf_pilot_session` cookie, and one
non-cookie identity. `AUTH_CONTRACT.md` documents only the first.

### The credential policy decides which door you get

`credentialPolicy.ts` is the single source of truth, and a drift guard
(`credentialPolicyDrift.test.ts`) fails the build if an auth path re-decides it:

> `apps/web/src/server/pilot/credentialPolicy.ts:30-31` —
> ```
>  *   administrators use Microsoft, adults use their email, kids use a stage
>  *   name and a PIN
> ```

`MICROSOFT_ROLES` = `platform_owner`, `organization_admin`, `admin`, `board`.
`MAGIC_LINK_ROLES` = `coach`, `staff`, `volunteer`, `parent`. `athlete` → `pin`.
The function is total over `PilotRole` and throws on an unclassified role rather
than falling through to the weakest credential.

### 1. Account ID + PIN → `POST /api/pilot/auth/login`

`loginWithAccountIdAndPin` (`auth.ts:99`) selects the account **only** where
`a.auth_provider = 'ppbf_local'`, then rejects in five named steps, each logging
a reason code and none logging the PIN: inactive/unknown account, organization
not `active`, no PIN set, wrong PIN, and finally

> `apps/web/src/server/pilot/auth.ts:155` — `  if (!usesPin({ role: data.role })) {`

so a privileged local session is never minted. Only after all five does it
create a 32-byte opaque token, store `sha256(token)` in `pilot.session_tokens`
with a 24-hour `expires_at`, and return it. The route sets the cookie
`httpOnly`, `sameSite: 'lax'`, `secure` in production, `maxAge` derived from
`SESSION_ABSOLUTE_LIFETIME_SECONDS`.

### 2. Emailed one-time link → `POST /api/pilot/auth/magic-link/{request,consume}`

`issueMagicLink` (`magicLink.ts:113`) answers identically for every refusal
reason, invalidates the account's outstanding links before issuing a new one,
stores only `hashToken(token)` with a 15-minute expiry and the address **as
sent**. Redemption runs the validation and the session mint in one transaction
under `for update of t`, so two clicks produce exactly one session.

### 3. Microsoft OIDC → `GET /api/pilot/auth/microsoft/{start,callback}`

Authorization-code + PKCE S256, `prompt=login`, state/verifier/nonce/issued-at
each in their own `httpOnly` cookie with a 10-minute TTL and a used-state replay
cookie. The callback verifies the `id_token` against JWKS with an RS256-only
allowlist, then checks `iss`, `aud`, `tid`, `exp`, `nbf` and `nonce`.
`loginWithMicrosoftEmail` matches on `lower(a.login_email)` **and**
`a.auth_provider = 'microsoft'`, and refuses a `platform_owner` whose email is
not `getPrimaryOwnerEmail()`.

### 4. Activation code → `POST /api/pilot/auth/activate`

Unauthenticated by design. A 12-character Crockford-style code, stored hashed,
single-use under `for update`, superseded by re-issue. On success it signs the
athlete in **through `loginWithAccountIdAndPin`**, so no session is minted by
any logic other than the ordinary one.

### 5. Bearer JWT → the research-bridge export

`requireResearchBridgeAccess` (`researchBridgeAuth.ts:77`) is a separate,
staging-only identity: it 404s unless `RESEARCH_BRIDGE_EXPORT_ENVIRONMENT ===
'staging'` and the request host matches an allowlisted host, then requires a
tenant-issued JWT carrying `Research.Export` and an allowlisted client id. The
organization it returns comes from an environment variable, never the token.
`RESEARCH_BRIDGE_EXPORT_ENABLED` is set only in `deploy-staging.yml`.

### Resolution on every request

`resolvePrincipal` (`auth.ts:253`) hashes the cookie, then runs one query that
joins `session_tokens → accounts → organizations` **and inner-joins an active
membership**:

> `apps/web/src/server/pilot/auth.ts:287-293` —
> ```
>      join pilot.organization_memberships om
>        on om.account_id = a.account_id
>       and om.organization_id = coalesce(st.organization_id, a.organization_id)
>       and om.active_flag = true
>      where st.token_hash = $1
>        and st.revoked_at is null
>        and st.expires_at > now()
> ```

It then fails closed on a legacy privileged local session, **revoking the row**
rather than only refusing it (`auth.ts:309-315`), and refuses a non-`active`
organization for anyone but the platform owner.

`requirePrincipal` (`http.ts:24`) adds the bootstrap-PIN stop. `has_master_shadow_access`
and `must_change_pin` are read live on every request, never cached on the token.

**Nothing in the principal comes from request-controlled input.** `role` comes
from `pilot.accounts.role`; `organizationId` from `coalesce(st.organization_id,
a.organization_id)`, both server-written; `athleteId` and `authProvider` from the
account row. The cookie value is the only client input and it is used solely as a
hash lookup key.

---

## AUTH_CONTRACT.md conformance

Read clause by clause. **The contract is the document that is wrong** in most of
the disagreements below: it was written against an older login model and has not
tracked the code.

| Clause | Code | Verdict |
|---|---|---|
| "Current login route: `POST /api/pilot/auth/login`" | exists | ✅ |
| "Current session route: `POST /api/pilot/auth/session`" | exists, POST only | ✅ |
| "Current logout route: `POST /api/pilot/auth/logout`" | exists | ✅ |
| "opaque session token stored in an HTTP-only cookie and hashed in `pilot.session_tokens`" | `createOpaqueToken()` = 32 random bytes; `hashToken` = sha256; cookie `httpOnly` | ✅ |
| "Current auth record source: `pilot.accounts`" | yes | ✅ |
| `PilotRole` set of nine | `contracts.ts:1-10` matches exactly | ✅ |
| "board seats … are not authorization roles and the server never issues one" | `/auth/session` returns `board_seat`/`board_seats` separately from `role`, and only for `role === 'board'` | ✅ |
| All six "Relevant source files" links | all six resolve | ✅ |
| **§ "### GET /auth/session (implemented)"** | the route exports `POST` only; a GET is a 405 | ❌ **contract wrong** — it contradicts its own "Observed Current Behavior" section three pages earlier, which says POST |
| Login success body `{ok, account_id, role, athlete_id}` | also returns `organization_id` and `has_master_shadow_access` (`login/route.ts:124-131`) | ⚠️ contract incomplete (additive, not a defect) |
| `400` for "missing or malformed request body" | missing fields → 400; **malformed JSON → 500** (see LOW-2) | ❌ **code wrong** |
| `401` invalid credentials, body `{"error":"Invalid credentials"}` | exact match at `login/route.ts:101` | ✅ |
| Logout: `401` no session, revoke server-side, clear cookie | `requirePrincipal` first, then `logoutWithToken`, then `maxAge: 0` | ✅ |
| Session: `200` always, `{authenticated:false}` when not | `noStoreJson({ authenticated: false })` | ✅ |
| `GET /auth/roles` "proposed, not built" | still not built; no `roles` route exists under `app/api` | ✅ contract accurate |
| "Token is issued at login … Logout revokes the stored token row" | ✅ | ✅ |
| "Mark the cookie `httpOnly`, `sameSite=lax`, `secure` in production" | all four cookie-setting sites do | ✅ |
| "set a long-lived max age only if that is intended" | 24h absolute, single constant, DB and cookie derived from it | ✅ |
| "Browser storage must not be the source of truth for auth state" | `roleSession.ts` only *removes* legacy `localStorage` keys (`:38-39`); every page re-fetches `/auth/session` | ✅ |
| "Security decisions must be enforced by the backend" | ✅ | ✅ |
| `jsonError` maps 400/401/403/404/500 | it does, by type first then message prefix | ✅ |

**The contract's largest gap is what it omits.** It describes account-ID + PIN as
*the* login and never mentions magic links or Microsoft OIDC — the only two ways
any adult on this platform can sign in. It also does not mention
`PPBF_PILOT_BOOTSTRAP_KEY`, `/auth/activate`, `/auth/change-pin`, session
expiry, or session revocation on role change, all of which exist and all of which
are load-bearing. A reader treating `AUTH_CONTRACT.md` as the specification of
this system's authentication would be wrong about most of it. It should either be
rewritten against current code or marked historical.

---

## Findings

### [HIGH] `platform/athlete-shell` creates a live, sign-in-able athlete account on the published starting PIN — in any organization — while its own comment and its response both say it does not

`POST /api/pilot/platform/athlete-shell` is `platform_owner`-only and takes
`organization_id` from the request body. Its doc comment states:

> `apps/web/app/api/pilot/platform/athlete-shell/route.ts:14-19` —
> ```
>  * This creates a login-account SHELL only: it links account_id to an
>  * already-existing pilot.athletes roster row with no PIN and active_flag
>  * false -- it grants no sign-in capability. Deliberately, this route does not
>  * and must never issue an activation code: that is the one step platform_owner
>  * is permanently excluded from (see activation-codes/route.ts), because a
>  * minted code lets whoever holds it set the athlete's PIN and sign in as them.
> ```

It calls `createAthleteAccount`, which does the opposite of both named
properties:

> `apps/web/src/server/pilot/auth.ts:593` — `    const bootstrapPinHash = await hashPin(DEFAULT_FIRST_LOGIN_PIN);`

> `apps/web/src/server/pilot/auth.ts:595-600` —
> ```
>     await client.query(
>       `insert into pilot.accounts
>          (account_id, role, organization_id, athlete_id, pin_hash, must_change_pin, active_flag, is_platform_owner)
>        values ($1, 'athlete', $2, $3, $4, true, true, false)`,
>       [accountId, organizationId, athleteId, bootstrapPinHash],
>     );
> ```

`pin_hash` is the hash of the published starting constant, and `active_flag` is
`true`, not false. The next statement writes an **active** membership row
(`auth.ts:601-609`), which is exactly what `resolvePrincipal`'s inner join
requires. The response then tells the caller the opposite as well:

> `apps/web/app/api/pilot/platform/athlete-shell/route.ts:59-60` —
> ```
>       account_state: 'pending_pin_activation',
>       next_step: "This gym's own admin must issue an activation code in Admin > People before this athlete can sign in.",
> ```

The caller chose `account_id`, so they know the sign-in id. The PIN is a
constant declared in `pinPolicy.ts` and printed in the admin UI. So the caller
can immediately `POST /api/pilot/auth/login` — every one of
`loginWithAccountIdAndPin`'s five gates passes (active, org active, PIN set, PIN
correct, `usesPin({role:'athlete'})` true; `auth_provider` is unnamed in the
insert and takes the column default `'ppbf_local'`) — and then
`POST /api/pilot/auth/change-pin`, which needs only the current PIN and clears
`must_change_pin`. They are now a fully-functioning athlete principal bound to
that child's `athlete_id`, in a gym they do not administer.

That is precisely the boundary the sibling route refuses to cross, in the same
words:

> `apps/web/app/api/pilot/admin/activation-codes/route.ts:18-21` —
> ```
>  * named athlete: whoever holds it chooses that athlete's PIN and can then sign
>  * in as them. Granting the platform owner the ability to mint one would be a
>  * route around the boundary that assertActorCanAccessAthlete enforces --
>  * platform owners do not reach organization-private athlete records.
> ```

**Refutation attempted, four ways.**
1. *Is there a different `createAthleteAccount`?* No — one export, `auth.ts:538`,
   imported directly at `athlete-shell/route.ts:4`. The org-admin route
   `admin/athlete-accounts` calls the same function; there is no platform-scoped
   variant.
2. *Does something downstream refuse the resulting session?* No.
   `resolvePrincipal`'s fail-closed branch revokes `ppbf_local` sessions only
   when `!usesPin({ role })`, and this role is `athlete`. `requirePrincipal`
   blocks while `must_change_pin` is set, and `/auth/change-pin` is reachable
   with exactly that session by design (`http.ts:35-36`).
3. *Can the platform owner find an `athlete_id` to target?* Yes. Ids are
   sequential by convention — `apps/web/app/admin/people/page.tsx:413` builds
   `` `ath-${String(highest + 1).padStart(3, '0')}` `` and the form placeholder
   is `ath-001`. `createAthleteAccount` also throws a distinct
   `'Athlete is already linked to another account'` versus
   `'Athlete not found in organization'`, which is itself a probe.
4. *Does the platform owner already have an equivalent path, making this
   redundant?* Partly, and this is the strongest argument against the severity.
   `POST /api/pilot/platform/organizations/memberships` is `platform_owner`-only
   and takes `account_id` from the body with no self-check, so the owner can
   write themselves a `coach` membership in any gym. But
   `upsertOrganizationMembership` sets
   `is_platform_owner = case when $3 = 'platform_owner' then true else false end`
   (`auth.ts:1108`) and `MANAGEABLE_ROLES` excludes `platform_owner`, so that
   path costs them platform ownership irreversibly and revokes their sessions.
   The athlete-shell path costs nothing, is reversible, and is invisible.

**Refutation result: the finding stands.** Nothing prevents it.

**Consequence.** The single role this platform bars unconditionally from a
minor's record — `assertActorCanAccessAthlete` throws for `platform_owner`
before any other check, and `boardRoleBoundaries.test.ts` pins the equivalent for
`board` — can become any not-yet-onboarded child in any gym, and read that
child's dashboard as them. Limits that are real and belong in the record: the
actor must already hold the highest-privilege identity on the platform; the
target athlete must have no account yet; and the shell creation is audited
(`event_type: 'create'`, `action: 'platform_owner_prepare_athlete_shell'`) though
the subsequent login is audited as an ordinary athlete sign-in.

**Why HIGH and not CRITICAL.** It meets the literal bar — an unauthorized party
(unauthorized *for this data*, by this platform's own doctrine) can act as a
user and reach a minor's data. I stopped at HIGH because the actor must already
be the platform owner, and because path (4) above means the boundary was already
crossable by a determined holder of that account. I am flagging the call rather
than settling it: if the reviewer weighs "the route's own documentation asserts
the safe behaviour, so no reviewer of this file would catch it" more heavily than
I did, CRITICAL is defensible.

**Note on the sibling route.** `POST /api/pilot/admin/athlete-accounts` calls the
same function and returns the same inaccurate `account_state:
'pending_pin_activation'`, but no boundary is crossed there (an org admin is
authorized for their own gym's athletes) and the `/admin/people` UI does not use
that field — it correctly displays the starting PIN and says
`"{accountId} can sign in now"`. So the response-body inaccuracy is a defect on
both routes; the *consequence* is only on the platform one.

---

### [HIGH] The platform-owner bootstrap endpoint stays armed in production indefinitely behind one static header secret

`POST /api/pilot/admin/bootstrap/platform-owner-microsoft` has no environment
guard, no one-time flag, and no expiry. Its only gate is:

> `apps/web/app/api/pilot/admin/bootstrap/platform-owner-microsoft/route.ts:61-64` —
> ```
>     if (!bootstrapKeyMatches(request.headers, bootstrapKey)) {
>       await recordDurableFailedAttempt(ipKey);
>       throw new Error('Forbidden: invalid bootstrap key');
>     }
> ```

The key is provisioned in production:

> `.github/workflows/deploy-production.yml:427` — `              PPBF_PILOT_BOOTSTRAP_KEY=secretref:ppbf-pilot-bootstrap-key \`

so `bootstrapKey` is non-empty and the route is live on the production host,
permanently. What one correct header grants:

- **Create or reactivate any organization**, with `organization_id` taken from
  the request body. `createOrganization` is an upsert whose conflict branch sets
  `status = 'active'` (`auth.ts:940-943`), so it undoes a suspension that
  `setOrganizationStatus` performed — and suspension is the control that revokes
  every session in a gym (`auth.ts:1032-1039`). It also renames the organization
  and seeds it with default compliance rules and safety gates.
- **Create, re-point, or reactivate the `platform_owner` account.**
  `createOrUpdateMicrosoftPlatformOwnerAccount`'s conflict branch sets
  `role = 'platform_owner'`, `is_platform_owner = true`, `active_flag = true`,
  `organization_id = excluded.organization_id` (`auth.ts:984-993`).

**Refutation attempted.**
1. *Does the key mint a session?* No. The provisioned identity is fixed —
   `getPrimaryOwnerEmail()` from `PPBF_PRIMARY_OWNER_EMAIL`, never from the body
   — so the key alone does not let anyone sign in. This is the main thing keeping
   it off CRITICAL, and the design decision behind it is deliberate and good
   (`auth.ts:19-23`).
2. *Is it rate limited?* Yes, and well: a durable per-IP bucket shared with the
   dead-ended sibling route, added by #424 for exactly this reason.
3. *Is the comparison timing-safe?* Yes — `security.ts:53-67` uses
   `timingSafeEqual` after a length check, and the length check itself is
   documented.
4. *Is it ever called by the deploy?* No. I grepped both workflows; the only
   `bootstrap` hits are the env-var assignments. Nothing invokes the endpoint.
   So it is armed for an operation that is never performed.
5. *Did a prior pass report this?* `PASS-02-authorization.md:988` records that
   both routes "require `PPBF_PILOT_BOOTSTRAP_KEY` behind a shared durable
   per-IP rate-limit bucket". It does not analyse what the key grants, and it
   does not note that the route is permanently live in production. This finding
   is that extension, not a re-report.

**Refutation result: the finding stands, at reduced severity.**

**Consequence.** A single long-lived shared secret, accepted on two header names,
is the sole control on reactivating a suspended gym and on rewriting the
highest-privilege account row. There is no rotation mechanism, no expiry, and no
alert. The right shape is either an environment guard (refuse when
`NODE_ENV === 'production'`, as the research bridge does for staging) or a
one-shot flag consumed on first success. **This is an owner/ops decision, not a
patch to apply from inside an audit.**

---

### [MEDIUM] `requireMicrosoftAuthenticatedPrincipal` does not mean the session was established through Microsoft

The helper's contract, as written:

> `apps/web/src/server/pilot/http.ts:45-53` —
> ```
> // Microsoft-authenticated principal requirement for privileged operations.
> // PIN/local sessions are explicitly restricted to athlete self-service and
> // cannot be used for user management, role management, or other privileged
> // actions.
> export async function requireMicrosoftAuthenticatedPrincipal(request: NextRequest): Promise<PilotPrincipal> {
>   const principal = await requirePrincipal(request);
>   if (principal.authProvider !== 'microsoft') {
> ```

`principal.authProvider` is `pilot.accounts.auth_provider` — a property of the
*account row*, not of how *this session* was obtained. The only supported
provisioning path for every non-athlete role writes that column as `'microsoft'`
unconditionally:

> `apps/web/src/server/pilot/staffProvisioning.ts:345-348` —
> ```
>        values ($1, $2, 'microsoft', $3, $4, false, null, null, true)
>        on conflict (account_id) do update set
>          login_email = excluded.login_email,
>          auth_provider = 'microsoft',
> ```

But `coach`, `staff`, `volunteer` and `parent` are `MAGIC_LINK_ROLES`
(`credentialPolicy.ts:67-72`), and `redeemMagicLink` mints an ordinary session
for them without consulting `auth_provider` at all. So every one of those
accounts holds `authProvider === 'microsoft'` while actually signing in by
emailed link, and passes this gate.

**Refutation attempted.** I checked whether any route relies on this helper as
its *only* gate. Ten route files call it without importing `requireRole`, but
nine of them enforce a role by another name — `isOrganizationAdminRole` (staff,
activation-codes, data-deletion, coach-coverage, feedback/list, feedback/triage),
`assertCanManageBoardSeats` (board/seats), `assertCanAuthorRabbitHoles` and
`assertCanManageRabbitHole` (rabbit-holes), `resolveAuthorRole`
(announcements/post). I found **no** route where this helper alone decides
access. The `auth_provider = 'magic_link'` value exists in the vocabulary
(`authProviders.ts:30`) but nothing in the application ever writes it.

**Refutation result: no exploitable route today.** The finding is that the
guarantee the helper's name, its comment, and `PASS-02-authorization.md:73-74`
("which is what keeps a PIN session out of user-management routes") all state is
narrower than it reads: it excludes `ppbf_local` sessions, and nothing more. The
next route that reaches for it expecting "this person completed Entra sign-in
with MFA" will be wrong, and the mismatch is invisible at the call site. Either
rename it to what it does (`requireNonLocalPrincipal`) or carry the actual
authentication method on the session row.

---

### [MEDIUM] The board-seat credential upgrade is enforced by nothing

`credentialPolicy.ts` states a rule and gives it a function:

> `apps/web/src/server/pilot/credentialPolicy.ts:81-90` —
> ```
> /**
>  * Holding ANY board seat requires Microsoft, whatever the holder's role.
>  *
>  * There is deliberately no list of qualifying seats. Every board office has a
>  * mailbox on punxsyprominence.org, so every seat holder already has a Microsoft
>  * identity -- and a list of "seats that count" is one more thing to fall out of
>  * date the day a ninth seat is added. Holding a seat is the whole test.
>  */
> export function seatRequiresMicrosoft(boardSeats: readonly string[] | undefined): boolean {
> ```

`seatRequiresMicrosoft` has **zero callers outside its own module**, and every
one of the six call sites of the policy passes a subject with no seats:
`magicLink.ts:124` and `:210` (`{ role: account.role }` / `{ role: row.role }`),
`auth.ts:155`, `:309`, `:646` (`{ role: … }`), and the two UI sites in
`admin/people/page.tsx`. So the `boardSeats` field of `CredentialSubject` is
never populated by anything.

**Refutation attempted.** I grepped the whole of `apps/web` for `boardSeats`,
`seatRequiresMicrosoft`, `requiredCredentialFor`, `usesPin` and `usesMicrosoft`.
The only places board seats are read are `/auth/session` and the Microsoft
callback, both for *routing*, and `board/seats` for management. I also checked
whether `assignBoardSeat` restricts targets to the `board` role — the route
validates the seat slug and the account id and delegates to `assignBoardSeat`;
nothing in the route requires the target to hold `role === 'board'`.

**Refutation result: the finding stands.** A coach, parent, staff member or
volunteer holding a board seat is, by the platform's own written rule, required
to sign in through Microsoft, and in fact still receives a magic link. The
practical exposure is small — a `board`-*role* member is already a Microsoft
role, so this only bites for a seat held by a non-board role — but a policy
function with no caller is the same shape as `readinessMath.ts` (F-08) and
`assertShadowAuthority` (F-10) that this audit has already flagged twice, and
this is the third instance. **That pattern is now worth naming as a class.**

---

### [MEDIUM] The admin-facing starting-PIN panel understates what the starting PIN can do

The panel an organization admin sees after creating an athlete account says:

> `apps/web/app/admin/people/page.tsx:880-883` —
> ```
>               <p className="t-muted mt-[var(--s3)]">
>                 The starting PIN is the same for every new athlete, so it is not a secret. It cannot be used to see
>                 anything — the only screen it opens is the one that asks them to replace it.
>               </p>
> ```

Two things are true and one is not. It is genuinely not a secret, and
`requirePrincipal` genuinely refuses every route while `must_change_pin` is set.
But "it cannot be used to see anything" is not accurate, and "the only screen it
opens" understates that screen:

- `POST /api/pilot/auth/session` deliberately uses `resolvePrincipal` rather than
  `requirePrincipal` (`session/route.ts:65-69` explains why) and returns
  `account_id`, `role`, `organization_id`, **`athlete_id`** and `auth_provider`
  on a bootstrap-PIN session.
- The screen it opens is `/change-pin`, and `changeOwnPin` needs only the current
  PIN. Whoever reaches it first owns the account permanently, and
  `must_change_pin` becomes `false`.

`pinPolicy.ts` is honest about this in source:

> `apps/web/src/server/pilot/pinPolicy.ts:16-19` —
> ```
>  * It is still guessable for the window between the admin creating the account
>  * and the athlete first signing in. Shortening that window is an operational
>  * matter -- create the account when you are with the athlete, not in a batch
>  * the week before.
> ```

**Refutation attempted.** I checked whether the admin UI states the operational
rule anywhere the admin will read it. It does not: `people/page.tsx:970-971`
says "Give them their sign-in ID and the starting PIN … If they have forgotten
where they are, 'Reset to starting PIN' on their row puts them back to it", with
no mention of a window. I also confirmed the claim is not literally salvageable
by an org-scoping argument — the session route returns the athlete id to anyone
holding the credential.

**Refutation result: the finding stands.** The mitigation `pinPolicy.ts` relies
on is *operational* — "create the account when you are with the athlete" — and
the one screen that could convey that rule tells the admin instead that there is
nothing to worry about. The fix is a sentence, not a code change: say that until
the athlete signs in and picks a PIN, anyone who knows their sign-in ID can claim
the account, so create it with the athlete present.

---

### [MEDIUM] The third call site of the bootstrap key has no rate limiting at all

`PPBF_PILOT_BOOTSTRAP_KEY` guards three endpoints. Two carry a shared durable
per-IP bucket, added by #424 with this reasoning:

> `apps/web/app/api/pilot/admin/bootstrap/route.ts:23-30` —
> ```
>     // Rate limiting: check per-IP. Durable, not just volatile -- this route
>     // always refuses below, but it still distinguishes a correct key from a
>     // wrong one via which error message comes back ("invalid bootstrap key"
>     // vs "Unsupported bootstrap path"), which is a live oracle for guessing
>     // PPBF_PILOT_BOOTSTRAP_KEY even though it never grants access. It shares
>     // the platform-owner-microsoft route's bucket key by design, and both
>     // sides of that shared budget need to be durable or a guesser can drain
>     // the volatile-only side for free per container replica.
> ```

The third has neither limiter:

> `apps/web/app/api/pilot/shadow/jobs/process/route.ts:25-26` —
> ```
> export async function POST(request: NextRequest): Promise<NextResponse> {
>   if (!bootstrapKeyMatches(request.headers, process.env.PPBF_PILOT_BOOTSTRAP_KEY)) {
> ```

A correct key returns a job result; a wrong one falls through to a session check
and returns `401`. That is the same distinguishability #424 called "a live
oracle", on an endpoint with no budget of any kind.

**Refutation attempted.** I read the whole route (50 lines) looking for a
limiter, a middleware, or a `maxDuration`-based throttle — there is none; the
only imports are `jsonError`, `bootstrapKeyMatches` and the job processor. I
also checked whether the key's own comparison leaks: `bootstrapKeyMatches`
returns early on a length mismatch (`security.ts:63-65`) before reaching
`timingSafeEqual`, so key *length* is distinguishable by timing even though the
bytes are not — which matters more on an endpoint with no attempt budget. And I
checked the blast radius claim the route makes for itself
(`jobs/process/route.ts:10-14`, "a caller can only cause work already enqueued by
authenticated users to be processed"), which appears accurate and does bound the
consequence.

**Refutation result: the finding stands, at MEDIUM not higher.** Guessing a
properly-generated random key remains infeasible; what is wrong is that the
codebase reasoned carefully about this exact oracle on two routes and left the
third untouched.

**Correction to a prior pass, recorded so it is not inherited.**
`PASS-02-authorization.md:396` lists this route's gates as
`requirePrincipal, requireRole`. Those are the *fallback* path, reached only
when the key check fails; the primary gate is the shared secret, and the pass's
mechanical classification did not see it. Anyone using that table to reason about
which routes are session-gated should treat this row as wrong.

---

### [MEDIUM] There is no lockout on any auth endpoint — the strongest guard is a 60-second delay that resets after 15 idle minutes

> `apps/web/src/server/pilot/rateLimit.ts:24-29` —
> ```
> const MAX_ATTEMPTS_THRESHOLD = 5; // Allow 5 attempts before throttling
> const INITIAL_BACKOFF_MS = 1000; // 1 second
> const MAX_BACKOFF_MS = 60000; // 1 minute
> const BACKOFF_MULTIPLIER = 2; // Double the wait time on each failed attempt
> const EXPIRY_MS = 15 * 60 * 1000; // Clear old entries after 15 minutes
> const DURABLE_WINDOW_SECONDS = 15 * 60;
> ```

and the durable store discards a bucket on the same schedule:

> `apps/web/src/server/pilot/rateLimit.ts:241-243` —
> ```
>       `delete from pilot.auth_rate_limit_buckets
>        where updated_at < now() - ($1::int * interval '1 second')`,
>       [DURABLE_WINDOW_SECONDS],
> ```

An attacker guessing a child's six-digit PIN is throttled to roughly one attempt
per 60 seconds — about 1,440 per day — indefinitely, and never locked out. Fifteen
idle minutes returns the account to a clean five-free-attempt budget. There is no
threshold at which the account is disabled and no alert.

**Refutation attempted.** Three real mitigations exist and belong here.
(1) The PIN space is not the binding constraint the raw arithmetic suggests:
`isTriviallyGuessablePin` (`pinPolicy.ts:72-95`) removes runs, repeats, cycles,
doubled digits and palindromes, so the "few dozen patterns a person actually
picks" — the code's own words — are refused. (2) Since #429, every rejection
writes a forensic line naming the reason and never the PIN (`auth.ts:127-147`).
(3) The team already knows about the 15-minute window and says so:

> `apps/web/src/server/pilot/auth.ts:121-126` —
> ```
>   // returning null. Nothing else does: the durable rate-limit bucket this
>   // route also checks is deleted once it is more than 15 minutes old
>   // (rateLimit.ts), so an attacker spacing guesses out, or spreading them
>   // across accounts, previously left zero trace anywhere once that window
>   // passed -- no forensic trail for a suspected brute-force against a
>   // minor's account.
> ```

**Refutation result: half-known, and the half that remains is real.** The
recorded decision was to add a forensic trail rather than a lockout. That is a
defensible trade — a lockout on a child's account is a denial-of-service against
the child — but it means the *only* thing standing between a patient attacker and
a minor's PIN is that somebody reads the logs. Nothing in this repository
consumes `pilot-auth login rejected`. Whether an alert exists on the log sink is
in *Could not establish*.

---

### [LOW] `magic-link/consume` is the one auth route the durable-limiter sweep missed, and #424's own message says otherwise

> `apps/web/app/api/pilot/auth/magic-link/consume/route.ts:72-79` —
> ```
>     const clientIp = getClientIp(request);
>     const ipKey = `magic_link_consume_ip:${clientIp}`;
>     if (checkRateLimit(ipKey).isLimited) {
>       return NextResponse.json(
>         { ok: false, reason: 'RATE_LIMITED' },
>         { status: 429 },
>       );
>     }
> ```

No `checkDurableRateLimit`, no `recordDurableFailedAttempt`. The route imports
neither. Yet the commit that swept the codebase for exactly this states:

> `git log -1 bc9c7e6a` — `login, activate, and magic-link all learned to check the Postgres-backed durable limiter on top of the in-memory one`

"magic-link" was one thing in that sentence and two routes in the code; `request`
got it and `consume` did not.

**Refutation attempted.** I checked whether it matters less here, and it does:
the secret being guessed is a 32-byte opaque token (`createOpaqueToken`), so
brute force is infeasible at any rate. I also confirmed the volatile limiter is
correctly *used* — `recordFailedAttempt` fires only on failure and
`clearRateLimit` on success, with a comment explaining why the earlier
record-on-every-POST version degraded a gym's shared morning-drop-off IP.

**Refutation result: real but low.** Report it because the *shape* matters — a
sweep that names its own targets and misses one of them is how the next such gap
gets introduced — not because the endpoint is weak.

---

### [LOW] Malformed JSON on `/auth/login` returns 500 where the contract specifies 400

> `apps/web/app/api/pilot/auth/login/route.ts:41` — `    const body = (await request.json()) as { account_id?: string; pin?: string };`

There is no `.catch()`. A `SyntaxError` from the parser has a message matching
none of `jsonError`'s prefixes, so it reaches the fallback:

> `apps/web/src/server/pilot/http.ts:158` — `  if (fallbackStatus === 500) {`

and the caller gets `{"error":"Internal server error"}` with status 500.
`AUTH_CONTRACT.md` specifies `400 missing or malformed request body`.
`/auth/activate` (`activate/route.ts:75`) has the identical shape. By contrast
`logout`, `change-pin`, `magic-link/request` and `magic-link/consume` all use
`.catch(() => ({}))` and behave correctly.

**Refutation attempted.** I checked whether a test or the deploy smoke check
pins the contract here. `deploy-production.yml:454-458` posts `-d '{}'` and
asserts 400 — valid JSON with missing fields, which takes the
`throw new Error('Missing account_id or pin')` path and is correctly a 400. The
malformed case is not exercised anywhere I found. **Refutation result: the
finding stands.** Consequence is cosmetic — a wrong status code and a misleading
message — but it is a stated clause of the contract this repository publishes.

---

### [LOW] `/auth/login` leaks account existence by timing

`loginWithAccountIdAndPin` returns before doing any key derivation when the
account is unknown or inactive:

> `apps/web/src/server/pilot/auth.ts:127-130` —
> ```
>   if (!data?.active_flag) {
>     console.warn('pilot-auth login rejected', { accountId, reason: 'unknown_or_inactive_account' });
>     return null;
>   }
> ```

A known active account instead runs `verifyPin`, which is scrypt with Node's
defaults (`security.ts:24`), tens of milliseconds against a sub-millisecond
query. The HTTP response is identical in both cases — that part is correct — but
the latency is not.

**Refutation attempted.** Is it usable? Barely: enumeration needs many probes,
and the `pin_ip:` bucket throttles to ~1/60s after eleven failures, durably and
fleet-wide in production. There is no dummy-hash path and no constant-time
padding, so the oracle is genuinely there; the throttle is what makes it slow.

**Refutation result: real, low, and worth recording only because of what it
chains to.** The expensive half of attacking a freshly-created athlete account is
learning the sign-in id — the PIN half is a published constant until first
sign-in (see the MEDIUM above). A timing oracle for "is this sign-in id real" is
therefore worth more here than it would be against a password login. The standard
fix is to run `verifyPin` against a fixed dummy hash on the miss path.

---

### [LOW] `redeemActivationCode` does not clear `must_change_pin`, so one account shape forces a second PIN change

`activateAccountPin` and `resetAccountPin` both set `must_change_pin = true`,
each with a paragraph explaining why. `redeemActivationCode` — the path where the
**athlete themselves** chooses the PIN — writes:

> `apps/web/src/server/pilot/activation.ts:243-246` —
> ```
>       `update pilot.accounts
>        set pin_hash = $1,
>            active_flag = true,
>            updated_at = now()
> ```

It never names `must_change_pin`. For an account created by
`createAthleteAccountPendingActivation` the column is `false` by default and all
is well. For an account created by `createAthleteAccount` it is already `true`
(`auth.ts:598`), and redeeming a code does not clear it — so the athlete signs in
with the PIN they just chose, is bounced to `/change-pin`, and `changeOwnPin`
refuses to let them keep it (`auth.ts:629-631`, `PIN must be different from the
current PIN`).

**Refutation attempted.** Is the combination reachable? `issueActivationCode`
requires only `role = 'athlete'` and `is_platform_owner = false`
(`activation.ts:138-146`) — it does not require `pin_hash is null` — so an admin
who created a live account and later issues a code produces exactly this. **The
finding stands.** It fails closed (an extra prompt, never extra access), which is
why it is LOW.

---

### [LOW] `repairStrandedGuardianAuthProvider` is the only account mutator in `auth.ts` that does not revoke sessions, and it changes the column revocation depends on

Every other function that touches role, organization, credential or active state
calls `revokeAllSessionsForAccountTx`. This one flips `auth_provider` from
`ppbf_local` to `microsoft` and clears `pin_hash` and `must_change_pin`:

> `apps/web/src/server/pilot/auth.ts:458-462` —
> ```
>     `update pilot.accounts
>      set auth_provider = 'microsoft',
>          pin_hash = null,
>          must_change_pin = false,
>          updated_at = now()
> ```

`auth_provider` is precisely the column `resolvePrincipal` reads to decide
whether to revoke a live session on sight (`auth.ts:309`). Before the repair a
stranded non-athlete session is destroyed by its own first use; after it, the
same row would resolve.

**Refutation attempted.** For this to matter, an unrevoked, unexpired session row
must exist for such an account. `loginWithAccountIdAndPin` refuses non-athletes,
so no new one can be minted; any surviving row predates that check and
`pilot_slice_postgres_session_expiry_migration.sql` backfilled `expires_at`, so
in practice they are long expired. **Refutation result: theoretical.** Recorded
because it is a genuine break in an otherwise complete invariant — "every account
mutation revokes" — and because the next person to extend this function will not
know the invariant was already broken here.

---

### [LOW] Two auth-path guards cannot deny

Same class as F-08 and F-10 already in this audit.

1. `loginWithMicrosoftEmail` refuses an unroutable role before minting a token
   (`auth.ts:220-222`), but `getPilotRoleDestination`
   (`src/shared/pilotRoleRouting.ts:20-51`) returns a path for all nine
   `PilotRole` values, so the branch cannot fire. The care taken to place it
   *before* the insert (`auth.ts:217-219`) is correct and worth keeping; the
   check itself is currently decorative.
2. The credential-policy drift guard's own surface list omits half the
   authentication surface:

> `apps/web/src/server/pilot/credentialPolicyDrift.test.ts:31-38` —
> ```
> const AUTH_SURFACE = [
>   path.join(PILOT_DIR, 'auth.ts'),
>   path.join(APP_DIR, 'login', 'page.tsx'),
>   path.join(APP_DIR, 'athlete', 'sign-in', 'page.tsx'),
>   path.join(APP_DIR, 'api', 'pilot', 'auth', 'login', 'route.ts'),
>   path.join(APP_DIR, 'api', 'pilot', 'auth', 'session', 'route.ts'),
>   path.join(APP_DIR, 'api', 'pilot', 'auth', 'activate', 'route.ts'),
> ];
> ```

`magicLink.ts`, `magicLinkStore.ts`, `http.ts`, `staffProvisioning.ts`, the two
magic-link routes and the Microsoft callback are all authentication surface and
none are in the list. The guard is well built otherwise — it asserts its own
non-vacuity and proves its regex matches — but a second copy of the sign-in rule
appearing in the magic-link path would not be caught. Nothing has drifted today;
I checked all six current call sites.

---

### [LOW] The post-login redirect origin is built from an unvalidated `x-forwarded-host`

> `apps/web/src/server/pilot/microsoftOAuthFlow.ts:73-81` —
> ```
>   const forwardedHost = input.forwardedHostHeader?.split(',')[0]?.trim();
>   if (forwardedHost) {
>     const protocol = resolveRequestProtocol({
>       nextUrlProtocol: new URL(input.requestUrl).protocol,
>       forwardedProtoHeader: input.forwardedProtoHeader,
>     });
>
>     return `${protocol}://${forwardedHost}`;
>   }
> ```

There is no allowlist. Both the success destination and every `redirectToLogin`
in the Microsoft callback are built against this origin.

**Refutation attempted, and it substantially defuses this.** The header is set by
the ingress, not by a browser, so an attacker cannot make a *victim's* request
carry a forged value. The session cookie is set on the response to the real host
regardless of what the `Location` header says, so no token travels to a forged
origin. And `/auth/microsoft/start` canonicalises: `resolveCanonicalAuthStartRedirect`
(`microsoftOAuthFlow.ts:86-99`) bounces any request whose origin differs from the
configured `callbackUrl` origin back to that origin before any state is issued.
The same unvalidated-host shape appears in `researchBridgeAuth.ts:37-45`, where
the `Host` header decides whether the export surface is "active" — but that gate
is additionally pinned to `RESEARCH_BRIDGE_EXPORT_ENVIRONMENT === 'staging'` and
still requires a verified tenant JWT.

**Refutation result: not currently exploitable through any path I could
construct.** Recorded as a latent open-redirect primitive on the auth surface,
and because whether the ingress overwrites or appends this header is in
*Could not establish*.

---

## Checked and found sound

Recorded deliberately — a pass that only lists defects misrepresents this
codebase, and several of these are the reason findings above are LOW rather than
worse.

**Role change invalidates the session. Every time.** This was the sharpest
question in the brief and the answer is yes, on all ten mutating paths:
`upsertOrganizationMembership`, `transferOrganizationAdmin`,
`promoteAccountToOrganizationAdmin`, `createOrRotateAdminAccount`,
`createOrUpdateMicrosoftPlatformOwnerAccount` (when the account existed),
`createOrUpdateMicrosoftStaffAccount` (when the account existed),
`setAccountActiveStatus` (on deactivate), `setOrganizationStatus` (on any
non-active status, org-wide), `activateAccountPin`, `resetAccountPin`,
`changeOwnPin` and `redeemActivationCode` all revoke inside the same transaction.
The reasoning is written down and it is the right reasoning:

> `apps/web/src/server/pilot/auth.ts:1119-1128` —
> ```
>     // pilot.accounts.role/organization_id are read live on every request
>     // (resolvePrincipal doesn't scope role to the session's own
>     // organization), so ANY membership mutation here can change what an
>     // existing session resolves to -- a brand-new membership in another
>     // organization, a role change, a reactivation, or a deactivation all
>     // rewrite those columns. Fail closed and always revoke rather than try
>     // to prove a specific case didn't change anything: an old session in
>     // organization A must never be able to inherit a role or organization
>     // assigned here.
> ```

I enumerated all ten `pilot.organization_memberships` write sites and all four
`pilot.session_tokens` insert sites to check this rather than trusting the
comment. The only exception is `repairStrandedGuardianAuthProvider` (LOW above),
and the deliberate, documented exception of `setAccountMasterShadowAccess`, which
does not need to revoke because the flag is read live.

**Cross-organization resolution: I could not construct one.** `role` comes from
`pilot.accounts.role` and is *not* scoped to the session's organization, which is
the one structural weakness — but the session's organization is always the
account's own organization at mint time (both login paths and `redeemMagicLink`
use the account row's `organization_id`), any change to that column revokes every
session, and `resolvePrincipal` additionally requires an active membership in the
resolved organization. The `|| getPilotDefaultOrganizationId()` fallbacks at
`auth.ts:132`, `:212` and `:317` would be a cross-org hazard if
`organization_id` could be null, and it cannot: `organization_id text not null
references pilot.organizations(organization_id)` in `pilot_slice_postgres.sql:30`
and `:52`. The TypeScript types say `string | null`; the database says otherwise
and the database wins. `createOrUpdateMicrosoftStaffAccount` and
`createOrUpdateAthleteAccount` both refuse a cross-organization takeover
explicitly.

**Token handling.** Session tokens: 32 random bytes, sha256 before storage, never
logged, 24-hour absolute expiry from a single constant that both the cookie and
the DB row derive from. Magic-link tokens: hashed, 15 minutes, single-use under a
row lock, superseded on re-issue, re-validated against `active_flag`, role and
the address *as sent* at redemption. Activation codes: hashed, single-use under
`for update`, superseded on re-issue, TTL bounded, never written to the audit
trail (`activation-codes/route.ts:100-101` says why). I grepped every
`console.*` in the auth modules and routes: not one logs a token, a PIN, a code
or a secret. `bootstrapKeyMatches` uses `timingSafeEqual`. `verifyPin` uses
`timingSafeEqual`. Magic-link lookup is by hash on the primary key, and
`magicLink.ts:227-228` explains correctly why no timing-safe comparison is needed
there.

**Enumeration.** `magic-link/request` returns the same 202 and the same body for
every outcome, records the rate-limit attempt even on success so that "no attempt
recorded" is not itself a signal, and swallows Graph failures for the same
reason — a well-argued design (`magic-link/request/route.ts:10-31, 64-77`).
`/auth/login` returns an identical 401 for unknown account, wrong PIN, no PIN,
suspended organization and ineligible role (the timing caveat is the LOW above).
`revokeAllSessionsForAccountInOrganization` returns one generic error for four
distinct denial reasons. `issueActivationCode` refuses coaches, admins, foreign
organizations and non-existent accounts with one message. `hiddenNotFound` exists
as a primitive for exactly this.

**OIDC.** PKCE S256, `prompt=login`, RS256-only algorithm allowlist, `kid`
required, JWKS-verified signature, then `iss`/`aud`/`tid`/`exp`/`nbf`/`nonce`.
State, verifier, nonce and issued-at each in their own `httpOnly` cookie with a
10-minute TTL and a replay guard. Every external call carries
`AbortSignal.timeout`. The `max_age` omission is deliberate and the reasoning
(`federatedAuth.ts:111-119`) is correct. `loginWithMicrosoftEmail` decides every
refusal *before* the token insert, and says why (`auth.ts:217-219`).

**The gate-session script cannot touch production.** `apps/web/scripts/lib/gate-session.mjs`
writes directly to `pilot.session_tokens`, which is the sharpest thing in the
repository — but it is invoked only from `deploy-staging.yml` (I grepped both
workflows; `deploy-production.yml` runs unauthenticated smoke checks only), it
provisions nothing, it verifies the fixture is already in the required state, it
refuses privileged local accounts with a stated reason, its TTL is 30 minutes,
and it revokes in a `finally`.

**`must_change_pin` as a default-deny.** Enforcing it in `requirePrincipal`
rather than per-route is the right shape: a new route inherits the protection and
cannot forget it. The `=== true` rather than truthiness check is deliberate and
correct for an optional field.

**Session cleanup.** `cleanupExpiredSessions` deletes on *either* terminal
condition, validates `retentionDays` at the service boundary rather than only in
the CLI wrapper, and is capped by `MAX_SESSION_RETENTION_DAYS`.

**Audit writes never fail a successful sign-in.** `login`, `activate` and
`magic-link/consume` each wrap the audit write and log a sanitized SQLSTATE
instead of throwing, each with a comment explaining that the write already
committed.

**`login_email` is unique.** `pilot_accounts_login_email_uq` on
`lower(login_email)` (`pilot_slice_postgres.sql:45-47`) is what makes
`findAccountByEmail`'s unqualified `queryOne` deterministic. I went looking for a
two-rows-one-email hazard and the constraint refutes it.

---

## Could not establish

Stated as holes, not guessed.

1. **Whether the athlete sign-in id is practically guessable.** `account_id` is
   free text typed by an admin (`admin/athlete-accounts/route.ts:28`); the UI
   suggests nothing for it and offers no generator, unlike `athlete_id` which is
   sequential `ath-NNN`. If the gym's convention is a stage name known to
   teammates, the HIGH-1 chain and the starting-PIN MEDIUM both get materially
   easier. **What would settle it:** a `select account_id from pilot.accounts
   where role = 'athlete'` against production, read by someone authorized to do
   so. Nobody in this session can see that.

2. **Whether `PPBF_TRUSTED_PROXY_COUNT` is correct for the deployed ingress.** It
   is set nowhere — not in `.env.example`, not in either workflow — so it
   defaults to 1 (`rateLimit.ts:90-94`). If Azure Container Apps ingress adds a
   different number of hops, `getClientIp` reads the wrong position in
   `X-Forwarded-For` and every per-IP bucket keys on either an attacker-chosen
   value or a constant. The code is explicitly aware of this failure mode
   (`rateLimit.ts:127-131`). **What would settle it:** one request to the
   production host echoing the received `X-Forwarded-For`, or the ingress
   configuration.

3. **Whether anything alerts on `pilot-auth login rejected`.** Nothing in this
   repository consumes it. The no-lockout MEDIUM rests entirely on whether a
   human sees these lines. **What would settle it:** the log-analytics alert
   rules on the production Container App.

4. **Whether the production bootstrap endpoint has ever been called.** The audit
   trail would show it (`event_type` `create`/`update` with
   `action: 'bootstrap_platform_owner_microsoft'`). **What would settle it:**
   `select * from pilot.audit_events where details->>'action' =
   'bootstrap_platform_owner_microsoft'` against production.

5. **Whether `x-forwarded-host` is overwritten or appended by the ingress.**
   Decides whether the LOW open-redirect primitive is inert or merely
   hard to reach. **What would settle it:** the ingress header policy.

6. **Whether any account currently holds `auth_provider = 'microsoft'` together
   with a magic-link role.** The provisioning path writes exactly that shape
   (`staffProvisioning.ts:345-348`), so it should be every coach, staff member,
   volunteer and parent — but I have read code, not rows. **What would settle
   it:** `select role, auth_provider, count(*) from pilot.accounts group by 1,2`.

7. **What the 37 unread auth-domain test files actually pin.** That question
   belongs to pass 10 and I did not duplicate it. I read one
   (`credentialPolicyDrift.test.ts`) because a finding above concerns its
   coverage.
