# Auth Contract

The backend contract for authentication and role discovery, as the code
implements it. Checked against the route handlers on 2026-09-21.

## Current behavior

- Server token strategy: opaque session token in an HTTP-only cookie, hashed in `pilot.session_tokens`
- Auth record source: `pilot.accounts`
- Authorization role set (`PilotRole` in [contracts.ts](apps/web/src/server/pilot/contracts.ts), the type `requireRole` enforces against): `platform_owner`, `organization_admin`, `admin`, `coach`, `athlete`, `parent`, `board`, `volunteer`, `staff`. [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md) describes what each may see.
- Client route model (`ClubRole` in [roleRoutes.ts](apps/web/components/roleRoutes.ts)) additionally splits the board seat into `board-president`, `board-chair`, `board-vice-chair`, `board-treasurer`, `board-secretary`, `board-safety-director`, `board-community-director`, `board-at-large`. Those seats select a landing page; they are not authorization roles and the server never issues one.

Route handlers under `apps/web/app/api/pilot/auth/`:

| Route | Methods | Specified below |
|---|---|---|
| `/api/pilot/auth/login` | `POST` | yes |
| `/api/pilot/auth/logout` | `POST` | yes |
| `/api/pilot/auth/session` | `POST` | yes |
| `/api/pilot/auth/activate` | `POST` | no -- read the route |
| `/api/pilot/auth/change-pin` | `POST` | no -- read the route |
| `/api/pilot/auth/logout-all` | `POST` | no -- read the route |
| `/api/pilot/auth/magic-link/request` | `POST` | no -- read the route |
| `/api/pilot/auth/magic-link/consume` | `GET`, `POST` | no -- read the route |
| `/api/pilot/auth/microsoft/start` | `GET` | no -- read the route |
| `/api/pilot/auth/microsoft/callback` | `GET` | no -- read the route |

Which credential a person uses (Microsoft, magic link, or account ID + PIN) is
decided in [credentialPolicy.ts](apps/web/src/server/pilot/credentialPolicy.ts).
In staging and production, PIN sign-in admits only athletes; `pinLoginPermitted`
adds the BASE-03 offline local-runtime exception.

Other source files: [auth.ts](apps/web/src/server/pilot/auth.ts),
[http.ts](apps/web/src/server/pilot/http.ts),
[sessionPolicy.ts](apps/web/src/server/pilot/sessionPolicy.ts).

## Endpoint contract

### POST /api/pilot/auth/login

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
  "organization_id": "string",
  "athlete_id": "string | null",
  "has_master_shadow_access": "boolean"
}
```

The role is the one stored on the account; the route never overrides it.

Response on failure:

```json
{
  "error": "Invalid credentials"
}
```

Status codes:

- `200` success
- `400` a missing `account_id` or `pin`. A body that is not valid JSON is
  not mapped: `request.json()` throws and `jsonError` falls back to `500`
  (read from the code, 2026-09-21)
- `401` invalid credentials
- `429` too many attempts -- per account or per IP, from a durable and a
  volatile limiter; a failed attempt counts against both, and a success clears
  them
- `500` unexpected server failure

### POST /api/pilot/auth/logout

Request: authenticated session cookie required.

Response on success:

```json
{ "ok": true }
```

Status codes:

- `200` success
- `401` no authenticated session
- `403` the account must change its PIN first (`requirePrincipal` in
  `http.ts` refuses a session with `must_change_pin` set:
  `Forbidden: PIN change required before using this account`)
- `500` unexpected server failure

Behavior: revokes the token server-side, writes a `logout` audit event, and
clears the session cookie.

### POST /api/pilot/auth/session

`POST` only; no request body is required or read, and the browser supplies the
session cookie. **A `GET` answers `405`**, and because
`loadAuthoritativeRoleSession` treats any non-401 failure as unauthenticated, a
`GET` here makes every gated page drop a valid session and bounce its owner to
`/login` (2026-08-22 correction; [RoleSessionGate.tsx](apps/web/components/RoleSessionGate.tsx)
and [GlobalRoleHeader.tsx](apps/web/components/GlobalRoleHeader.tsx) carry the
incident in their comments).

Response when authenticated:

```json
{
  "authenticated": true,
  "account_id": "string",
  "role": "string",
  "organization_id": "string",
  "athlete_id": "string | null",
  "auth_provider": "microsoft | ppbf_local | magic_link",
  "must_change_pin": "boolean",
  "pin_auth_permitted": "boolean",
  "board_seat": "string | null   -- board role only, otherwise absent",
  "board_seats": "array          -- board role only, otherwise absent"
}
```

`pin_auth_permitted` is always a boolean on the wire: `true` for a `ppbf_local`
session the server admitted, `false` for every other provider. The
`PilotPrincipal` field is typed optional only so hand-built test fixtures need
not restate it; `resolvePrincipal`, the sole source of this response, always
sets it.

`pin_auth_permitted` is the server's ATTESTATION of its own PIN-policy verdict,
not an authorization the client makes. `resolvePrincipal` reaches its return for
a `ppbf_local` session only because `pinLoginPermitted` already admitted it, so
this field reports that decision. The inputs stay on the server -- `NODE_ENV`,
the offline runtime flag, whether the database connection is loopback, and
board-seat state -- because the browser must not see them and could not obtain
three of them.

`components/roleSession.ts` reads it and never recomputes it: a `ppbf_local`
session proceeds only on `pin_auth_permitted === true`, and one arriving without
it stays `privileged_auth_required`. Absence is not consent.

Response when unauthenticated:

```json
{ "authenticated": false }
```

Status codes:

- `200` always for a valid `POST`, authenticated or not -- an unauthenticated
  caller gets `200` with `"authenticated": false`, never `401`
- `405` for any other method, `GET` included
- `500` unexpected server failure

### Role catalog endpoint (proposed, not built -- open design question)

An earlier draft of this contract proposed `GET /auth/roles`, returning one
catalog "the frontend can render and the backend can authorize against" that
"should match" [roleRoutes.ts](apps/web/components/roleRoutes.ts), for example:

```json
{
  "roles": [
    { "role": "athlete", "label": "Athlete", "href": "/athlete/dashboard" }
  ]
}
```

Those are two different catalogs. `PilotRole` is the authorization union;
`ClubRole` is the navigation model and adds the board-seat values, which are
not authorization roles. A design has to pick one, or define both separately,
before anything is built. In the existing API family the path would be
`/api/pilot/auth/roles`. No such route exists under
`apps/web/app/api/pilot/auth/` (checked 2026-09-21), and whether it is still
wanted is also open.

## Error mapping

`jsonError` in [http.ts](apps/web/src/server/pilot/http.ts) maps a thrown
error to a status across the pilot API:

- a `PilotError` carries its own status;
- `MedicalStatusBlockedError` and `GuardianConsentMissingError` -> `409`, with
  their message disclosed (checked before any prefix matching);
- otherwise by message prefix: `Unauthorized` -> `401`; `Forbidden` -> `403`;
  `Missing`, `Request body`, `Unsupported` or `PIN` -> `400`; `Not found` or
  `Athlete not found` -> `404`; the already-exists conflicts (account, athlete
  link, athlete record, coverage, hold) -> `409`;
- a SHADOW runtime outage -> `503`;
- anything else -> `500`, with the raw message withheld from the client.

Login's `429` is set by the login route itself. Session's `405` is Next.js
answering a method the route does not export.

## Session and token

- One opaque token per session, generated server-side at login.
- Only the hash is persisted (`pilot.session_tokens`); only the raw token is
  returned, in the cookie.
- Cookie: `httpOnly`, `sameSite=lax`, `secure` in production, `path=/`,
  `maxAge = SESSION_ABSOLUTE_LIFETIME_SECONDS` from
  [sessionPolicy.ts](apps/web/src/server/pilot/sessionPolicy.ts).
- Logout revokes the stored token row and sets the cookie to empty with
  `maxAge: 0`.
- Session lookup resolves the principal from the cookie, then joins to the
  account table.

## Authorization boundary

- Frontend UI may hide or show controls based on the server session.
- Security decisions must be enforced by the backend.
- Browser storage must not be the source of truth for auth state.
