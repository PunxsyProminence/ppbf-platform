# T-006 — Video publication workflow: compliance-check screen is missing (videos stuck in draft)

> Status: **RESOLVED — see delivery note below (2026-08-07)**
> Lane: A (git-capable AI) or B (chat-only AI) — either
> Priority: P1 operational blocker (publications cannot progress past draft)

## Delivery note (2026-08-07, session B / remote)

Built on PR #238 as PR-238h (see `docs/current/WORK_QUEUE.md`). This
ticket's schema guess and state-machine description were both wrong —
scoping confirmed the real table is `pilot.video_publications` /
`pilot.publication_checks` (not `pilot.film_study_publications` or
`pilot.videos`), the real state is `pending_review` (not
`pending_compliance_review`), and the review-decision workflow
(`recordComplianceCheck` + `updatePublicationStatus`) already existed
via `POST /api/pilot/publications/check` — this ticket's job was the
missing admin console and route wrapper, not new backend logic. No
migration — reuses existing schema.

Also confirmed during scoping: this is genuinely separate from T-003
(admin video **scan-review**, an automated content-scanner quarantine
gate on `pilot.video_sessions` at upload time) rather than a duplicate —
`createPublication` refuses to even create a publication until the
underlying video session is `'ready'`, i.e. this ticket's gate sits
strictly downstream of T-003's.

Two deliberate deviations from this ticket's literal wording:

1. **"Reject" does not move a publication back to `draft`.** It moves to
   the real terminal `rejected` status — matching what
   `check/route.ts` already does for `check_status: 'failed'`. No
   reject-to-draft transition exists anywhere in `publication.ts`, and
   the coach-facing publication flow's own existing copy already tells
   an uploader whose check failed to create a **new** publication once
   the issue is fixed, not resubmit the same one. Building a literal
   bounce-to-draft would be new code contradicting shipped UX.
2. **"Athlete list" is actually a single athlete.**
   `video_publications.athlete_id` is a scalar column, not a join
   table — one publication covers one named athlete. Multi-athlete
   tracking would need new schema, which is both outside this ticket's
   allowed files (no migration listed) and explicitly excluded by its
   own scope ("detailed athlete-level consent verification").

A real gap found and closed in the new route only: neither
`check/route.ts` nor `create/route.ts` writes an audit event today,
despite this being exactly the kind of decision on a minor's footage
the safeguarding rule demands be logged. The new
`api/pilot/admin/video-compliance` route adds `writePilotAuditEvent` on
every decision; the sibling routes are untouched (out of this ticket's
allowed files) but the gap is worth knowing about as a follow-up.

<!-- Everything below this line is the prompt. Paste the whole file into the
     builder AI. It must be able to succeed with no other context. -->

## Context you need

You are building one feature for the PPBF platform: a Next.js 16 (App Router) + PostgreSQL app for a nonprofit youth boxing gym, deployed on Azure Container Apps. TypeScript strict, Tailwind v4, tests in Jest (`*.test.ts(x)` colocated), server logic under `apps/web/src/server/pilot/`, API routes under `apps/web/app/api/pilot/`, pages under `apps/web/app/`.

Non-negotiable conventions:

- Every read/write of organization-owned data is scoped by `organization_id` in the SQL itself.
- Auth: `requireSession` / role checks from `apps/web/src/server/pilot/auth.ts` at the top of every route handler.
- Design system: use classes from `design-system/ppbf.css`.
- Full rules: `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in the repo. Read it.
- **Safeguarding rule (special)**: Videos involve minors. Every step of the publication workflow must track who approved what, when, and why. Compliance checks must be logged.

## The problem

The video publication workflow has a state machine: draft → pending_compliance_review → published. Videos enter the system as drafts, awaiting compliance review before they can be published and visible to the organization.

**The bug**: The compliance-check console is missing. There is no admin screen where someone reviews pending videos for:
- Appropriate content (no accidental footage of off-topic subjects)
- Minors' consent (are all visible athletes covered by appropriate consent/release?)
- Audio/transcript (are there privacy-violating audio fragments?)

Videos are stuck in `pending_compliance_review` state forever because there is no UI to approve or reject them. They never move to published, and the gym never uses the footage.

This is a safeguarding issue: videos are locked in a hidden state with no compliance oversight, and no audit trail of who was supposed to check them or why they were approved.

## Goal

Build an admin console page that:

1. Lists all videos in `pending_compliance_review` status for the organization
2. Shows the video itself (embedded player or thumbnail + metadata)
3. Shows submission metadata (who uploaded, when, title/description, which athletes are in the video)
4. Allows the admin to:
   - **Approve**: move to published state (video becomes visible)
   - **Reject**: move back to draft (builder can fix and re-submit)
   - **Request changes**: send back with a comment explaining what needs to be fixed
5. Logs each decision via audit trail (who, when, what action, any notes)

## In scope

- Query video records from the database (confirm exact schema, likely `pilot.film_study_publications` or `pilot.videos`)
- A page under `apps/web/app/admin/video-compliance/` — org-admin only
- Approve, reject, and request-changes endpoints under `apps/web/app/api/pilot/admin/video-compliance/`
- Video embed or player (can use basic `<video>` tag, no complex player needed)
- Tests covering role gating, listing, approval, rejection, change requests
- Audit logging for each action

## Out of scope

- Comments/discussion between admin and uploader (can be added in a follow-up ticket)
- Bulk compliance (one video at a time is sufficient for MVP)
- Detailed athlete-level consent verification (surface the info so admin can verify manually)

## Files allowed

- `apps/web/app/admin/video-compliance/**` (new)
- `apps/web/app/api/pilot/admin/video-compliance/**` (new)
- One new test file for the console and one for the route handler

## Acceptance criteria

- `npm test` passes; all new tests pass
- `npm run typecheck` passes
- A non-admin role sees `WrongRoleNotice` if they try to access `/admin/video-compliance`
- An admin can see all videos in pending_compliance_review status for their organization
- Each video displays: title, uploader name, upload date, athlete list, description
- An admin can approve a video (verify it moves to published state)
- An admin can reject a video (verify it moves back to draft)
- An admin can request changes (verify it stays in pending with a comment/reason attached)
- All actions are logged in the audit trail with actor, action, timestamp, and any notes

## Delivery

Lane A: branch `ticket/T-006-video-compliance-check-ui` off current `origin/main`, run `npm ci && npm run typecheck && npm run lint && npm test`, push ONCE, open a draft PR.

Lane B: output every file COMPLETE (no elisions), each preceded by its full repo path, plus a MANIFEST.md.
