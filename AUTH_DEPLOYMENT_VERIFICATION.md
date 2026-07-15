# Auth Deployment Verification

## Deployment architecture

- Detected target: Azure Static Web App.
- Evidence:
  - Workflow name and deploy action in [.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml#L1).
  - Static Web Apps deploy action in [.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml#L20).
  - App output set to static build folder out in [.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml#L32).
  - API location is empty in [.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml#L31).

Not indicated by deployment config as primary runtime:

- Azure App Service
- Container runtime

## next.config.ts compatibility impact

- Static export is enabled with output export in [apps/web/next.config.ts](apps/web/next.config.ts#L7).
- Impact for route handlers:
  - [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts#L10)
  - [apps/web/app/api/pilot/auth/logout/route.ts](apps/web/app/api/pilot/auth/logout/route.ts#L10)
  - [apps/web/app/api/pilot/auth/session/route.ts](apps/web/app/api/pilot/auth/session/route.ts#L8)

Because deployment publishes static output and the workflow does not configure an API runtime, these Next route handlers are not included as executable server endpoints in the current production deployment.

## Login execution path

Actual file chain:

1. Login page calls auth endpoint in [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L74).
2. Route handler receives credentials in [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts#L10).
3. Auth service validates credentials in [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts#L20).
4. Storage layer query runs against PostgreSQL via [apps/web/src/server/pilot/db.ts](apps/web/src/server/pilot/db.ts#L21).
5. Session creation occurs by generating token, hashing token, inserting session row, and setting cookie:
   - Token and insert in [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts#L34).
   - Cookie set in [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts#L38).

## Session validation execution path

Actual file chain:

1. Login page checks session endpoint in [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L51).
2. Session route handler in [apps/web/app/api/pilot/auth/session/route.ts](apps/web/app/api/pilot/auth/session/route.ts#L8).
3. Principal resolution in [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts#L49).
4. Cookie name source in [apps/web/src/server/pilot/env.ts](apps/web/src/server/pilot/env.ts#L1).
5. Session token and account lookup query in [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts#L61) using database client in [apps/web/src/server/pilot/db.ts](apps/web/src/server/pilot/db.ts#L21).

## Logout execution path

Actual file chain:

1. Client logout call in [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L41) and [apps/web/components/GlobalRoleHeader.tsx](apps/web/components/GlobalRoleHeader.tsx#L18).
2. Route handler in [apps/web/app/api/pilot/auth/logout/route.ts](apps/web/app/api/pilot/auth/logout/route.ts#L10).
3. Principal required in [apps/web/src/server/pilot/http.ts](apps/web/src/server/pilot/http.ts#L7).
4. Session revoke in [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts#L84).
5. Cookie cleared in [apps/web/app/api/pilot/auth/logout/route.ts](apps/web/app/api/pilot/auth/logout/route.ts#L25).

## Route deployability in current architecture

- login route [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts#L10): ❌ Not Deployable
  - Evidence: static export enabled in [apps/web/next.config.ts](apps/web/next.config.ts#L7), API location empty in workflow [.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml#L31), deployment publishes out folder in [.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml#L32).

- logout route [apps/web/app/api/pilot/auth/logout/route.ts](apps/web/app/api/pilot/auth/logout/route.ts#L10): ❌ Not Deployable
  - Same evidence as above.

- session route [apps/web/app/api/pilot/auth/session/route.ts](apps/web/app/api/pilot/auth/session/route.ts#L8): ❌ Not Deployable
  - Same evidence as above.

## Can current production deployment execute route handlers

- Determination: No.
- Evidence: deployment is configured as static output with no API runtime attached.

## Blocking issues

1. Static export mode in [apps/web/next.config.ts](apps/web/next.config.ts#L7) removes server runtime execution in deployed artifact.
2. Auth depends on Next route handlers under app/api but deploy workflow has empty api_location in [.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml#L31).
3. Login and logout clients call endpoints that are not executable under the current deployment settings:
   - [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L41)
   - [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L51)
   - [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx#L74)
   - [apps/web/components/GlobalRoleHeader.tsx](apps/web/components/GlobalRoleHeader.tsx#L18)

## Minimum-change remediation path

1. Keep the current front-end static deployment.
2. Add a deployable API runtime for auth routes in Azure Static Web Apps by configuring api_location to a supported backend function app path.
3. Move or expose auth endpoints from Next app/api to that API runtime with the same contracts currently used by the frontend calls.
4. Update frontend auth endpoint base paths only if required by the API mounting path.

Alternative path with broader impact:

- Switch deployment target from static export to a server runtime deployment model that executes Next route handlers directly.

## Success-criteria answer

Can the currently deployed application execute its authentication system in production?

No.