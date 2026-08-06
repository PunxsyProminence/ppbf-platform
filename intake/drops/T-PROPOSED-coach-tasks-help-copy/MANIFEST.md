# T-PROPOSED-coach-tasks-help-copy

**Status:** Lane B proposal (self-found). Convert to T-nnn at gate if accepted.

## FINDING (verified by read on origin/main)

Coach Tasks `HelpPanel` told coaches to "Use the SHADOW tab to act on review-queue items."
The SHADOW Intel tab only renders read-only projection lists + chat; it does not POST
`/api/pilot/intake/review-action`. Approve/reject/promote UI lives on `/admin/shadow`
(admin / platform_owner).

## HOW TO REFUTE

```bash
rg -n "Use the SHADOW tab to act|review-action" apps/web/components/CoachWorkspace.tsx
rg -n "review-action" apps/web/app/admin/shadow/page.tsx
```

## Files

| Path | Kind |
|------|------|
| `apps/web/components/CoachWorkspace.tsx` | REPLACES |
| `intake/drops/T-PROPOSED-coach-tasks-help-copy/MANIFEST.md` | NEW (this file) |

## What this does NOT do

- Does not add coach approve/reject UI
- Does not change `/coach/review-queue` routing
- Does not change APIs, roles, or admin SHADOW console
- Does not touch contested files (workflows, shadowChat, etc.)

## Assumptions

- Admin SHADOW console remains the place case act happens on main
- Help text may still mention "admin SHADOW console" without a deep link (nav product decision left to gatekeeper)

## Behavioral claims

- Tasks help text no longer claims the SHADOW Intel tab can act on queue items — **UNVERIFIED — needs CI/gate confirmation**
- Empty-board / load-failure guidance is clearer — **UNVERIFIED — needs CI/gate confirmation**
