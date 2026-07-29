# Auth Refactor Report

## Current Trust Boundary

The current application mixes server-backed login for athletes with client-side role storage for all role routing and access control.

Observed browser-side sources of authority:

- [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts)
- [apps/web/components/RoleSessionGate.tsx](apps/web/components/RoleSessionGate.tsx)
- [apps/web/app/page.tsx](apps/web/app/page.tsx)
- [apps/web/app/dashboard/page.tsx](apps/web/app/dashboard/page.tsx)
- [apps/web/app/shadow/page.tsx](apps/web/app/shadow/page.tsx)
- [apps/web/components/GlobalRoleHeader.tsx](apps/web/components/GlobalRoleHeader.tsx)

Observed server-backed auth entry points:

- [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts)
- [apps/web/app/api/pilot/auth/session/route.ts](apps/web/app/api/pilot/auth/session/route.ts)
- [apps/web/app/api/pilot/auth/logout/route.ts](apps/web/app/api/pilot/auth/logout/route.ts)
- [apps/web/src/server/pilot/auth.ts](apps/web/src/server/pilot/auth.ts)

## Required Refactor Direction

1. Move auth state authority to the backend session cookie.
2. Use the session endpoint as the source for role and tenant context.
3. Treat frontend role checks as visibility and navigation hints only.
4. Remove any security-sensitive dependence on localStorage values.

## Files That Carry the Current Risk

- [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts)
  - Stores the role session and a duplicate role value in localStorage.
- [apps/web/components/RoleSessionGate.tsx](apps/web/components/RoleSessionGate.tsx)
  - Redirects based on browser session state.
- [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx)
  - Mixes cookie-backed athlete auth with browser-created role sessions.
- [apps/web/components/GlobalRoleHeader.tsx](apps/web/components/GlobalRoleHeader.tsx)
  - Logs out by posting to the backend, then clears browser state.
- [apps/web/app/page.tsx](apps/web/app/page.tsx)
- [apps/web/app/dashboard/page.tsx](apps/web/app/dashboard/page.tsx)
- [apps/web/app/shadow/page.tsx](apps/web/app/shadow/page.tsx)
- [apps/web/components/RoleStandaloneView.tsx](apps/web/components/RoleStandaloneView.tsx)
- [apps/web/components/BoardMemberDashboard.tsx](apps/web/components/BoardMemberDashboard.tsx)

## Target Shape

Backend auth
-> session validation
-> server role verification
-> frontend render logic

In that shape, the frontend can still:

- show or hide buttons
- route users after login
- display the active role

But it should not:

- create authorization state from browser storage
- decide role membership from localStorage
- treat client-side role data as a security boundary

## Login / Logout Implication

- Login should return authoritative principal data only after server validation.
- Logout should revoke the server session first, then clear any client UI state.
- Any redirect logic should be derived from the session endpoint, not localStorage.

## Client-Only Page Protections

The following surfaces currently depend on browser-side role state and should be reworked to read server session context:

- [apps/web/app/admin/page.tsx](apps/web/app/admin/page.tsx)
- [apps/web/app/admin/compliance-center/page.tsx](apps/web/app/admin/compliance-center/page.tsx)
- [apps/web/app/board/compliance-monitoring/page.tsx](apps/web/app/board/compliance-monitoring/page.tsx)
- [apps/web/app/operations/page.tsx](apps/web/app/operations/page.tsx)
- [apps/web/app/athlete/dashboard/page.tsx](apps/web/app/athlete/dashboard/page.tsx)
- [apps/web/app/athlete/progression-intelligence/page.tsx](apps/web/app/athlete/progression-intelligence/page.tsx)
- [apps/web/app/athlete/video-analysis/page.tsx](apps/web/app/athlete/video-analysis/page.tsx)
- [apps/web/app/coach/environment/intake-router/page.tsx](apps/web/app/coach/environment/intake-router/page.tsx)
- [apps/web/app/coach/progression-intelligence/page.tsx](apps/web/app/coach/progression-intelligence/page.tsx)
- [apps/web/app/coach/review-queue/page.tsx](apps/web/app/coach/review-queue/page.tsx)
- [apps/web/app/coach/video-analysis/page.tsx](apps/web/app/coach/video-analysis/page.tsx)
- [apps/web/app/parent/dashboard/page.tsx](apps/web/app/parent/dashboard/page.tsx)
- [apps/web/app/parent/progression-visibility/page.tsx](apps/web/app/parent/progression-visibility/page.tsx)
- [apps/web/app/admin/shadow/page.tsx](apps/web/app/admin/shadow/page.tsx)

## Outcome

The browser storage model is functional for navigation, but it is not a production authorization boundary. The refactor needs to move trust to the backend before any tenant enforcement work is considered complete.
