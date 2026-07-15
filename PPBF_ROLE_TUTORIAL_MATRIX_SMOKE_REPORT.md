# PPBF Role Tutorial Matrix Smoke Report

Date: 2026-07-13
Environment: Production
Base URL: https://purple-bush-04c73e010.7.azurestaticapps.net

## Objective

Role-by-role verification of tutorial discoverability and help anchor behavior after deployment.

## Matrix

| Role | Login Result | Landing Route | HOW THIS WORKS Presence | Help Anchor Target | Outcome |
|---|---|---|---|---|---|
| Admin | PASS | /operations | Present | /help#mission-control-overview and /help#start-here | PASS |
| Coach | PASS | /coach/review-queue | Present | /help#coach-guide | PASS |
| Parent | PASS | /parent/dashboard | Present | /help#parent-guide | PASS |
| Board (President) | Partial | Board Hub route /board verified | Present on Board Hub header | /help#board-guide | PARTIAL (Board seat authenticated landing still needs manual confirm) |
| Athlete | Blocked by credentials | Login accepts Athlete ID field but test login returns Invalid credentials | Not reached in authenticated athlete workspace | N/A | BLOCKED (valid athlete credentials required) |

## Additional Checks

- Public route /public: PASS
  - HOW THIS WORKS visible and routes to /help#public-portal-guide.
- Help Center /help: PASS
  - Master tutorial and role/planned guides visible.
- Mission Control /operations: PASS
  - PPBF MASTER TUTORIAL section and tutorial cards visible.

## Notes

- Role-protected routes enforce boundaries correctly.
- During browser automation, role selection occasionally resets to Athlete on login after sign-in attempts; this affected board-role completion in one session.
- Coach and Parent role workflows still completed successfully and exposed role-specific tutorial links.

## Recommended Final Closure Steps

1. Perform one 60-second manual Board President login check to confirm board seat landing and click HOW THIS WORKS -> /help#board-guide.
2. Provide one valid athlete test credential to complete athlete workspace tutorial-link verification.
