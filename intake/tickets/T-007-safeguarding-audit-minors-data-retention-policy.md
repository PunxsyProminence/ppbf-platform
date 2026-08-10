# T-007 — Safeguarding audit: minors' data retention policy and deletion capability

> Status: BACKLOG
> Lane: A (git-capable AI) or B (chat-capable AI)
> Priority: P1 compliance (legal + safeguarding)

<!-- Everything below this line is the prompt. Paste the whole file into the
     builder AI. It must be able to succeed with no other context. -->

## Context you need

You are building one feature for the PPBF platform: a Next.js 16 (App Router) + PostgreSQL app for a nonprofit youth boxing gym, deployed on Azure Container Apps. TypeScript strict, Tailwind v4, tests in Jest (`*.test.ts(x)` colocated), server logic under `apps/web/src/server/pilot/`, API routes under `apps/web/app/api/pilot/`, pages under `apps/web/app/`.

Non-negotiable conventions:

- Every read/write of organization-owned data is scoped by `organization_id` in the SQL itself.
- Auth: `requireSession` / role checks from `apps/web/src/server/pilot/auth.ts` at the top of every route handler.
- Full rules: `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in the repo. Read it.
- **Safeguarding rule (critical)**: Minors' data (photographs, videos, personal records, family contact info) must not be retained indefinitely. Any data about a minor must have:
  1. A reason for retention (why is it kept?)
  2. A retention period (how long?)
  3. A deletion mechanism (how does it get removed?)
  4. An audit trail (who deleted it, when, what was deleted)

## The problem

The safeguarding audit identified that the platform collects and stores minors' personal data (photographs, video footage, behavior records, family contact information) but has no documented retention policy and no deletion capability.

**What's missing:**
- Written data retention policy stating how long each type of data is kept and why
- Admin UI for guardian/parent account deletion (wipe all their data when they leave)
- Admin UI for athlete record deletion (if an athlete withdraws, their photos/videos/records should be removed)
- Deletion cascade logic (when a guardian account is deleted, their linked athlete records are also deleted)
- Audit trail for all deletions (who deleted, what was deleted, when, from which endpoint)

This is a legal/compliance issue: the platform cannot demonstrate that it respects data minimization principles or right-to-deletion, which FERPA and COPPA (US), GDPR (EU), and state education laws may require.

## Goal

Create a data retention and deletion framework that:

1. Defines a written retention policy for each data type (photos: 1 year after athlete leaves; videos: until athlete reaches 18; behavior records: 2 years; contact info: until account deleted)
2. Implements cascade-delete logic so that deleting a guardian/athlete account also deletes linked photos, videos, and behavior records
3. Provides admin UI for guardians/parents to request their own data deletion
4. Provides admin UI for organization admins to delete an athlete or parent account and all associated data
5. Logs all deletions to the audit trail (including what was deleted, when, by whom, and why)
6. Implements a compliance check command that verifies no data older than policy retention window still exists (for audits)

## In scope

- Write a data retention policy document and commit it to `docs/DATA_RETENTION.md`
- Modify athlete, portrait, video, and guardian tables to add `deleted_at` or hard-delete via CASCADE
- Create admin endpoints under `apps/web/app/api/pilot/admin/data-deletion/` for account/athlete deletion
- Create an admin UI page under `apps/web/app/admin/data-deletion/` where admins can initiate deletions
- Audit event logging for all deletions (type: DATA_DELETED, includes what was deleted)
- A cleanup script under `apps/web/scripts/` that runs periodically to hard-delete data past retention window
- Tests covering cascade deletion, audit logging, role gating (only org-admin can delete)

## Out of scope

- GDPR/COPPA legal advice (assume policy is already approved by legal/compliance)
- Data anonymization (clean deletion is sufficient)
- GDPR right-to-be-forgotten portal (admins trigger deletion manually, not self-serve)

## Acceptance criteria

- `npm test` passes; all new tests pass
- `npm run typecheck` passes
- Data retention policy document exists in `docs/DATA_RETENTION.md`
- Organization admin can delete a parent/guardian account via `/admin/data-deletion`
- All linked athlete records are cascade-deleted when a parent is deleted
- All athlete photos, videos, and behavior records are deleted when an athlete is deleted
- All deletions are logged to audit trail with full details
- A script exists that can clean up data past retention window (verify with manual test against test database)
- Non-admin roles cannot access the deletion UI

## Delivery

Lane A: branch `ticket/T-007-safeguarding-data-retention-deletion` off current `origin/main`, run `npm ci && npm run typecheck && npm run lint && npm test`, push ONCE, open a draft PR.

Lane B: output every file COMPLETE (no elisions), each preceded by its full repo path, plus a MANIFEST.md.
