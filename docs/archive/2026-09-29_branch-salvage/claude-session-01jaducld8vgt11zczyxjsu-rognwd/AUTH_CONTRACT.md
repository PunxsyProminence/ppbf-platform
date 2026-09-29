# Auth Contract

This document defines the production backend contract for auth and role discovery, based on the current repository behavior and the requested server-facing endpoints.

## Observed Current Behavior

- Current login route: `POST /api/pilot/auth/login`
- Current session route: `POST /api/pilot/auth/session`
- Current logout route: `POST /api/pilot/auth/logout`
- Current server token strategy: opaque session token stored in an HTTP-only cookie and hashed in `pilot.session_tokens`
- Current auth record source: `pilot.accounts`
- Current authorization role set (`PilotRole`, the type `requireRole` enforces against): `platform_owner`, `organization_admin`, `admin`, `coach`, `athlete`, `parent`, `board`, `volunteer`, `staff`
- Current client route model (`ClubRole`) additionally splits the board seat into `board-president`, `board-chair`, `board-vice-chair`, `board-treasurer`, `board-secretary`, `board-safety-director`, `board-community-director`, `board-at-large`. Those seats select a landing page; they are not authorization roles and the server never issues one.
- Current standing cross-organization privileges: two, and role is only one of them. The `platform_owner` role is the first. The second is `has_master_shadow_access`, a `boolean not null default false` column on `pilot.accounts` that `resolvePrincipal` reads on every request and carries on the principal as `hasMasterShadowAccess`. It is an account-level attribute, not a value of `PilotRole` and not a row in `pilot.organization_memberships`, so a reader who treats the role set above as the whole cross-organization story reaches the wrong answer about tenant isolation. See [Cross-Organization Privileges](#cross-organization-privileges).

Relevant source files:

- [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts)
- [apps/web/app/api/pilot/auth/logout/route.ts](apps/web/app/api/pilot/auth/logout/route.ts)
- [apps/web/app/api/pilot/auth/session/route.ts](apps/web/app/api/pilot/auth/session/route.ts)
- [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts)
- [apps/web/src/server/pilot/contracts.ts](apps/web/src/server/pilot/contracts.ts)
- [apps/web/components/roleRoutes.ts](apps/web/components/roleRoutes.ts)
- [apps/web/src/server/pilot/credentialPolicy.ts](apps/web/src/server/pilot/credentialPolicy.ts)
- [apps/web/app/api/pilot/platform/users/master-shadow-access/route.ts](apps/web/app/api/pilot/platform/users/master-shadow-access/route.ts)
- [apps/web/app/api/pilot/shadow/research-bridge/session-export/route.ts](apps/web/app/api/pilot/shadow/research-bridge/session-export/route.ts)

## Endpoint Contract

Login, logout, and session are already implemented (at the `/api/pilot/auth/*`
paths listed above under Observed Current Behavior) and match the contract
below. `GET /auth/roles` is the one proposed addition, not yet built.

### POST /auth/login (implemented)

Request body:

```json
{
  "account_id": "string",
  "pin": "string"
}
```

Response on success:

```json
{
  "ok": true,
  "account_id": "string",
  "role": "string",
  "athlete_id": "string | null"
}
```

Response on failure:

```json
{
  "error": "Invalid credentials"
}
```

Status codes:

- `200` success
- `400` missing or malformed request body
- `401` invalid credentials
- `500` unexpected server failure

Session behavior:

- Server sets an HTTP-only session cookie.
- Session token is opaque.
- Server stores the hashed token in the database.

### POST /auth/logout (implemented)

Request:

- Authenticated session cookie required.

Response on success:

```json
{ "ok": true }
```

Status codes:

- `200` success
- `401` no authenticated session
- `500` unexpected server failure

Session behavior:

- Revoke the token server-side.
- Clear the session cookie.

### GET /auth/session (implemented)

Request:

- Session cookie supplied automatically by the browser.

Response when authenticated:

```json
{
  "authenticated": true,
  "account_id": "string",
  "role": "string",
  "athlete_id": "string | null"
}
```

Response when unauthenticated:

```json
{ "authenticated": false }
```

Status codes:

- `200` always for a valid request path
- `500` unexpected server failure

### GET /auth/roles (proposed, not built)

Purpose:

- Return the authoritative role catalog the frontend can render and the backend can authorize against.

Proposed response:

```json
{
  "roles": [
    { "role": "athlete", "label": "Athlete", "href": "/athlete/dashboard" }
  ]
}
```

Contract notes:

- The role catalog should match the current app route model in [apps/web/components/roleRoutes.ts](apps/web/components/roleRoutes.ts).
- This endpoint is not present in the current repository and will need to be added in the backend layer.

## Error States

- `400` missing request fields, malformed JSON, or unsupported payload.
- `401` invalid credentials or no authenticated session.
- `403` authenticated but not authorized for the requested resource.
- `500` unexpected server, database, or crypto failure.

The current server helper already maps these cases through `jsonError` in [apps/web/src/server/pilot/http.ts](apps/web/src/server/pilot/http.ts).

## Session Model

- One opaque token per session.
- Token is issued at login.
- Token is stored only in an HTTP-only cookie on the client.
- Token hash is stored in the database.
- Logout revokes the stored token row.
- Session lookup resolves the principal from the cookie, then joins to the account table.

## Token Strategy

- Generate an opaque token server-side.
- Hash the token before persisting it.
- Return only the raw token in the cookie.
- Mark the cookie `httpOnly`, `sameSite=lax`, `secure` in production, and set a long-lived max age only if that is intended for the deployment policy.

## Cross-Organization Privileges

Two things, and only two, let an authenticated principal reach data outside its
own organization: the `platform_owner` role, and the account-level flag
`has_master_shadow_access`. The second is the newer of the two and is not
visible anywhere in the role set, so it is stated here in full.
[apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts) is the
authority for it, not this document.

Where it lives and how it is read:

- `pilot.accounts.has_master_shadow_access`, `boolean not null default false`.
- Both login paths select it, and `resolvePrincipal` selects it again on every
  request and sets `hasMasterShadowAccess` on the principal. It is deliberately
  never cached on the session token, so a revoke takes effect on the holder's
  next request and there is no session to invalidate.

Who may grant or revoke it:

- `platform_owner` only, through `POST /api/pilot/platform/users/master-shadow-access`,
  which is gated `requirePrincipal` then `requireRole(principal, ['platform_owner'])`
  — the same bar as the other platform-level cross-organization actions
  (`platform/users/status`, `platform/organizations/status`,
  `platform/organizations/assign-admin`, `platform/organizations/transfer-admin`).
- That route is the only write path in the application. Before it existed, the
  only way an account ever held the flag was a direct database write.

What refuses it:

- the `UPDATE` statement itself carries `role not in ('athlete', 'parent')`, so
  an athlete or parent target matches zero rows and the call throws. The refusal
  is in the statement rather than in the route, so a later caller of
  `setAccountMasterShadowAccess` cannot skip it by forgetting to repeat it.
- an ineligible target and a nonexistent one return the same `Not found`
  message, so a caller cannot use the response to learn which account IDs exist.

Audit:

- both directions are audited. Grant and revoke each write a pilot audit event
  (`event_type: 'update'`, `entity_type: 'account'`, `entity_id` the target
  account, `details.action` of `grant_master_shadow_access` or
  `revoke_master_shadow_access`) naming the acting platform owner.

What it opens:

- exactly one route today: `GET /api/pilot/shadow/research-bridge/session-export`.
  Holding the flag widens that route's scope from the caller's own organization
  to every organization on record except the reserved platform-library
  organization, regardless of organization status. It is checked before the
  organization-admin branch, so a holder is never silently narrowed to its own
  organization.
- the flag widens organization scope only. The payload is the same
  `buildResearchBridgeExport` output the organization-scoped branch returns:
  de-identified research needs and approved evidence, opaque hashed IDs,
  redacted free text, and research needs carrying any subject link filtered out.
  It does not lift de-identification, and no other route, guard, or read model
  consults `hasMasterShadowAccess`.
- the PIN login response body echoes `has_master_shadow_access`, but PIN sign-in
  admits only athletes and an athlete account cannot hold the flag, so that
  field is always `false` there.

Session strength, stated plainly:

- the session-export route authenticates with `requirePrincipal`, not
  `requireMicrosoftAuthenticatedPrincipal`, so the route's own guard does not
  demand a Microsoft-authenticated session. Its four sibling cross-organization
  routes (`platform/users/status`, `platform/organizations/status`,
  `platform/organizations/assign-admin`, `platform/organizations/transfer-admin`)
  all do the same. This is a platform-wide property of that route family, not a
  defect of one route.
- what actually keeps a PIN session out of them sits one layer up, in the
  session layer: `credentialPolicy.ts` classifies `platform_owner`,
  `organization_admin`, `admin`, and `board` as Microsoft roles; PIN login
  refuses any role that is not PIN-eligible before a token row is written; and
  `resolvePrincipal` revokes on sight any live `ppbf_local` session whose role
  does not use a PIN. A PIN-issued privileged session therefore cannot be minted
  and cannot survive resolution — but that guarantee is held by the session
  layer, and these five route guards do not restate it.

## Authorization Boundary

- Frontend UI may hide or show controls based on the server session.
- Security decisions must be enforced by the backend.
- Browser storage must not be the source of truth for auth state.
