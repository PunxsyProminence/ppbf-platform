# T-004 — Portrait review queue: photos stuck in pending_review with no exit UI

> Status: BACKLOG
> Lane: A (git-capable AI) or B (chat-only AI) — either
> Priority: P2 operational blocker (UI missing, photos invisible forever)

<!-- Everything below this line is the prompt. Paste the whole file into the
     builder AI. It must be able to succeed with no other context. -->

## Context you need

You are building one feature for the PPBF platform: a Next.js 16 (App Router) + PostgreSQL app for a nonprofit youth boxing gym, deployed on Azure Container Apps. TypeScript strict, Tailwind v4, tests in Jest (`*.test.ts(x)` colocated), server logic under `apps/web/src/server/pilot/`, API routes under `apps/web/app/api/pilot/`, pages under `apps/web/app/`.

Non-negotiable conventions:

- Every read/write of organization-owned data is scoped by `organization_id` in the SQL itself.
- Auth: `requireSession` / role checks from `apps/web/src/server/pilot/auth.ts` at the top of every route handler.
- Design system: use classes from `design-system/ppbf.css` (`.btn`, `.badge--filed`, `.frame`, `.stat`, `t-*` type classes, `--s*` spacing vars).
- Full rules: `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in the repo. Read it.

## The problem

The portrait review queue creates records with `status = 'pending_review'` when coaches upload athlete photographs. These records are invisible to any admin UI — there is no screen that shows pending portraits, no way to approve them, and no way to reject/delete them. Photos are stuck in the review state forever, unable to be published.

This is a safeguarding issue: minors' photographs are locked in an invisible queue with no admin oversight. The system promised a review step but never gave operators the console to do that review.

## Goal

Build a minimal admin console page that:
1. Lists all portraits in `pending_review` status within the organization
2. Shows enough context (athlete name, upload date, thumbnail preview if safe to show)
3. Allows the admin to approve (move to published/visible) or reject (delete the record)
4. Logs the action (who approved/rejected, when) via the audit trail

## In scope

- Query portrait records from the database (exact schema location: confirm in codebase, likely `pilot.athlete_portraits` or similar)
- A page under `apps/web/app/admin/portrait-review/` — org-admin only
- Approval and rejection endpoints under `apps/web/app/api/pilot/admin/portrait-review/`
- Tests covering role gating (non-admin sees `WrongRoleNotice`), listing, approval, rejection
- Audit event logging for each action

## Out of scope

- Editing portraits (crops, captions, etc.)
- Bulk operations (approve all at once) — one at a time is fine for MVP
- Email notifications to coaches on approval/rejection (can be added later)

## Files allowed

- `apps/web/app/admin/portrait-review/**` (new)
- `apps/web/app/api/pilot/admin/portrait-review/**` (new)
- One new test file for the console and one for the route handler

## Acceptance criteria

- `npm test` passes; all new tests pass
- `npm run typecheck` passes
- A non-admin role (athlete, coach, parent) sees `WrongRoleNotice` if they try to access `/admin/portrait-review`
- An admin can see a list of portraits in pending_review status
- An admin can approve a portrait (verify it moves to published/visible state)
- An admin can reject a portrait (verify it is deleted and no longer appears in the queue)

## Delivery

Lane A: branch `ticket/T-004-portrait-review-exit-ui` off current `origin/main`, run `npm ci && npm run typecheck && npm run lint && npm test`, push ONCE, open a draft PR with the repo's PR template.

Lane B: output every file COMPLETE (no elisions), each preceded by its full repo path, plus a MANIFEST.md: ticket id, file list (new vs replaces), what was not done, assumptions made.
