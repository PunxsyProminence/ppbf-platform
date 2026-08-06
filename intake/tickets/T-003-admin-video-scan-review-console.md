# T-003 — Admin console for the quarantined-video review escalation

> Status: READY
> Lane: A (git-capable AI) or B (chat-only AI) — either
> Priority: P0 safety — a safeguarding decision path exists with no way to use it

<!-- Everything below this line is the prompt. Paste the whole file into the
     builder AI. It must be able to succeed with no other context. -->

## Context you need

You are building one feature for the PPBF platform: a Next.js 16 (App
Router) + PostgreSQL app for a nonprofit youth boxing gym, deployed on Azure
Container Apps. TypeScript strict, Tailwind v4, tests in Jest, server logic
under `apps/web/src/server/pilot/`, API routes under
`apps/web/app/api/pilot/`, pages under `apps/web/app/`.

Non-negotiable conventions:

- Every read/write of organization-owned data is scoped by
  `organization_id` in the SQL itself.
- Auth: role checks from `apps/web/src/server/pilot/auth.ts` /
  `src/server/pilot/access.ts` at the top of every route handler.
- Design system: use classes from `design-system/ppbf.css`. No new hex
  values, no new fonts.
- **This ticket touches footage of minors.** Read
  `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in full before writing a line, not
  just this ticket. The safety invariants section is not optional context.

## Verified problem

`apps/web/app/api/pilot/video/scan-review/route.ts` is a real, well-built
route: organization-admin-only, requires a human to open the clip
(`review-link`) and record an explicit `approve`/`block` decision, and its
own header comment explains why the coach who filmed the footage is
deliberately excluded from this decision (a content screen declining
footage of a minor is not something the filmer gets to overturn).

I verified directly — not from a doc claim — that **no `.tsx` file anywhere
in the app calls this route**:
`grep -rn "scan-review" apps/web/app --include="*.tsx"` returns nothing.
The route's own comment says a quarantined video's refusal message tells
the coach to "ask an administrator to review it," and that no such surface
existed when it was written. It still doesn't. An admin who wants to act on
that message today has to hand-craft an HTTP POST.

## Goal

An organization admin can see the queue of quarantined videos awaiting
their review, open each one (via the existing `review-link` route) to
watch it, and record `approve` or `block` through a UI — using the existing
`scan-review` route as-is. This ticket is UI only.

## In scope

- A page, likely `apps/web/app/admin/video-review/` (pick the path that
  fits existing admin route conventions — look at `apps/web/app/admin/`
  for the pattern), org-admin only.
- Lists videos with a quarantined/pending-review status (find the query
  this needs by reading `videoScanReview.ts` / `videoSessions.ts` — do not
  invent a new query if one close to this already exists).
- For each: a way to get the `review-link` URL and open it, then submit
  `approve` or `block` via `scan-review`.
- Show the outcome (what changes for `approve` vs `block`, per the route's
  own comment: approve sets status='ready'; block leaves it quarantined —
  nothing widens as a result of a block).

## Out of scope

- Do NOT touch `scan-review/route.ts`, `videoScanReview.ts`, or
  `review-link/route.ts` themselves. They work; build against them.
- Do NOT give the coach who filmed footage any path into this decision.
  `VIDEO_REVIEW_DECIDE_ROLES` in `videoScanReview.ts` defines who may
  decide — do not add to it.
- Do NOT change what `approve`/`block` do server-side.

## Files allowed

- `apps/web/app/admin/video-review/**` (new)
- One new test file for the new page

## Acceptance criteria

- `npm test -- --runTestsByPath apps/web/app/admin/video-review/page.test.tsx`
  passes.
- A non-admin role sees the same `WrongRoleNotice` pattern used elsewhere
  under `admin/` — do not build a bespoke gate.
- The page calls the real `scan-review` route with `approve` and with
  `block` and both are exercised in tests (mocked network layer is fine;
  state clearly in your PR if you could not test against a live DB).

## Delivery

Lane A: branch `ticket/T-003-video-scan-review-console` off current
`origin/main`, run `npm ci && npm run typecheck && npm run lint && npm test`,
push ONCE, open a draft PR with the repo's PR template, fill Evidence with
real command output. You cannot push to a branch twice — revisions are a
new `-v2` branch and PR.

Lane B: output every file COMPLETE (no elisions), each preceded by its full
repo path, plus a MANIFEST.md: ticket id, file list (new vs replaces), what
was not done, assumptions made. The human will place your output in
`intake/drops/T-003/`.
