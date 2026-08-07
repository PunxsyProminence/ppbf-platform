# T-008 — Safeguarding audit: guardian consent tracking for minors' photos and videos

> Status: **RESOLVED — see delivery note below (2026-08-07)**
> Lane: A (git-capable AI) or B (chat-capable AI)
> Priority: P1 safeguarding (photos/videos require guardian consent)

## Delivery note (2026-08-07, session B / remote)

Built on PR #238 as PR-238i (see `docs/current/WORK_QUEUE.md`). This
ticket's own "propose model first if schema is large" instruction was
followed, but the proposal is a correction rather than the suggested
new table: `pilot.waivers` already recorded this exact fact —
`waiver_type='photo_media'` is a first-class value in
`admin/consent/page.tsx`'s vocabulary (built earlier in this session,
predating this ticket), and its append-only shape (a new row supersedes
the last one; status admits `signed`/`declined`/`withdrawn`) already IS
"revocable and auditable." A second, parallel `guardian_media_consent`
table for the same real-world fact would give a safeguarding auditor
two places to check instead of one, so this migration extends
`pilot.waivers` with `parent_id` (ties a row to the specific guardian
who signed it), `covers_video`, and `public_use_allowed` instead of
duplicating it. Full reasoning in the migration's own header.

Delivered: a guardian-facing console (`/parent/consent`) to grant or
withdraw consent for each linked child, scoped so a guardian can only
ever act on their own children; an org-admin read-only audit
(`/admin/athlete-consent`) showing every athlete's consent status
org-wide, including athletes with zero guardians on file (surfaced as
its own finding — consent is unverifiable, not vacuously satisfied); the
video-compliance console (T-006) now refuses to approve a publication
whose athlete's guardian consent is missing or withdrawn; and a
read-only reporting script
(`pilot-check-videos-missing-consent.mjs`) for a standing compliance
sweep, matching this repo's existing `pilot-check-stranded-guardians.mjs`
shape.

Two deliberate cuts, stated explicitly rather than silently dropped —
both satisfy this ticket's literal acceptance criteria (which only ask
the compliance-check endpoint to refuse approval on missing/withdrawn
consent, a forward-looking gate) while leaving a documented follow-up:

1. **Consent scope is recorded but not yet enforced.** A guardian can
   mark "photos only, no video" or "internal use only," and that is
   stored — but the video-compliance gate today only checks that
   consent exists and is signed, not that its scope actually covers the
   publication being approved (video vs. photo, public vs.
   internal). Enforcing that requires matching against
   `pilot.video_publications.visibility`/`publication_type`, deferred
   as a follow-up.
2. **Withdrawing consent never retroactively un-publishes.** The gate
   blocks future approvals only. `pilot.video_publications.status` has
   no `unpublished`/`retracted` value to move an already-published
   video to — adding one is its own schema decision, not something this
   migration makes.

### Round-8 self-review fix (2026-08-07, commit `4cd01d1`)

Self-applied adversarial review found 10 raw findings, 8 confirmed; all
fixed. The critical one: `resolveActingParent` resolved the caller's
*first* `pilot.parents` row with no athlete scoping — `pilot.parents`
has no uniqueness constraint on `account_id`, so one signed-in account
can legitimately back a different `parent_id` per child (one intake
form per athlete is a real, schema-permitted shape). A guardian of two
children could have a grant/withdraw for child B silently write under
child A's `parent_id`, passing the route's own authorization check
(athlete-membership only) while never touching the row
`checkGuardianMediaConsent(B)` reads. Fixed by requiring the caller
name the athlete and joining through `guardian_links`; the join itself
was moved into `guardianAccess.ts` as `guardianParentIdForAthlete`, per
that module's own "one definition of viewer-scoped guardian reach"
doctrine, rather than hand-rolled a second time in `guardianConsent.ts`.
The read-side "you" flag on `/parent/consent` now uses a full
membership set (`callerParentIdSet`) instead of picking one row.

Also fixed: a TOCTOU race where a guardian's withdrawal could commit in
the gap between the pre-approval consent check and the CAS-guarded
approval transaction (closed with an in-transaction re-check,
`assertGuardianMediaConsentWithClient`, via a new `verifyBeforeCommit`
hook on `decidePublicationCompliance`); a blocked-approval attempt
going completely unaudited, despite this ticket's own acceptance
criteria calling for exactly that ("who approved despite missing
consent"); and three test-quality gaps (`guardianParentIds`/
`guardianParentIdForAthlete` had no direct unit coverage; the
real-Postgres suite never proved organization isolation, despite
`pilot.athletes`' primary key being per-org, not global; and the grant
route's default-value derivation was never exercised by a request that
actually omitted `covers_video`/`public_use_allowed`).

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
