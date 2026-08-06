# T-005 — SHADOW safety escalations: admin queue is unreadable (no visibility into who reported what)

> Status: BACKLOG
> Lane: A (git-capable AI) or B (chat-only AI) — either
> Priority: P1 safeguarding blocker (critical reports hidden from admin)

<!-- Everything below this line is the prompt. Paste the whole file into the
     builder AI. It must be able to succeed with no other context. -->

## Context you need

You are building one feature for the PPBF platform: a Next.js 16 (App Router) + PostgreSQL app for a nonprofit youth boxing gym, deployed on Azure Container Apps. TypeScript strict, Tailwind v4, tests in Jest (`*.test.ts(x)` colocated), server logic under `apps/web/src/server/pilot/`, API routes under `apps/web/app/api/pilot/`, pages under `apps/web/app/`.

Non-negotiable conventions:

- Every read/write of organization-owned data is scoped by `organization_id` in the SQL itself.
- Auth: `requireSession` / role checks from `apps/web/src/server/pilot/auth.ts` at the top of every route handler.
- Design system: use classes from `design-system/ppbf.css`.
- Full rules: `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in the repo. Read it.
- **Safeguarding rule (special)**: When showing data about minors, always ask "who is the actor seeing this, and are they entitled to see it?" A parent should see only their own child's reports, an admin should see only their org's, etc.

## The problem

The SHADOW system (Safety, Harm, And Disclosure of Wellbeing) collects reports from coaches and staff about athlete safety concerns. Critical-severity reports are written to a queue that should be surfaced to the organization admin immediately.

**The bug**: Admin console shows that critical reports exist (they're in the database), but the queue is unreadable — the admin cannot see:
- Which athlete the report was about
- What severity level was reported
- Who submitted the report (coach name, role)
- When the report was submitted
- What the actual concern was

The queue is functionally invisible: the admin knows reports exist but cannot read them or act on them. This defeats the entire purpose of the safety escalation system.

## Goal

Build an admin console page that surfaces all unresolved safety escalation reports in the organization, readable by org admin only, showing:

1. The athlete involved (name, relevant context like current coach)
2. Severity level (critical, high, medium, low) with visual indicator
3. The reporter (name, role — e.g., "Coach Alice" or "Staff Bob")
4. Report date and time
5. The text of the concern itself
6. Status (open, acknowledged, resolved)
7. Ability to mark as acknowledged or resolved (changing status)
8. Audit trail showing who acknowledged/resolved it and when

## In scope

- Query safety escalation records (confirm exact schema: likely `pilot.safety_escalations` or `pilot.shadow_escalations`)
- A page under `apps/web/app/admin/safety-escalations/` — org-admin only
- Filtering/sorting by severity, date, status
- An endpoint to mark reports as acknowledged or resolved
- Audit logging of admin actions
- Tests covering role gating, listing, status updates

## Out of scope

- Two-way messaging between admin and reporter (can be added later)
- Automatic notifications to coaches (can be added later)
- Detailed athlete profile viewing from this console (link out, don't embed)

## Files allowed

- `apps/web/app/admin/safety-escalations/**` (new)
- `apps/web/app/api/pilot/admin/safety-escalations/**` (new)
- One new test file for the console and one for the route handler

## Acceptance criteria

- `npm test` passes; all new tests pass
- `npm run typecheck` passes
- A non-admin role sees `WrongRoleNotice` if they try to access `/admin/safety-escalations`
- An admin can see all safety escalation reports for their organization
- An admin can see severity, reporter name/role, athlete name, report text, and date
- An admin can mark a report as acknowledged
- An admin can mark a report as resolved
- Status changes are logged in the audit trail

## Delivery

Lane A: branch `ticket/T-005-shadow-safety-escalations-readable` off current `origin/main`, run `npm ci && npm run typecheck && npm run lint && npm test`, push ONCE, open a draft PR.

Lane B: output every file COMPLETE (no elisions), each preceded by its full repo path, plus a MANIFEST.md.
