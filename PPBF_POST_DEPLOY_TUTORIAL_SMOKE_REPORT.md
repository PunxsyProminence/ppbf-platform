# PPBF Post-Deploy Tutorial Smoke Report

Date: 2026-07-13
Environment: Production (Azure Static Web App)
Base URL: https://purple-bush-04c73e010.7.azurestaticapps.net

## Scope

Quick post-deploy visual/tutorial discoverability check for:

- Public Portal tutorial links
- Help Center route and content
- Mission Control master tutorial visibility
- Role-gated placeholder route behavior

## Pass/Block Matrix

1. /public
- Result: PASS
- Notes: "HOW THIS WORKS" and "Tester Guide" links are visible.

2. /public -> HOW THIS WORKS
- Result: PASS
- Target URL: /help#public-portal-guide
- Notes: Help Center loaded with PPBF MASTER TUTORIAL and role/feature guides.

3. /help
- Result: PASS
- Notes: Master Tutorial Cards rendered; guide sections visible (including planned capabilities).

4. /login (Admin role + PIN)
- Result: PASS
- Notes: Admin sign-in routes to Mission Control.

5. /operations
- Result: PASS
- Notes: Mission Control shows:
  - HOW THIS WORKS button
  - PPBF MASTER TUTORIAL section
  - Master tutorial cards with Open Tutorial links

6. /coach/video-analysis (without active coach session)
- Result: PASS (Expected Guard)
- Notes: Redirects to login/checking access. Role gate behavior is correct.

7. /board/compliance-monitoring (without active board session)
- Result: PASS (Expected Guard)
- Notes: Checking access then login. Role gate behavior is correct.

## Observations

- Tutorial discoverability is working in production for public and mission-control entry points.
- Help Center route is live and populated with centralized tutorial content.
- Role-protected routes enforce access as expected in unauthenticated/non-matching sessions.

## Known Limitations During Smoke

- Session state can reset while manually navigating between protected routes during browser automation; this can return to login even after a successful prior sign-in.
- This smoke pass did not complete deep role-by-role walkthroughs for every protected workspace due role-session gating in a single automated session.

## Conclusion

Primary tutorial objectives are verified in production:

- Built-in help is reachable from public and mission-control surfaces.
- Master tutorial content is visible and navigable.
- Guarded routes maintain role boundary behavior.
