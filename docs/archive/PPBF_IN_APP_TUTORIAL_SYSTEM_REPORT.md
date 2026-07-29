# PPBF In-App Tutorial System Report

## 1. Files Changed

- apps/web/app/help/page.tsx (new)
- apps/web/components/helpContent.ts (new)
- apps/web/components/TutorialButton.tsx (new)
- apps/web/components/TutorialCard.tsx (new)
- apps/web/components/RoleStandaloneView.tsx
- apps/web/components/FeatureSurface.tsx
- apps/web/app/operations/page.tsx
- apps/web/app/admin/page.tsx
- apps/web/components/RevenueFundingCenter.tsx
- apps/web/app/board/page.tsx
- apps/web/components/BoardMemberDashboard.tsx
- apps/web/app/public/page.tsx
- apps/web/app/shadow/page.tsx
- apps/web/app/board/compliance-monitoring/page.tsx
- apps/web/app/admin/compliance-center/page.tsx

## 2. Tutorial Routes Added

- /help (Help Center)

## 3. Tutorial Buttons Added

Added a consistent HOW THIS WORKS entry pattern using shared TutorialButton and contextual anchors to /help sections.

Buttons are now present through direct placement and/or shared shell coverage in:

- Mission Control / The Ring (/operations)
- Admin Hub (/admin)
- Revenue & Funding Center (admin revenue tab via RevenueFundingCenter component)
- Athlete workspace routes using RoleStandaloneView
- Coach workspace routes using RoleStandaloneView
- Parent workspace routes using RoleStandaloneView
- Board Hub (/board)
- Board seat workspaces (BoardMemberDashboard)
- Public Portal (/public)
- SHADOW (/shadow)
- Compliance monitoring placeholders:
  - /board/compliance-monitoring
  - /admin/compliance-center
- Development Lab and Source Control family via shared FeatureSurface wrapper, including:
  - /research
  - /evidence
  - /knowledge-graph
  - /simulator
  - /audit
  - /source-control
  - /source-control/publication-workflow

Because RoleStandaloneView now renders a consistent help button, planned capability pages using that shell also inherit HOW THIS WORKS access:

- /coach/video-analysis
- /athlete/video-analysis
- /coach/progression-intelligence
- /athlete/progression-intelligence
- /parent/progression-visibility

## 4. Workspaces Updated

- Mission Control / The Ring
- Athlete Workspace
- Coach Workspace
- Parent Hub
- Board Workspace (hub + seat workspaces)
- Admin Hub
- Revenue & Funding Center
- Development Lab routes
- Source Control
- SHADOW
- Public Portal
- Planned capability placeholder routes (video analysis, compliance, progression, publication workflow)

## 5. Master Tutorial Location

Primary master tutorial entry points:

- Mission Control: /operations (prominent PPBF MASTER TUTORIAL section)
- Admin Hub: /admin (overview tab includes PPBF MASTER TUTORIAL section)
- Full guide hub: /help

## 6. Role Guides Added

Centralized role/workspace guides added in /help with required tutorial structure:

- Start Here
- Mission Control Overview
- Athlete Guide
- Coach Guide
- Parent Guide
- Board Guide
- Admin Guide
- Revenue Guide
- Development Lab Guide
- SHADOW Guide
- Public Portal Guide
- Tester Guide

Each guide includes:

1) What this area is for
2) Who should use it
3) What is active now
4) What is placeholder/planned
5) What not to test yet
6) What feedback is useful
7) Where to go next

## 7. Planned Capability Guide Added

Added in /help under Planned Capability Guide, including:

- AI/ML Video Analysis
- Automated Compliance Monitoring
- Closed-Loop Progression Intelligence
- Automated Publication Workflow

Each includes:

- Current status
- Where it appears
- What is planned
- What is not automated
- Backend dependency
- Human review requirement

## 8. Known Placeholder Limitations

The tutorial system intentionally labels non-live systems and does not claim automation where none exists:

- AI/ML video analysis: planned/placeholder only
- Automated compliance monitoring: planned/placeholder only
- Closed-loop progression intelligence automation: planned/placeholder only
- Automated publication workflow: planned/placeholder only
- Revenue payment processors and payment execution: not connected
- No backend APIs/auth/payment/AI were added or modified in this pass

## 9. Lint Result

Command:

- npm --prefix apps/web run lint

Result:

- Pass (no lint errors reported)

## 10. Build Result

Command:

- npm --prefix apps/web run build

Result:

- Pass
- Next.js build completed successfully
- /help route generated and included in static route output
