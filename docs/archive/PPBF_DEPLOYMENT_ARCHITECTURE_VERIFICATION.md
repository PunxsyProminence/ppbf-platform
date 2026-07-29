# PPBF Deployment Architecture Verification

Mode: Audit only
Date: 2026-07-13

## Repository Evidence Used

- Main deploy workflow: [.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml](.github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml)
- Alternate staging workflow: [.github/workflows/deploy-staging.yml](.github/workflows/deploy-staging.yml)
- Static export config: [apps/web/next.config.ts](apps/web/next.config.ts)
- SWA routing config: [apps/web/staticwebapp.config.json](apps/web/staticwebapp.config.json)
- Role gating and session model:
  - [apps/web/components/RoleSessionGate.tsx](apps/web/components/RoleSessionGate.tsx)
  - [apps/web/components/RoleStandaloneView.tsx](apps/web/components/RoleStandaloneView.tsx)
  - [apps/web/components/roleRoutes.ts](apps/web/components/roleRoutes.ts)
  - [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts)
- Pilot backend access control examples:
  - [apps/web/app/api/pilot/athletes/route.ts](apps/web/app/api/pilot/athletes/route.ts)
  - [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts)
  - [apps/web/app/api/pilot/admin/bootstrap/route.ts](apps/web/app/api/pilot/admin/bootstrap/route.ts)

## 1) What happens when I push today?

For pushes to main, the active CI/CD path builds and deploys the static site from apps/web to Azure Static Web Apps.

- Trigger: push to main
- Build command: npm install && npm run build
- App location: apps/web
- Output location: out
- API location: empty

Impact:
- Front-end static output is deployed.
- No SWA API backend is deployed from this workflow because api_location is empty.
- With output export mode enabled, this is a static front-end deployment path.

## 2) Is the platform one app, two deployable apps, or multiple front ends sharing one backend?

Current state is best described as:

- One primary deployable app with role-based workspaces in apps/web.
- A second deploy path exists (manual workflow_dispatch) to a staging Azure Container App, but it is not the main push-to-main production path.
- Not currently operating as multiple front ends sharing one production backend in the default push workflow.

Conclusion: operationally today, mainline push deploys one static front-end app.

## 3) Which routes are public?

Confirmed public entry and public-access surfaces by repository evidence:

- /public (explicit rewrite in SWA config and public portal page)
- /login
- / (redirect shell that routes to login or stored role route)
- /dashboard (same redirect behavior)

Additional routes that currently have no explicit RoleSessionGate wrapper in page code include examples such as:

- /source-control
- /source-control/publication-workflow
- /audit
- /board

Note: these are code-level observations from current route components. They are not all explicitly marked public business surfaces, but they are not protected by RoleSessionGate at page level.

## 4) Which routes require authentication?

Routes wrapped with RoleSessionGate or RoleStandaloneView require a role session and redirect to /login when no session exists.

Confirmed examples:

- /operations
- /admin
- /admin/compliance-center
- /admin/shadow
- /athlete/dashboard
- /athlete/video-analysis
- /athlete/progression-intelligence
- /coach/review-queue
- /coach/progression-intelligence
- /coach/video-analysis
- /coach/environment/intake-router
- /parent/dashboard
- /parent/progression-visibility
- /board/compliance-monitoring
- /board/president
- /board/chair
- /board/vice-chair
- /board/treasurer
- /board/secretary
- /board/safety-director
- /board/community-director
- /board/at-large
- /board/[member] via BoardMemberDashboard gate

## 5) Which routes require role authorization?

All RoleSessionGate and RoleStandaloneView routes above enforce allowedRoles checks, with admin override allowed.

Role model evidence:

- Club roles are enumerated in roleRoutes.
- RoleSessionGate checks allowedRoles and redirects unauthorized sessions.
- Board seat pages pass seat-specific allowedRole into BoardMemberDashboard, which enforces RoleSessionGate.

## 6) Can public users modify backend systems?

Direct answer: not by anonymous browsing.

Evidence:

- Pilot API write routes require requirePrincipal plus requireRole checks.
- Login issues an HTTP-only session cookie.
- Admin bootstrap route requires x-ppbf-bootstrap-key matching PPBF_PILOT_BOOTSTRAP_KEY.

Important architecture nuance:

- In the main SWA push deployment, api_location is empty, so these Next API routes are not deployed via that workflow path.
- Therefore, public users on the deployed static app do not get backend API mutation capability through this SWA pipeline alone.

Security caveat to address later:

- roleSession.ts contains a hardcoded operator PIN for front-end role session creation for non-athlete paths. That is UI/session posture, not equivalent to backend API authorization, but should be replaced with proper server-side identity for production hardening.

## 7) Does current architecture support Public PPBF App and Internal Gym Operations App?

Partially yes.

What exists now:

- Public front door exists at /public.
- Internal role workspaces and governance surfaces exist and many are gated by RoleSessionGate.

What is missing for a clean two-app separation:

- Public and internal are still primarily route partitions inside one app codebase.
- Some internal-adjacent surfaces are not explicitly gated at page level.
- Deployment is not yet split into two independently governed production apps by default push flow.

## 8) Additional work required for white-label gyms, shared backend, and multi-tenant architecture

Required architecture work:

1. Tenant model and identity
- Add tenant entity, gym entity, and membership mapping.
- Replace localStorage role session model with server-side identity and tenant-scoped claims.
- Enforce tenant isolation in all APIs and data reads/writes.

2. Backend service separation
- Move from implicit in-app API assumptions to an explicit deployable backend service layer.
- Define stable API contracts for public app and internal app.
- Add authn/authz middleware with tenant and role guards on every protected endpoint.

3. Data isolation strategy
- Choose per-tenant schema or shared-schema with strict tenant_id partitioning and RLS.
- Add migration framework for tenant-aware tables and indexes.
- Add tenant-scoped audit trails and immutable event logging.

4. Deployment topology
- Split deployments into at least:
  - Public app
  - Internal operations app
  - Shared backend APIs
- Add environment-specific routing and domain strategy per tenant or branded gym.

5. White-label theming and configuration
- Add tenant theme config (branding, copy, feature toggles, legal text).
- Add tenant-aware asset pipeline and runtime config loading.
- Add per-tenant operational settings and governance policy templates.

6. Security and compliance hardening
- Remove hardcoded operator PIN behavior.
- Centralize secrets in managed secret store and remove client-side security shortcuts.
- Add admin boundary tests, tenant breakout tests, and authz regression suites.

7. Operational controls
- Add tenant provisioning workflow.
- Add tenant-level observability dashboards, quotas, and usage metering.
- Add backup/restore and tenant offboarding procedures.

## Verification Outcome

Current architecture is a single primary static front-end deployment with role-oriented route partitioning, partial route gating, and a pilot backend codepath that is not part of the default SWA push deployment artifact.