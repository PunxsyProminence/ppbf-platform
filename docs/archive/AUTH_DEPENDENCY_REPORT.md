# Auth Dependency Report

This report lists the repository files that participate in login, logout, role validation, local storage, and browser-side route protection.

## Login Path

- [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx)
  - Reads the session on load, calls the auth endpoints, writes announcement state to localStorage, and routes after login.
- [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts)
  - Creates, reads, caches, and clears the client-side role session.
- [apps/web/app/api/pilot/auth/login/route.ts](apps/web/app/api/pilot/auth/login/route.ts)
  - Server login endpoint for account_id + pin.
- [apps/web/app/api/pilot/auth/session/route.ts](apps/web/app/api/pilot/auth/session/route.ts)
  - Session check endpoint used by the login page.
- [apps/web/app/page.tsx](apps/web/app/page.tsx)
  - Redirects to the active role route or `/login`.
- [apps/web/app/dashboard/page.tsx](apps/web/app/dashboard/page.tsx)
  - Redirects using the stored role session.

## Logout Path

- [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx)
  - Clears the client session and posts to logout when `logout=true` or `reset=true` is present.
- [apps/web/components/GlobalRoleHeader.tsx](apps/web/components/GlobalRoleHeader.tsx)
  - Posts to logout from the global header.
- [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts)
  - Clears the stored role session and emits the session-change event.
- [apps/web/app/api/pilot/auth/logout/route.ts](apps/web/app/api/pilot/auth/logout/route.ts)
  - Server logout endpoint that revokes the token and clears the cookie.
- [apps/web/app/shadow/page.tsx](apps/web/app/shadow/page.tsx)
  - Local sign-out action clears the browser session.

## Role Validation

- [apps/web/components/RoleSessionGate.tsx](apps/web/components/RoleSessionGate.tsx)
  - Enforces allowed roles from the browser session snapshot.
- [apps/web/components/RoleStandaloneView.tsx](apps/web/components/RoleStandaloneView.tsx)
  - Wraps role-specific pages in the gate and derives tutorial anchors.
- [apps/web/components/BoardMemberDashboard.tsx](apps/web/components/BoardMemberDashboard.tsx)
  - Protects board seat workspaces with the gate.
- [apps/web/app/admin/page.tsx](apps/web/app/admin/page.tsx)
  - Protects the admin surface with the gate.
- [apps/web/app/admin/compliance-center/page.tsx](apps/web/app/admin/compliance-center/page.tsx)
  - Protects the admin compliance surface with the gate.
- [apps/web/app/board/compliance-monitoring/page.tsx](apps/web/app/board/compliance-monitoring/page.tsx)
  - Protects the board compliance surface with the gate.
- [apps/web/app/operations/page.tsx](apps/web/app/operations/page.tsx)
  - Protects Mission Control with the gate.
- [apps/web/app/athlete/dashboard/page.tsx](apps/web/app/athlete/dashboard/page.tsx)
- [apps/web/app/athlete/progression-intelligence/page.tsx](apps/web/app/athlete/progression-intelligence/page.tsx)
- [apps/web/app/athlete/video-analysis/page.tsx](apps/web/app/athlete/video-analysis/page.tsx)
- [apps/web/app/coach/environment/intake-router/page.tsx](apps/web/app/coach/environment/intake-router/page.tsx)
- [apps/web/app/coach/progression-intelligence/page.tsx](apps/web/app/coach/progression-intelligence/page.tsx)
- [apps/web/app/coach/review-queue/page.tsx](apps/web/app/coach/review-queue/page.tsx)
- [apps/web/app/coach/video-analysis/page.tsx](apps/web/app/coach/video-analysis/page.tsx)
- [apps/web/app/parent/dashboard/page.tsx](apps/web/app/parent/dashboard/page.tsx)
- [apps/web/app/parent/progression-visibility/page.tsx](apps/web/app/parent/progression-visibility/page.tsx)
  - These routes are protected through the role workspace wrapper, which is still browser-side.

## Local Storage Dependencies

- [apps/web/components/roleSession.ts](apps/web/components/roleSession.ts)
  - `ROLE_SESSION_KEY` and `ppbf-club-role`.
- [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx)
  - `ppbf-login-announcement`.
- [apps/web/app/admin/page.tsx](apps/web/app/admin/page.tsx)
  - `ppbf-admin-capabilities-v1`.
- [apps/web/components/AthleteWorkspace.tsx](apps/web/components/AthleteWorkspace.tsx)
  - Athlete floor-plan storage.
- [apps/web/components/CoachWorkspace.tsx](apps/web/components/CoachWorkspace.tsx)
  - Reads the athlete floor-plan storage key.
- [apps/web/components/trackAssignments.ts](apps/web/components/trackAssignments.ts)
  - Track assignment and active athlete profile storage.
- [apps/web/e2e/board-governance.spec.ts](apps/web/e2e/board-governance.spec.ts)
  - Seeds the role session in browser storage for tests.

## API References

- [apps/web/app/login/page.tsx](apps/web/app/login/page.tsx)
  - `/api/pilot/auth/login`
  - `/api/pilot/auth/session`
  - `/api/pilot/auth/logout`
- [apps/web/components/GlobalRoleHeader.tsx](apps/web/components/GlobalRoleHeader.tsx)
  - `/api/pilot/auth/logout`

## Client-Side Only Protection

The following routes are currently protected by browser state and client redirects, not by a visible server-side route guard in the app shell:

- [apps/web/app/page.tsx](apps/web/app/page.tsx)
- [apps/web/app/dashboard/page.tsx](apps/web/app/dashboard/page.tsx)
- [apps/web/app/shadow/page.tsx](apps/web/app/shadow/page.tsx)
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

## Summary

The current auth dependency chain is browser-first for role state and server-first for athlete login. That split is the main architectural mismatch the production auth work needs to resolve.