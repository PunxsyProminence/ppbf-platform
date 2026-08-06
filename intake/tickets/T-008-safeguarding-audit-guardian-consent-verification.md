# T-008 — Safeguarding audit: guardian consent tracking for minors' photos and videos

> Status: BACKLOG
> Lane: A (git-capable AI) or B (chat-capable AI)
> Priority: P1 safeguarding (photos/videos require guardian consent)

<!-- Everything below this line is the prompt. Paste the whole file into the
     builder AI. It must be able to succeed with no other context. -->

## Context you need

You are building one feature for the PPBF platform: a Next.js 16 (App Router) + PostgreSQL app for a nonprofit youth boxing gym, deployed on Azure Container Apps. TypeScript strict, Tailwind v4, tests in Jest (`*.test.ts(x)` colocated), server logic under `apps/web/src/server/pilot/`, API routes under `apps/web/app/api/pilot/`, pages under `apps/web/app/`.

Non-negotiable conventions:

- Every read/write of organization-owned data is scoped by `organization_id` in the SQL itself.
- Auth: `requireSession` / role checks from `apps/web/src/server/pilot/auth.ts` at the top of every route handler.
- Full rules: `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in the repo. Read it.
- **Safeguarding rule (critical)**: Before publishing or distributing any photograph or video of a minor, you must have documented guardian consent. That consent must be:
  1. Tracked in the database (which guardian, when, for which athlete)
  2. Revocable (guardian can withdraw consent)
  3. Auditable (who has consent, when it was granted, who checked it)

## The problem

The safeguarding audit found that the platform allows coaches to upload photographs and videos of athletes without tracking whether the athlete's guardian has consented. The system does not:

- Track guardian consent for each athlete photo or video
- Verify consent before publishing a photo or video
- Allow guardians to revoke consent
- Provide an audit trail of consent decisions

**Current state:**
- Coaches can upload athlete photos and videos
- The compliance-check UI approves or rejects them (T-006)
- But there's no record of whether the athlete's guardian(s) have consented to the photo/video being shared
- A photo/video could be published and shared without consent, violating safeguarding policy

**The gap**: Between upload and compliance check, there should be a consent verification step. Before a video goes to "pending_compliance_review", the system should verify that the relevant guardians have granted consent for that athlete's image to be used.

## Goal

Implement a guardian consent tracking system that:

1. Requires guardians to opt-in to allowing their child's photos/videos to be used in gym publications
2. Tracks consent at the athlete level (each minor can have multiple guardians; all must consent)
3. Stores consent records with:
   - Which guardian(s) have consented
   - Date/time of consent
   - Any conditions (e.g., "photos only, no videos" or "coach communications only, not public")
4. Provides a UI for guardians to:
   - View current consent status for each of their children
   - Grant or withdraw consent
   - See which photos/videos their child's image appears in
5. Provides admin UI to:
   - View consent status for each athlete across the organization
   - Block publication of photos/videos if consent is missing or withdrawn
   - Audit log of all consent changes
6. Modifies the compliance-check flow to verify consent before approving

## In scope

- Database tables/schema for `guardian_media_consent` tracking consent per guardian per athlete
- Scope conditions (photo-only, video-only, internal-only, public, etc.) — suggest sensible defaults
- Guardian-facing UI under `apps/web/app/dashboard/` or similar (a section where parents view/manage consent)
- Admin UI under `apps/web/app/admin/athlete-consent/` to audit and manage organization-level consent
- API endpoints for guardians to grant/revoke consent
- Modification to the compliance-check endpoint (T-006) to verify consent before approving
- Tests covering consent checks, revocation, audit logging
- A script to report which videos are missing consent (for compliance audits)

## Out of scope

- Detailed consent form UI (assume a simple "do you consent?" checkbox for MVP)
- Consent templates (organizations can customize in a follow-up ticket)
- Multi-language consent forms (English only for MVP)

## Acceptance criteria

- `npm test` passes; all new tests pass
- `npm run typecheck` passes
- A guardian can view their consent status for each child
- A guardian can grant consent to allow photos/videos
- A guardian can revoke consent
- Consent changes are logged to audit trail
- Admin can view which athletes have/lack consent across the organization
- The compliance-check endpoint (from T-006) refuses to approve a video if consent is missing
- A script exists that reports videos with missing consent
- All consent checks are logged (who approved despite missing consent, etc.)

## Delivery

Lane A: branch `ticket/T-008-guardian-consent-tracking` off current `origin/main`, run `npm ci && npm run typecheck && npm run lint && npm test`, push ONCE, open a draft PR.

Lane B: output every file COMPLETE (no elisions), each preceded by its full repo path, plus a MANIFEST.md.
