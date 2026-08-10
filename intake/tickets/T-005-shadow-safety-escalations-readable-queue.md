# T-005 — SHADOW safety escalations: admin queue is unreadable (no visibility into who reported what)

> Status: **RESOLVED — see reconciliation note below (2026-08-06)**
> Lane: A (git-capable AI) or B (chat-only AI) — either
> Priority: P1 safeguarding blocker (critical reports hidden from admin)

## Reconciliation note (2026-08-06, session B / remote, collision rule 5)

This gap is real against `origin/main` as of the commit that added this
ticket (`e3cfd30`) — `pilot.safety_escalations` and its admin queue did
not exist there. They already exist, built and adversarially reviewed,
on **PR #238** (branch `claude/remaining-capabilities-ab0q7d`), as
capability #194 "Red Flag Escalation Ladder" — built and reviewed
*before* this ticket was written, so this is not new work responding to
the ticket; the ticket independently found a real gap this PR already
closes. Per collision rule 5 ("if you find the other session already did
it, stop and reconcile rather than finishing yours"), no duplicate
`/admin/safety-escalations` page was built. Evidence, mapped against this
ticket's acceptance criteria:

| Ticket asks for | Delivered in PR #238 |
|---|---|
| Query `pilot.safety_escalations` | Table + `escalationLadder.ts` (schema, transitions) |
| Page under `admin/safety-escalations/**`, org-admin only | `apps/web/app/admin/escalations/page.tsx` (different path — `escalations`, not `safety-escalations`), gated `RoleSessionGate allowedRoles={['admin','coach']}` — **broader than the ticket asked**: a coach also sees their own athletes' escalations (scoped server-side), not just org admin. If the exact `/admin/safety-escalations` URL matters for an external link or bookmark, that is a small follow-up (route alias), not a rebuild. |
| Athlete, severity, reporter, date, status, concern text | All rendered — `listEscalations()` returns `athlete_id, severity, reason, triggered_by_role, created_at, status` |
| Mark acknowledged / resolved | `POST /api/pilot/escalations` (`action: 'acknowledge' \| 'resolve'`) → `acknowledgeEscalation()` / `resolveEscalation()`, guarded so an already-resolved record can't be silently reopened (status predicate on the UPDATE itself) |
| Audit trail of who acted, when | `acknowledged_by_account_id`/`acknowledged_at` and `resolved_by_account_id`/`resolved_at`/`resolution_note` are first-class columns on the row itself (not a separate `pilot.audit_events` entry) — visible directly on the admin page. Functionally equivalent to the ticket's ask; a different mechanism, not a gap. |
| Filtering by severity/date/status | `listEscalations` orders critical-first then newest; `status` filter on both the route and the page |
| Tests: role gating, listing, status transitions | `escalationLadder.test.ts`, `escalationLadder.pg.test.ts` (19 real-Postgres tests), `app/api/pilot/escalations/route.test.ts` |

Not yet built, and correctly out of scope per this ticket: two-way
messaging, automatic coach notifications, embedded athlete profile view.

If PR #238 has not merged by the time this ticket is picked up again,
treat this note as the pointer and pull from that branch rather than
rebuilding — the design (a pull-based queue, since the platform sends no
email/notifications, ever) and the safeguarding invariants (board sees
only a k-anonymity-gated count, never rows) are already reasoned through
in that PR's commit history and worth reusing rather than re-deriving.

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
