# Auth Contract

This document defines the production backend contract for auth and role discovery, based on the current repository behavior and the requested server-facing endpoints.

## Observed Current Behavior

- Current login route: `POST /api/pilot/auth/login`
- Current session route: `POST /api/pilot/auth/session`
- Current logout route: `POST /api/pilot/auth/logout`
- Current server token strategy: opaque session token stored in an HTTP-only cookie and hashed in `pilot.session_tokens`
- Current auth record source: `pilot.accounts`
- Current role set in the app: `athlete`, `coach`, `parent`, `admin`, `board-president`, `board-chair`, `board-vice-chair`, `board-treasurer`, `board-secretary`, `board-safety-director`, `board-community-director`, `board-at-large`

Relevant source files:

- [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts)
- [apps/web/app/api/pilot/auth/logout/route.ts](apps/web/app/api/pilot/auth/logout/route.ts)
- [apps/web/app/api/pilot/auth/session/route.ts](apps/web/app/api/pilot/auth/session/route.ts)
- [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts)
- [apps/web/components/roleRoutes.ts](apps/web/components/roleRoutes.ts)

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

## Authorization Boundary

- Frontend UI may hide or show controls based on the server session.
- Security decisions must be enforced by the backend.
- Browser storage must not be the source of truth for auth state.
