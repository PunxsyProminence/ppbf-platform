# PPBF Pre-Deploy Visual Smoke Report

Mode: Audit only (no code changes)
Date: 2026-07-13
Target: Local app at http://localhost:3000

## Summary

- Route load check completed for all requested routes.
- 1 of 8 routes rendered full capability content directly.
- 7 of 8 routes were protected by session/role gating and redirected to access-check/login surfaces.
- No console or runtime page errors were observed during this smoke pass.
- No broken import indicators were observed.
- No missing component indicators were observed.

## Route Results

| Route | 1. Route Loads | 2. No Console Errors | 3. No Broken Imports | 4. No Missing Components | 5. Status Labels Visible | 6. Placeholder Indicators Visible | 7. Navigation Path Confirmed | Notes |
|---|---|---|---|---|---|---|---|---|
| /coach/video-analysis | PASS (HTTP 200) | PASS | PASS | PASS | BLOCKED BY ACCESS GATE | BLOCKED BY ACCESS GATE | BLOCKED BY ACCESS GATE | Rendered "Secure Session / Checking access" surface; target page content not reachable without role session. |
| /athlete/video-analysis | PASS (HTTP 200) | PASS | PASS | PASS | BLOCKED BY ACCESS GATE | BLOCKED BY ACCESS GATE | BLOCKED BY ACCESS GATE | Rendered "Secure Session / Checking access" surface; target page content not reachable without role session. |
| /board/compliance-monitoring | PASS (HTTP 200) | PASS | PASS | PASS | BLOCKED BY LOGIN | BLOCKED BY LOGIN | BLOCKED BY LOGIN | Redirected to login surface (The Bell). |
| /admin/compliance-center | PASS (HTTP 200) | PASS | PASS | PASS | BLOCKED BY LOGIN | BLOCKED BY LOGIN | BLOCKED BY LOGIN | Redirected to login surface (The Bell). |
| /coach/progression-intelligence | PASS (HTTP 200) | PASS | PASS | PASS | BLOCKED BY LOGIN | BLOCKED BY LOGIN | BLOCKED BY LOGIN | Redirected to login surface (The Bell). |
| /athlete/progression-intelligence | PASS (HTTP 200) | PASS | PASS | PASS | BLOCKED BY ACCESS GATE | BLOCKED BY ACCESS GATE | BLOCKED BY ACCESS GATE | Rendered "Secure Session / Checking access" surface; target page content not reachable without role session. |
| /parent/progression-visibility | PASS (HTTP 200) | PASS | PASS | PASS | BLOCKED BY LOGIN | BLOCKED BY LOGIN | BLOCKED BY LOGIN | Redirected to login surface (The Bell). |
| /source-control/publication-workflow | PASS (HTTP 200) | PASS | PASS | PASS | PASS | PASS | PASS | Full target page rendered, including required labels and placeholder cards. |

## Evidence Highlights

- Publication Workflow page shows required status language:
  - PLANNED
  - FRONT-END PLACEHOLDER
  - BACKEND REQUIRED
  - HUMAN REVIEW REQUIRED
  - NOT YET AUTOMATED
- Publication Workflow page shows placeholder registry cards and quick links (including Source control, Audit trace, Admin compliance center, Operations Hub).
- Protected routes consistently render access control UI instead of target capability content.

## Audit Conclusion

- Front-end route availability: PASS (all requested routes resolve).
- Visual verification depth: PARTIAL due to access control gating on 7 routes.
- Fully verified capability surface in this pass: /source-control/publication-workflow.

## No-Change Confirmation

- No code edits were made in this visual smoke test pass.
- Report artifact only: PPBF_PRE_DEPLOY_VISUAL_SMOKE_REPORT.md
